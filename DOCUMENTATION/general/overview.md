# Overview

NiHao Launcher is a desktop game launcher: a Tauri app (Rust backend, React UI). Each game is a
**game module** (a dynamic library loaded at start). The look is a **theme** (a script).
Accounts, friends and online modpacks come from the NiHao **server**, which is a separate project
(its API is in `server/`).

## Repository map

| Path | What it is |
|---|---|
| `src/` | The launcher's own UI (React + Vite, root `package.json`). |
| `src-tauri/` | The launcher backend (Rust): loads modules (`src/plugins/`), themes, language files, local settings (`local.data`), the server client (`server_api.rs`), self-update (`updater.rs`), `nihao://` links (`deeplink.rs`), OS-specific code (`src/platforms/`). |
| `lang/` | The launcher's translations (`<id>.json`); copied next to the exe by every build of `src-tauri` (`build.rs`). |
| `src-shared/` | TypeScript shared by the launcher UI, module UIs and themes: React components, `call_module`, theme types. |
| `plugin-sources/common/` | Crate `launcher-common`: the contract between the launcher and every module. |
| `plugin-sources/games/<id>/` | One game module: a Rust crate (`cdylib`), its own UI project in `ui/`, translations in `lang/`. |
| `themes-sdk/` | Theme build tooling, the `console` reference theme, the hand-written `examples/ocean`. |
| `srcipts/` | Build scripts (the folder name is spelled like this), signing (`sign.mjs`, `release-sign.mjs`). |
| `Installer/` | The installer, also the uninstaller (its own Cargo workspace). See its README. |
| `keys/` | `update.pub`: the public key that release zips are checked against. |
| `shared/` | Rust source included by both the launcher and the installer (`release_sig.rs`). |
| `public/` | Static files of the launcher UI. `POLICY.md` is shown inside the app. |
| `design/` | Static HTML design drafts. Not used by the build. |
| `DOCUMENTATION/` | These docs. |

## How the parts talk

- The UI calls the Rust backend with Tauri `invoke`.
- To use a game module the UI calls `call_module(module, method, args)` (`src-shared/modules.tsx`).
  The backend passes `{ "method", "args" }` as JSON to the module and gets back
  `{ "ok": true, "data": ... }` or `{ "ok": false, "error": "..." }`. Details in
  [../game-modules/README.md](../game-modules/README.md).
- A module brings its own UI as one JavaScript bundle, which the launcher asks the module for.
- Online features go through the backend only (`server_api.rs`), never straight from the webview.
  The server address is baked into the build (`DEFAULT_SERVER_API`). In a debug build `SERVER_API`
  in `.env` overrides it; a release build ignores `.env`.

## Files next to the executable

| Path | What |
|---|---|
| `plugins/<id>.dll` (`.so`, `.dylib`) | Game modules. Every file in this folder is loaded at start. |
| `themes/<id>/` | Installed themes (see [../themes/README.md](../themes/README.md)). |
| `lang/<id>.json` | Launcher translations. Every `.json` here appears in the language list; the file must have a `"language"` key with the display name. |
| `lang/<module>/<id>.json` | A module's translations, read by the module itself. |
| `local.data` | Launcher settings and the saved sign-in. |
| `.cache/` | Used while the launcher updates itself. |
| `uninstall.exe`, `uninstall-plan.json` | The uninstaller (a copy of the installer) and, briefly, the choice the launcher's uninstall page hands it. |

Per game, in the game's own folder: `game.nihao` (the module's settings) and, for Minecraft,
`instances/<name>/profile.nihao` (one per instance).

## Platforms

Windows is the tested platform. Linux and macOS code paths exist under `platforms/` (launcher
and Minecraft module) but are not tested yet.
