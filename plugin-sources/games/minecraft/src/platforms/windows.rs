use std::path::Path;
use std::process::Command;

/// Java used to launch the game (`javaw` = no console window) and to run installer tools (`java`).
pub const GAME_JAVA: &str = "bin/javaw.exe";
pub const TOOL_JAVA: &str = "bin/java.exe";
pub const CLASSPATH_SEPARATOR: &str = ";";
/// Key of Mojang's native-library classifier in a version manifest.
pub const NATIVES_CLASSIFIER: &str = "natives-windows";

/// `game/minecraft` next to the launcher's exe.
pub fn default_game_path() -> String {
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|p| p.join("game").join("minecraft")))
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|| "game/minecraft".to_string())
}

pub fn open_folder(dir: &Path) -> Result<(), String> {
    Command::new("explorer").arg(dir).spawn().map(|_| ()).map_err(|e| format!("Cannot open folder: {e}"))
}
