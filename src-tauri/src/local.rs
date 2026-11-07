use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::fs;

use crate::get_program_path;

#[derive(Serialize, Deserialize, Clone)]
pub struct NHDataClient {
    pub(crate) client: Option<String>,
    /// Nickname from first-run onboarding: the account-wide default for a module's first local
    /// profile (bridged as `LauncherBridge.defaultNickname`). `#[serde(default)]`: older
    /// `local.data` has no such key.
    #[serde(default)]
    pub(crate) nickname: Option<String>,
    pub(crate) interface: NHDataClientInterface,
    pub(crate) features: Option<bool>,
    #[serde(default)]
    pub(crate) games: NHGamePaths,
}
lazy_static::lazy_static! {
    /// Serializes every read-modify-write of `local.data` (frontend saves, refresh-token
    /// rotations) so they can't clobber each other.
    static ref FILE_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::new(());
}

/// What the frontend sees of the profile: everything except the refresh token (a credential, kept
/// in `client`). `linked` only says whether an account is attached.
#[derive(Serialize, Clone)]
pub struct LocalClientView {
    pub linked: bool,
    pub nickname: Option<String>,
    pub interface: NHDataClientInterface,
    pub features: Option<bool>,
    pub games: NHGamePaths,
}

impl From<&NHDataClient> for LocalClientView {
    fn from(d: &NHDataClient) -> Self {
        LocalClientView {
            linked: d.client.is_some(),
            nickname: d.nickname.clone(),
            interface: d.interface.clone(),
            features: d.features,
            games: d.games.clone(),
        }
    }
}

/// What the frontend may send back when saving settings: the same fields minus the token (any
/// `linked`/`client` it sends along is ignored — the token is kept from the existing file).
#[derive(Deserialize)]
pub struct LocalClientInput {
    #[serde(default)]
    pub nickname: Option<String>,
    pub interface: NHDataClientInterface,
    #[serde(default)]
    pub features: Option<bool>,
    #[serde(default)]
    pub games: NHGamePaths,
}

/// `init_local_data`: the profile as the frontend may see it.
pub async fn load_view() -> Result<LocalClientView, String> {
    let _guard = FILE_LOCK.lock().await;
    let data = NHDataClient::import().await?;
    push_game_paths(&data);
    Ok(LocalClientView::from(&data))
}

/// `save_local_data`: writes the frontend's settings, keeping the stored refresh token (or, for
/// the very first save during onboarding, taking whatever the backend's login just obtained).
pub async fn save_from_frontend(input: LocalClientInput) -> Result<LocalClientView, String> {
    let _guard = FILE_LOCK.lock().await;
    let client = match NHDataClient::import().await {
        Ok(existing) => existing.client,
        Err(_) => crate::server_api::remembered_refresh_token(),
    };
    let mut interface = input.interface;
    keep_only_matching_approvals(&mut interface.trusted_themes, crate::themes::current_hash);
    let data = NHDataClient {
        client,
        nickname: input.nickname,
        interface,
        features: input.features,
        games: input.games,
    };
    data.save().await?;
    push_game_paths(&data);
    Ok(LocalClientView::from(&data))
}

/// A theme approval is only valid for the bundle that is on disk now: the webview (which also runs
/// themes) cannot pre-approve a hash for code that is not there yet.
fn keep_only_matching_approvals(
    trusted: &mut std::collections::HashMap<String, String>,
    current_hash: impl Fn(&str) -> Option<String>,
) {
    trusted.retain(|id, hash| current_hash(id).as_deref() == Some(hash.as_str()));
}

/// Persists a rotated (or cleared, on logout) refresh token into an existing `local.data`. A
/// no-op while no profile exists yet — onboarding's first save picks the token up from memory.
pub async fn store_refresh_token(token: Option<String>) {
    let _guard = FILE_LOCK.lock().await;
    if let Ok(mut data) = NHDataClient::import().await {
        data.client = token;
        if let Err(e) = data.save().await {
            eprintln!("Failed to persist refresh token: {e}");
        }
    }
}

/// The refresh token currently on disk, if any.
pub async fn stored_refresh_token() -> Option<String> {
    let _guard = FILE_LOCK.lock().await;
    NHDataClient::import().await.ok().and_then(|d| d.client)
}

