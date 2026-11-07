# NiHao Installer

Tiny cross-platform installer (Windows, Linux, macOS; ~7 MB on Windows). One window: it looks up the latest
release and shows what changed in it, you pick a folder (`Browse…` or type it), optionally tick the desktop
shortcut, press **Install**. It downloads the release, unpacks it there and sets it up as an installed program.
The finished screen shows the notes of the version that was installed.

Release lookup is the same as the launcher's self-update (`src-tauri/src/updater.rs`): the latest release
of `BogdanCater/nihao-launcher` on GitHub **and** GitLab is asked, the newer one is downloaded, and the
other host is the fallback if a lookup, download or archive fails. The text shown as "What's new" is the
release description written on the host (GitHub `body`, GitLab `description`); only headings, bullets and
bold/code marks are formatted, the rest is shown as written.
Images in the description are shown too: markdown `![alt](https://…)` and `<img src="https://…">` (what GitHub's
drag-and-drop upload writes); on GitLab also its `/uploads/…` paths. PNG, JPEG and animated GIF, up to 8 MB each
and 10 per release, scaled down to the window and downloaded in the background; only `https` addresses are
fetched. WebP, SVG and video are not drawn: an image that cannot be shown appears as its alt text, a video link
stays plain text. If no host can be reached the window says so and offers **Retry**; **Install** stays disabled
until a release is found.

## Offline: a launcher zip next to the installer

If the folder the installer runs from holds a launcher zip for this OS **and its `<zip name>.sig`**, that
archive is installed instead of the latest release: no lookup, no download, shown as `from this folder`.
Otherwise (no such zip) it goes online as above. The zip is a release asset (see below), but its file name
must also carry the version, e.g. `nihao-launcher-windows-x64-0.2.0.zip` + `nihao-launcher-windows-x64-0.2.0.zip.sig`,
because the signature covers the version and a zip does not say it. The signature is checked like a
downloaded one, so a zip without a `.sig`, or one that does not match, is never installed (the first is
ignored, the second is an error; there is no fallback to the web). The release notes are not available
offline.

## What "installed" means

| | Windows | Linux | macOS |
|---|---|---|---|
| Start menu / applications menu entry | yes (`.lnk`) | yes (`.desktop`) | no |
| Desktop shortcut (checkbox) | yes | yes | no |
| Settings > Apps entry (per user, `HKCU`, no admin) | yes | – | – |
| `uninstall` next to the launcher | yes | yes | yes |

The install folder must be new, empty, or an earlier install of this installer: uninstalling empties the
folder (the launcher, its `local.data`, and anything else in it that you do not choose to keep), so a
folder with someone else's files is refused.
`Browse…` puts the launcher into a `NiHao Launcher` subfolder of the folder you pick.

The default folder is `%ProgramFiles%\NiHao Launcher` on Windows (the user's local data folder on
Linux/macOS). Where the user may not create folders, Windows asks for administrator permission (UAC) once,
before anything is downloaded; the folder is then created with full control for the installing user only,
because the launcher writes its settings and games there and updates itself there. The installer itself
never runs elevated, so shortcuts and the Settings > Apps entry belong to the installing user.

## Uninstall

`uninstall.exe` / `uninstall` in the install folder is a copy of this program. Started under that name it
has no window of its own and works in two steps:

1. Started plainly (Settings > Apps does that), it opens the launcher with `--uninstall`. The launcher
   shows a page where the user picks what to delete: its own settings and themes, and, per module, the
   paths the module lists (for Minecraft: every instance, the downloaded game folders, the profiles).
   Nothing is ticked for a module by default; the launcher's own data is. Cancel closes the launcher and
   nothing happens. If a launcher is already running, that one shows the page.
2. On confirm the launcher writes `uninstall-plan.json` next to the uninstaller, starts `uninstall.exe --apply`
   and exits. On Windows `--apply` asks for administrator permission (UAC) and runs again elevated; if it is
   declined nothing is deleted. The uninstaller waits until the launcher's exe is free, deletes what the plan names (wherever
   it is), empties the install folder except what was kept, removes the shortcuts, the Apps entry and the
   `nihaolauncher://` handler, then itself. If something was kept inside the install folder, that folder
   and its `.nihao-installed` marker stay (installing there again is allowed); otherwise the folder goes.

A delete that fails (a file still held by the game or by the launcher's web view) is retried for a few
seconds; if it still fails a window lists the first failure, and the choice is lost with the plan file, so
close what holds the file and uninstall again.

The plan only holds paths the launcher and its modules named, and the uninstaller ignores any path that is
not deep enough (a drive root, a top folder), is the user's home or contains it, contains the install folder,
or contains something to keep. If the launcher is gone or cannot start, the uninstaller asks once whether to
delete everything in the folder instead. It refuses to touch a folder without the `.nihao-installed` marker
the installer writes (the marker holds the launcher's file name).

## Release assets

Attach one `.zip` per OS and put the OS in its name: `windows`, `linux` or `macos` (also `win`, `mac`, `osx`,
`darwin`), e.g. `nihao-launcher-windows-x64.zip`. A `.zip` that names no OS is used on every OS.
Zip layout is the launcher's: the files at the zip root (no wrapper folder). The first executable in the
zip root is what the shortcuts and the **Launch** button start. Build the Linux/macOS zips on that OS so the
executable bit is kept in the zip.

Every zip needs its signature as another asset named `<zip name>.sig` (made by
`node srcipts/release-sign.mjs sign <zip>`). The installer checks it against the key built into it
(`keys/update.pub`) before unpacking anything, and treats an unsigned or mismatching zip as a bad
download: it falls back to the other host, or fails. See [../DOCUMENTATION/general/signing.md](../DOCUMENTATION/general/signing.md).

## Icon

`assets/icon.png` (window and in-app logo, 128 px) and `assets/icon.ico` (the installer's own `.exe`, embedded by
`build.rs` on Windows; the shortcuts and the Apps entry show the launcher's icon instead) are copies of the
launcher's `src-tauri/icons`. Replace both to change it.

## Build

Needs Rust 1.92+. `npm run build:all` builds it too and signs it on Windows when a certificate is set up
(signing.md). Build on each target OS (no cross-compiling set up):

```
cargo build --release     # -> target/release/nihao-installer(.exe)
cargo test
```

The crate is its own workspace (own `Cargo.lock` and `target/`) so that its size-oriented release profile
applies. On Linux it needs no webview/GTK, only the X11 or Wayland and OpenGL libraries a desktop already
has; `Browse…` uses the desktop's file chooser portal and does nothing if there is none (type the path instead).
