# NiHao Launcher

A desktop game launcher built with Tauri (Rust) and React. Every game is a plug-in **module**, and the look of the launcher is a **theme**, so both can change without touching the core.

- **Game modules**: a dynamic library plus its own UI bundle, loaded at start. Minecraft is the first one: instances, Fabric / NeoForge, Modrinth and CurseForge browsing, modpack import and export, Ely.by and offline sessions.
- **Themes**: a script that replaces parts of the UI. `themes-sdk/` has the build tooling and a reference theme.
- **Online features**: accounts, friends and online modpacks come from the NiHao server, a separate project.
- **Self-update**: the launcher updates itself from the latest GitHub or GitLab release, with signed archives.
- **Installer**: a small cross-platform installer, which is also the uninstaller (`Installer/`).
- **Languages**: English, Ukrainian, Russian and Czech (`lang/`).

Windows is the tested platform. Linux and macOS code paths exist but are not tested yet.

## Quick start

You need Node.js, Rust and the Tauri CLI (`cargo tauri`).

```
npm install
npm install --prefix plugin-sources/games/minecraft/ui
cp .env.example .env     # set NIHAO_BUILD_KEY (see below)
npm run dev:full
```

`.env` is git-ignored. It holds the client key the server expects (`NIHAO_BUILD_KEY_ID`, `NIHAO_BUILD_KEY`; a dev server accepts the id `dev`) and, for debug builds only, `SERVER_API` and `DEV_MODULE`.

Release build:

```
npm run build:all        # launcher, modules, themes, installer -> target/release/
npm run release:pack     # the files to attach to a release -> srcipts/release/
```

Tests:

```
cargo test --workspace
npx tsc --noEmit
```

The full list, with the module and installer tests, is in [build-and-run.md](DOCUMENTATION/general/build-and-run.md).

## Layout

| Path | What it is |
|---|---|
| `src/` | The launcher UI (React + Vite). |
| `src-tauri/` | The launcher backend (Rust): modules, themes, local settings, server client, self-update. |
| `src-shared/` | TypeScript shared by the launcher, module UIs and themes. |
| `plugin-sources/common/` | The contract between the launcher and every module. |
| `plugin-sources/games/<id>/` | One game module: a Rust crate and its own UI. |
| `themes-sdk/` | Theme tooling and examples. |
| `Installer/` | The installer and uninstaller. |
| `lang/` | Launcher translations. |
| `DOCUMENTATION/` | Developer docs. |

## Documentation

- [Overview](DOCUMENTATION/general/overview.md): how the parts fit together
- [Build, run, release](DOCUMENTATION/general/build-and-run.md)
- [Signing releases](DOCUMENTATION/general/signing.md)
- [Writing a game module](DOCUMENTATION/game-modules/README.md)
- [Writing a theme](DOCUMENTATION/themes/README.md)
- [Installer](Installer/README.md)

## Repositories

- GitHub: <https://github.com/BogdanCater/nihao-launcher>
- GitLab: <https://gitlab.com/BogdanCater/nihao-launcher>