impl NHDataClient {
    pub async fn is_alive() -> Result<bool, String> {
        Ok(get_program_path()?.join("local.data").exists())
    }
    pub async fn import() -> Result<NHDataClient,String> {
        let profile_path = get_program_path()?.join("local.data");
        if !profile_path.exists() {
            return Err("Not local profile!".to_string());
        };
        
        let profile_file = fs::read_to_string(profile_path).await
            .map_err(|e|e.to_string())?;
        let result: NHDataClient = serde_json::from_str(&profile_file)
            .map_err(|e|e.to_string())?;
        Ok(result)
    }
    pub async fn save(&self) -> Result<(), String> {
        let content = serde_json::to_string(self)
            .map_err(|e|e.to_string())?;
        
        launcher_common::write_atomic(&get_program_path()?.join("local.data"), content.as_bytes())
    }
}

/// Tells every game module its install folder (`set_game_path`) from the backend's copy of
/// `local.data`, whenever it is loaded or saved.
pub fn push_game_paths(data: &NHDataClient) {
    let mut cache = GAME_PATHS.lock().unwrap();
    *cache = data.games.iter().map(|(id, s)| (id.clone(), s.path.clone())).collect();
    for (game_id, path) in cache.iter() {
        crate::notify_plugin(game_id, "set_game_path", serde_json::json!({ "path": path }));
    }
}

lazy_static::lazy_static! {
    /// Last pushed paths, so a plugin that loads later (dev hot-reload, a DLL dropped in
    /// mid-session) can be brought up to date by `push_context`.
    static ref GAME_PATHS: std::sync::Mutex<std::collections::HashMap<String, Option<String>>> =
        std::sync::Mutex::new(std::collections::HashMap::new());
}

/// Hands a freshly loaded plugin everything the backend already knows for it (its game path).
pub fn push_context(game_id: &str) {
    let path = GAME_PATHS.lock().unwrap().get(game_id).cloned().flatten();
    crate::notify_plugin(game_id, "set_game_path", serde_json::json!({ "path": path }));
}

#[derive(Serialize, Deserialize, Clone)]
pub struct NHDataClientInterface {
    pub(crate) language: String,
    pub(crate) hide_in_game_running: bool,
    /// Keep the Discord Rich Presence connection alive (see `discord_presence.rs`); synced from the
    /// TS side on every `local.data` load/change. `#[serde(default)]` for older files.
    #[serde(default)]
    pub(crate) discord_presence_enabled: bool,
    /// Master switch for every interface animation (`useAnimationsEnabled` on the TS side). On by
    /// default, also for older files.
    #[serde(default = "default_true")]
    pub(crate) animations_enabled: bool,
    /// Id of the active theme (`themes/<id>/` next to the exe); `None` = the built-in "console".
    #[serde(default)]
    pub(crate) theme: Option<String>,
    /// Theme id -> SHA-256 of the bundle the user agreed to run. A theme is code: it only runs
    /// while its file still hashes to what was approved, so replacing `theme.js` on disk asks again.
    #[serde(default)]
    pub(crate) trusted_themes: std::collections::HashMap<String, String>,
    /// Theme id -> that theme's own settings (key -> value), as the user last saved them. The
    /// theme declares which settings exist; the launcher only stores the values.
    #[serde(default)]
    pub(crate) theme_settings: std::collections::HashMap<String, serde_json::Value>,
}

fn default_true() -> bool {
    true
}

/// Only the install path lives here; the module's own settings live in `game.nihao` inside the
/// install folder (`load_game_settings`/`save_game_settings`), so its config travels with the
/// install.
#[derive(Serialize, Deserialize, Clone, Default)]
pub struct GameLocalSettings {
    pub path: Option<String>,
}

pub type NHGamePaths = std::collections::HashMap<String, GameLocalSettings>;

use launcher_common::{read_game_settings, GAME_SETTINGS_FILE_NAME};

/// Reads a module's own settings from `{path}/game.nihao`: empty if the file is not there, an error
/// if it is there but damaged.
pub async fn load_game_settings(path: &str) -> Result<Value, String> {
    read_game_settings(&std::path::Path::new(path).join(GAME_SETTINGS_FILE_NAME)).map(Value::Object)
}

