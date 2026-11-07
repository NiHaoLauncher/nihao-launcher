# Build, run, release

You need Node.js with npm, Rust, and the Tauri CLI (`cargo tauri`). Commands run from the repo root.

## Install

```
npm install
npm install --prefix plugin-sources/games/minecraft/ui
```

Each game module has its own `ui/` project with its own `package.json`.

## Run for development

```
npm run dev:full      # cargo build --workspace && cargo tauri dev
```

Put local settings in `.env` (git-ignored; read by debug builds only):

| Key | Meaning |
|---|---|
| `DEV_MODULE` | Id of the module you are working on, e.g. `minecraft`. |
| `DEV_UI_PORT` | Port of that module's UI dev server. |
| `SERVER_API` | Launcher server address, instead of the one baked into the build. |
| `MINECRAFT_SERVER_API` | The Minecraft module's server address, instead of the one built into the module. |

With `DEV_MODULE` set, the launcher loads that module, starts its UI dev server (`npm run dev` in
the module's `ui/`), watches its source, and rebuilds and reloads it when a file changes.

Themes are not part of that loop: `npm run install:themes` builds them and copies them to
`target/debug/themes/`.

## Test

```
cargo test --workspace                          # launcher, launcher-common, Minecraft module
cargo test --manifest-path Installer/Cargo.toml  # installer (its own workspace)
npx tsc --noEmit                                 # launcher UI
npx tsc --noEmit -p plugin-sources/games/minecraft/ui
node --test src/duplicates.test.ts               # from plugin-sources/games/minecraft/ui
node srcipts/check-version.mjs                   # the version is the same in the three files
```

The Rust tests need the built UIs first (`npm run build`, and `npm run build` in the module's `ui/`):
the launcher embeds `dist/` and the module embeds `dist_ui/`. `.github/workflows/ci.yml` runs all of
this on every push. A few tests that need the network or a built module are `#[ignore]`d and say in
their comment how to run them.

## Build a release

```
npm run build:all
```

`srcipts/build-all.mjs` (Node, so it is the same on every OS) also builds the installer (`Installer/`,
its own workspace, into `Installer/target/release/`) and signs the programs on Windows when a certificate
is configured ([signing.md](signing.md)). It builds into `target/release/`:
the launcher UI, every module's UI, the launcher with `tauri/custom-protocol` (it serves the built
UI itself), every other workspace crate, then copies the module libraries to `plugins/` and
installs the themes to `themes/`.

The translations need no step of their own: every build of the launcher (`src-tauri/build.rs`) copies
`lang/*.json` of the repository to `<target>/<profile>/lang/` and each module's `lang/*.json` to
`lang/<module id>/`, next to the executable. So `cargo tauri dev` on a fresh clone has them too. Edit the
files in the repository, not the copies: the next build overwrites them.

`build-plugins.ps1` and `build-plugins.sh` in the same folder are older scripts that only build
the workspace and copy the libraries to `../plugins`.

## Publish a release

`npm run release:pack` (it runs `build:all` first; `-- --no-build` packs the last build as is) puts the files to attach into
`srcipts/release/`: the installer, the launcher zip named with its version, and the zip's `.sig` (it signs, so the
key must be set: see [signing.md](signing.md)). Windows only for now.

The launcher updates itself (`src-tauri/src/updater.rs`). It asks GitHub and GitLab
(`BogdanCater/nihao-launcher` on both) for the latest release, takes the newer one, and uses the
other one if the first fails.

- Publish the **same release on both** hosts.
- The tag is the version, and it must be higher than `version` in `src-tauri/Cargo.toml`
  (`v0.2.0` and `0.2.0` are both fine).
- Attach one `.zip` **and its signature `<zip name>.sig`** (`node srcipts/release-sign.mjs sign <zip>`).
  On GitLab attach both as release asset links (Deploy → Releases); GitLab's own source archive is
  ignored. A release without a matching signature is refused by the launcher and the installer.
- Zip layout: the files of the launcher folder (executable, `plugins/`, `themes/`, `lang/`) at the
  zip root, with no wrapper folder. Each file is copied over the file with the same relative path
  next to the running executable.
- The release text becomes the changelog shown after the update.
- The signature ties the zip to the maintainer's key and to the version, so whoever can edit a release
  page cannot change what users run. Signing the programs themselves for Windows (so they show a
  publisher and are not flagged) is a separate step that `npm run build:all` does when a certificate is
  configured. Both are described in [signing.md](signing.md).
