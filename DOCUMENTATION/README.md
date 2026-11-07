# NiHao Launcher documentation

| Folder | Read it to |
|---|---|
| [general/](general/) | understand the project, build it, run it, release it |
| [game-modules/](game-modules/) | write or change a game module (plug-in) |
| [themes/](themes/) | write a theme |
| `server/` | call the launcher server's API (`server/API.md`) |

`server/` is listed in `.gitignore` (the API doc was ignored before it moved here), so it exists
only on machines that have it. To publish it, delete the `DOCUMENTATION/server/` line in `.gitignore`.

Source comments say "see API.md" and "see MODPACK_FORMAT.md" by file name only. They are
`server/API.md` and `game-modules/minecraft/MODPACK_FORMAT.md`.
