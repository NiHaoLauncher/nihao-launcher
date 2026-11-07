use std::path::{Path, PathBuf};
use std::process::Command;

pub const GAME_JAVA: &str = "bin/java";
pub const TOOL_JAVA: &str = "bin/java";
pub const CLASSPATH_SEPARATOR: &str = ":";
pub const NATIVES_CLASSIFIER: &str = "natives-linux";

/// `$XDG_DATA_HOME/nihao/minecraft` (default `~/.local/share/nihao/minecraft`) — a Linux install
/// dir is often read-only, so the game data can't live next to the exe like on Windows.
pub fn default_game_path() -> String {
    let base = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share")))
        .unwrap_or_else(|| PathBuf::from("."));
    base.join("nihao").join("minecraft").to_string_lossy().into_owned()
}

pub fn open_folder(dir: &Path) -> Result<(), String> {
    Command::new("xdg-open").arg(dir).spawn().map(|_| ()).map_err(|e| format!("Cannot open folder: {e}"))
}
