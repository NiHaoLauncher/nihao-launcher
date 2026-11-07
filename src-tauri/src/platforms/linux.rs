use std::path::Path;
use std::process::{Child, Command};

pub fn no_window(cmd: &mut Command) -> &mut Command {
    cmd
}

pub fn own_console(cmd: &mut Command) -> &mut Command {
    cmd
}

pub fn npm() -> Command {
    Command::new("npm")
}

pub fn kill_process_tree(child: &mut Child) {
    let _ = child.kill();
}

pub fn open_folder(dir: &Path) -> Result<(), String> {
    Command::new("xdg-open").arg(dir).spawn().map(|_| ()).map_err(|e| e.to_string())
}

// shortcut: no `.desktop`/xdg-mime registration yet, so `nihaolauncher://` links don't open the
// launcher on Linux; add it when Linux becomes a supported target.
pub fn register_protocol(_scheme: &str) {}