/// Merges `settings` into `{path}/game.nihao` instead of replacing the file: the module keeps its own
/// keys there (e.g. Minecraft's player profiles), which a settings page that loaded the file earlier
/// must not roll back. A file that is there but cannot be read is an error and is left alone: writing
/// only the new keys over it would lose the module's.
pub async fn save_game_settings(path: &str, settings: &Value) -> Result<(), String> {
    let Value::Object(new) = settings else {
        return Err("Game settings must be a JSON object".to_string());
    };
    fs::create_dir_all(path)
        .await
        .map_err(|e| format!("Cannot create game folder: {}", e))?;

    let file = std::path::Path::new(path).join(GAME_SETTINGS_FILE_NAME);
    let mut merged = read_game_settings(&file)?;
    merged.extend(new.clone());
    let content = serde_json::to_string_pretty(&merged).map_err(|e| e.to_string())?;
    launcher_common::write_atomic(&file, content.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_the_profile_the_frontend_sends() {
        let json = serde_json::json!({
            "linked": true,
            "nickname": "Bob",
            "interface": {
                "language": "en_us",
                "hide_in_game_running": true,
                "discord_presence_enabled": false,
                "animations_enabled": true,
                "theme": "console",
                "trusted_themes": { "console": "abc123" },
                "theme_settings": {
                    "console": { "accent": "green", "blinkingCursor": false, "size": 3 },
                    "simple": { "accent": "#ff0000", "quickPanel": "left" }
                }
            },
            "games": { "minecraft": { "path": "D:/Games" } }
        });
        let input: LocalClientInput = serde_json::from_value(json).expect("frontend profile must deserialize");
        assert_eq!(input.interface.theme.as_deref(), Some("console"));
        assert_eq!(input.interface.trusted_themes.get("console").map(String::as_str), Some("abc123"));
        assert_eq!(input.interface.theme_settings["simple"]["quickPanel"], "left");
        assert_eq!(input.interface.theme_settings["console"]["blinkingCursor"], false);
    }

    #[test]
    fn approvals_must_match_the_bundle_on_disk() {
        let mut trusted = std::collections::HashMap::from([
            ("good".to_string(), "h1".to_string()),
            ("changed".to_string(), "old".to_string()),
            ("missing".to_string(), "h3".to_string()),
        ]);
        keep_only_matching_approvals(&mut trusted, |id| match id {
            "good" => Some("h1".into()),
            "changed" => Some("new".into()),
            _ => None,
        });
        assert_eq!(trusted.keys().collect::<Vec<_>>(), ["good"]);
    }

    #[tokio::test]
    async fn saving_game_settings_keeps_the_modules_own_keys() {
        let dir = std::env::temp_dir().join(format!("nihao-game-settings-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.to_str().unwrap();
        std::fs::write(dir.join(GAME_SETTINGS_FILE_NAME), r#"{"ram":1,"profiles":[{"id":"a"}]}"#).unwrap();

        save_game_settings(path, &serde_json::json!({ "ram": 4 })).await.unwrap();

        let saved = load_game_settings(path).await.unwrap();
        assert_eq!(saved["ram"], 4);
        assert_eq!(saved["profiles"][0]["id"], "a");
        assert!(save_game_settings(path, &serde_json::json!([1])).await.is_err());

        // A file that cannot be read as settings is not replaced by the new keys alone.
        std::fs::write(dir.join(GAME_SETTINGS_FILE_NAME), "{ damaged").unwrap();
        assert!(save_game_settings(path, &serde_json::json!({ "ram": 8 })).await.is_err());
        assert_eq!(std::fs::read_to_string(dir.join(GAME_SETTINGS_FILE_NAME)).unwrap(), "{ damaged");
        assert!(load_game_settings(path).await.is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn saving_the_built_in_theme_sends_a_null_theme() {
        let json = serde_json::json!({
            "interface": { "language": "en_us", "hide_in_game_running": true, "discord_presence_enabled": false,
                           "animations_enabled": true, "theme": null, "trusted_themes": {}, "theme_settings": {} }
        });
        let input: LocalClientInput = serde_json::from_value(json).unwrap();
        assert!(input.interface.theme.is_none());
    }

    #[test]
    fn an_old_profile_without_theme_fields_still_loads() {
        let json = serde_json::json!({
            "client": null,
            "interface": { "language": "en_us", "hide_in_game_running": true }
        });
        let data: NHDataClient = serde_json::from_value(json).unwrap();
        assert!(data.interface.theme.is_none());
        assert!(data.interface.animations_enabled);
        assert!(data.interface.theme_settings.is_empty());
    }
}
