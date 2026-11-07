//! Files the launcher and its modules both write. The launcher and a module are separate programs
//! with the same file, so the rules live here once.

use std::path::Path;

use serde_json::{Map, Value};

/// The settings file in a game's folder: the launcher's generic game settings (RAM, ...) and the
/// module's own keys (Minecraft's player profiles) share it.
pub const GAME_SETTINGS_FILE_NAME: &str = "game.nihao";

/// Write-then-rename: a crash mid-write must not leave a truncated file (a profile that no longer
/// parses makes its instance vanish, a broken `game.nihao` loses the player profiles).
pub fn write_atomic(path: &Path, content: &[u8]) -> Result<(), String> {
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".tmp");
    let tmp = std::path::PathBuf::from(tmp);
    std::fs::write(&tmp, content).map_err(|e| format!("Cannot write '{}': {}", path.display(), e))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("Cannot write '{}': {}", path.display(), e))
}

/// The keys of a game's settings file. A file that is not there is no keys. One that is there but
/// cannot be read or is not a JSON object is an **error**, never "no keys": callers merge their
/// changes into the result and write it back, which would replace the real content (the player
/// profiles, the RAM setting) with a few keys if an antivirus held the file for a moment.
pub fn read_game_settings(file: &Path) -> Result<Map<String, Value>, String> {
    let text = match std::fs::read_to_string(file) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Map::new()),
        Err(e) => return Err(format!("Cannot read '{}': {}", file.display(), e)),
    };
    match serde_json::from_str(&text) {
        Ok(Value::Object(keys)) => Ok(keys),
        Ok(_) => Err(format!("'{}' is not a JSON object, so it was left as it is", file.display())),
        Err(e) => Err(format!("'{}' is damaged ({}), so it was left as it is", file.display(), e)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("nihao-files-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn write_atomic_replaces_the_file_and_leaves_no_temp() {
        let dir = scratch("atomic");
        let file = dir.join("profile.nihao");
        write_atomic(&file, b"one").unwrap();
        write_atomic(&file, b"two").unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "two");
        assert!(!dir.join("profile.nihao.tmp").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_missing_settings_file_is_empty_but_a_damaged_one_is_an_error() {
        let dir = scratch("settings");
        let file = dir.join(GAME_SETTINGS_FILE_NAME);
        assert!(read_game_settings(&file).unwrap().is_empty());

        std::fs::write(&file, r#"{"ram":4096,"profiles":[]}"#).unwrap();
        assert_eq!(read_game_settings(&file).unwrap()["ram"], 4096);

        std::fs::write(&file, "{ half a file").unwrap();
        assert!(read_game_settings(&file).unwrap_err().contains("damaged"));
        std::fs::write(&file, "[1]").unwrap();
        assert!(read_game_settings(&file).unwrap_err().contains("not a JSON object"));
        // Not a file at all (read fails for another reason than "not found").
        std::fs::remove_file(&file).unwrap();
        std::fs::create_dir(&file).unwrap();
        assert!(read_game_settings(&file).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
