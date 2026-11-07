//! Backend-owned context the launcher core pushes into this plugin (`set_game_path`,
//! `notify_session_token` — see `lib.rs`), so the frontend never has to pass the install path or
//! the session credential along with each call (and never has to hold the credential at all).

use std::sync::RwLock;

static GAME_PATH: RwLock<Option<String>> = RwLock::new(None);

pub fn set_game_path(path: Option<String>) {
    // An empty string means "not configured" the same as `None`.
    *GAME_PATH.write().unwrap() = path.filter(|p| !p.trim().is_empty());
}

/// Where the game lives when the user hasn't picked a folder (per OS — see `platforms`).
pub fn default_game_path() -> String {
    crate::platforms::default_game_path()
}

/// The install folder: the one configured in the launcher's settings, else the default — so a
/// fresh install works without the frontend having to pick or pass a path.
pub fn game_path() -> Result<String, String> {
    Ok(GAME_PATH.read().unwrap().clone().unwrap_or_else(default_game_path))
}

/// The current NiHao session token, or an error if not signed in.
pub fn session_token() -> Result<String, String> {
    super::online_modpacks::ensure_secure_server()?;
    super::online_modpacks::current_session_token().ok_or_else(|| "Not signed in".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn game_path_falls_back_to_default_and_honors_setting() {
        set_game_path(None);
        assert_eq!(game_path().unwrap(), default_game_path());
        set_game_path(Some("  ".to_string()));
        assert_eq!(game_path().unwrap(), default_game_path());
        set_game_path(Some("D:/Games/MC".to_string()));
        assert_eq!(game_path().unwrap(), "D:/Games/MC");
        set_game_path(None);
    }
}
