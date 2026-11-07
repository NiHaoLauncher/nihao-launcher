# Game modules

A game module is a Rust dynamic library (`cdylib`) plus a small UI. The launcher loads every file
in `plugins/` next to its executable at start. `minecraft` (`plugin-sources/games/minecraft/`) is
the reference module; its own docs are in [minecraft/](minecraft/).

```
plugin-sources/games/<id>/
  Cargo.toml     [lib] crate-type = ["cdylib"], depends on launcher-common (../../common)
  src/lib.rs     implements GameSupport, ends with launcher_common::export_plugin!(...)
  ui/            the module's UI: its own Vite project, builds to ../dist_ui/index.iife.js
  lang/          translations: <id>.json per language
```

## The Rust side

The contract is `GameSupport` in `plugin-sources/common/src/lib.rs`:

| Method | What it does |
|---|---|
| `game()` | Name, version, authors, `api_version`. `game_info_from_cargo!()` fills them from `Cargo.toml`. |
| `get_ui_bundle()` | The built UI as a string, usually `include_str!("../dist_ui/index.iife.js")`. |
| `call(method, args)` | Every command the UI or the launcher can run. Built with `declare_module_call!`. |
| `get_asset_data(path)` | Raw bytes of an embedded file (e.g. via `rust-embed`). |

`declare_module_call![ get_config(), set_game_path(path: Option<String>), service(interface::service) ]`
turns a call `{ "method": "set_game_path", "args": { "path": "..." } }` into the function call
`set_game_path(path)`. A function returns `Result<T, E>` with `T: Serialize` and `E: Display`;
the launcher gets `{ "ok": true, "data": ... }` or `{ "ok": false, "error": "..." }`.
`service(path)` hands every other method name to a function made by `declare_service!`, so a long
list of commands can live in its own file.

The library's file name is the module id: `plugins/<id>.dll` (`.so`, `.dylib`). An id may contain
only letters, digits, `_` and `-`.

## Methods the launcher calls on a module

| Method | When |
|---|---|
| `get_config()` | Read for each module by the settings and the module list. Returns `name`, `icon`, `banner`, `background`, `defaultPath`, `settingsFields`, and the opt-ins `hasProfileManager` and `hasOnlineService` (see `src/games/GameRegistry.ts`). The `settingsFields` are drawn by the launcher in the game settings and saved in `game.nihao`. |
| `get_lang(id)` | Per language: returns the module's translations, which the launcher merges into its own. A module without it adds none. |
| `set_game_path(path)` | When the user changes the game's folder, and when the module starts. |
| `notify_session_token(token)` | Every time the launcher's session token changes (`null` on sign-out). A module that talks to the server keeps it for its own requests. |
| `uninstall_paths()` | When the user opens the launcher's uninstall page. Return the absolute paths of everything the module keeps that may be deleted: a list of strings. List things apart that the player may want to keep apart (each instance, the downloaded game files, the profiles file). The launcher names each by its path, measures it, lets the user tick it, and has the uninstaller delete the ticked ones. A module without it is skipped, so its data stays. |
| `check_service_status()` | Only with `hasOnlineService`; polled for the status row in Settings → Online Service. Returns `{ "connected": bool }`. |
| `get_home_preview(path)`, `get_install_status()`, `get_user_info()` | Optional; a module that lacks one is skipped. |

The module's own UI can call any other method through `call_module` / `useCallModule()`
(`src-shared/modules.tsx`).

## The UI side

The UI is one script that defines a custom element named `<id>-ui` and nothing else. See
`plugin-sources/games/minecraft/ui/src/index.tsx`:

- The launcher injects the script, then waits for the element. In a dev build the tag name comes
  from the script URL's `?tag=` query (a custom element cannot be defined twice), so read it from
  `import.meta.url`.
- The launcher puts the element on the page and sets its `launcherBridgeStore` property
  (`BridgeStore` in `src-shared/types.ts`). Render nothing until it is set.
- Read the bridge with `useBridge(selector)` from `@shared`, which is `src-shared/`. The bridge
  holds the module id, the game path, the language revision, and so on.
- Put the CSS into the script (`import css from './x.css?inline'`); the launcher loads only the JS.
- The module runs in the launcher's page but with its **own copy of React**. A theme slot that
  uses hooks cannot render inside a module (see [../themes/README.md](../themes/README.md)).
- Translate with `t("key")` / `<T k="key" />` from `@shared`. Both read the launcher's dictionary.

### How the Minecraft UI is laid out

`ui/src/minecraftPages.tsx` only routes (`PagesBrowser`); each page or dialog is in `ui/src/pages/`, one file per job:

| File | What it is |
|---|---|
| `launch.tsx` | the Launch page of one instance |
| `modpacks.tsx` | My modpacks: list, tiles, menu |
| `modpackSettings/` | the instance settings: `ModpackSettingsModal` owns the state, `GeneralTab`, `InstallTab`, `PublishTab` draw it |
| `createModpack.tsx`, `share.tsx` | create an instance; export or publish one |
| `content.tsx`, `browse.tsx`, `projectDetail.tsx`, `markdown.tsx` | the Content manager, browsing a service, a project's page and its Markdown renderer |
| `market.tsx` | the modpack market |
| `profiles.tsx`, `screenshots.tsx`, `imageViewer.tsx` | player profiles, screenshots, image viewing |
| `types.ts`, `helpers.ts`, `hooks.ts`, `components.tsx` | what several of them share |

## Develop one

Set `DEV_MODULE=<id>` and `DEV_UI_PORT` in `.env` and run `npm run dev:full`
(see [../general/build-and-run.md](../general/build-and-run.md)). A release build copies the
library to `plugins/` with `npm run build:all`.
