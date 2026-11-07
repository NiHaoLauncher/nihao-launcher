use std::path::Path;

use serde::{Deserialize, Serialize};
use tokio::fs;

pub use launcher_common::GAME_SETTINGS_FILE_NAME;
use launcher_common::read_game_settings;

fn default_service() -> String {
    "offline".to_string()
}

/// A named login session, what `SessionSelector`/`SessionProfileManagerModal` let the player pick
/// and manage. `id` is stable so a rename never breaks `default_profile_id`.
#[derive(Serialize, Deserialize, Clone)]
pub struct OfflineProfile {
    pub id: String,
    pub name: String,
    /// Login method: `"offline"`, `"elyby"` (signed in, see `library::elyby`) or `"microsoft"`
    /// (reserved; the "Sign in online" button stays disabled until real Microsoft auth exists).
    /// Older profiles load as `"offline"`.
    #[serde(default = "default_service")]
    pub service: String,
}

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct ProfilesData {
    #[serde(default)]
    pub profiles: Vec<OfflineProfile>,
    #[serde(default)]
    pub default_profile_id: Option<String>,
}

/// Reads/writes this module's slice of `{game_path}/game.nihao`; the launcher's generic Game
/// settings (RAM etc.) own the rest, via `save_game_settings`/`load_game_settings` in
/// `src-tauri/src/local.rs`. Every write merges with what is on disk instead of overwriting, so the
/// launcher's `ram` field (or another module's keys) survives, and stamps `"game": "minecraft"` so
/// the file is self-describing. A file that is there but cannot be read is an error, so it is never
/// replaced by a few keys (see `read_game_settings`).
fn read_full(game_path: &str) -> Result<serde_json::Map<String, serde_json::Value>, String> {
    read_game_settings(&Path::new(game_path).join(GAME_SETTINGS_FILE_NAME))
}

async fn write_full(game_path: &str, obj: serde_json::Map<String, serde_json::Value>) -> Result<(), String> {
    fs::create_dir_all(game_path)
        .await
        .map_err(|e| format!("Cannot create game folder: {}", e))?;
    let file = Path::new(game_path).join(GAME_SETTINGS_FILE_NAME);
    let content = serde_json::to_string_pretty(&serde_json::Value::Object(obj)).map_err(|e| e.to_string())?;
    launcher_common::write_atomic(&file, content.as_bytes())
}

/// Never errors: a missing file means no profiles, and so does a damaged one (which is left as it
/// is; saving profiles reports it). Also drops a leftover `nickname` key (the old single-nickname
/// Game setting, which nothing reads now) that the launcher's generic save would otherwise
/// round-trip forever.
pub async fn load_profiles(game_path: &str) -> ProfilesData {
    let Ok(mut obj) = read_full(game_path) else { return ProfilesData::default() };
    if obj.remove("nickname").is_some() {
        let _ = write_full(game_path, obj.clone()).await;
    }
    let value = serde_json::json!({
        "profiles": obj.get("profiles").cloned().unwrap_or_else(|| serde_json::json!([])),
        "default_profile_id": obj.get("default_profile_id").cloned().unwrap_or(serde_json::Value::Null),
    });
    serde_json::from_value(value).unwrap_or_default()
}

pub async fn save_profiles(game_path: &str, data: &ProfilesData) -> Result<(), String> {
    let mut obj = read_full(game_path)?;
    obj.insert("game".to_string(), serde_json::json!("minecraft"));
    obj.insert(
        "profiles".to_string(),
        serde_json::to_value(&data.profiles).map_err(|e| e.to_string())?,
    );
    match &data.default_profile_id {
        Some(id) => {
            obj.insert("default_profile_id".to_string(), serde_json::json!(id));
        }
        None => {
            obj.remove("default_profile_id");
        }
    }
    // Tokens of deleted profiles don't outlive them.
    if let Some(tokens) = obj_tokens_mut(&mut obj) {
        tokens.retain(|id, _| data.profiles.iter().any(|p| &p.id == id));
    }
    write_full(game_path, obj).await
}

const ELYBY_TOKENS_KEY: &str = "elyby_tokens";

fn obj_tokens_mut(obj: &mut serde_json::Map<String, serde_json::Value>) -> Option<&mut serde_json::Map<String, serde_json::Value>> {
    obj.get_mut(ELYBY_TOKENS_KEY)?.as_object_mut()
}

/// Keeps an Ely.by profile's token next to the profile list in `game.nihao`, under its own key so
/// it never travels through `get_profiles` to the UI. `save_profiles` drops it with the profile.
pub async fn save_elyby_token(game_path: &str, profile_id: &str, account: &crate::library::elyby::ElybyAccount) -> Result<(), String> {
    let mut obj = read_full(game_path)?;
    let tokens = obj.entry(ELYBY_TOKENS_KEY).or_insert_with(|| serde_json::json!({}));
    tokens[profile_id] = serde_json::json!({ "access_token": account.access_token, "client_token": account.client_token });
    write_full(game_path, obj).await
}

/// `(access_token, client_token)` saved for the Ely.by profile.
pub fn load_elyby_token(game_path: &str, profile_id: &str) -> Option<(String, String)> {
    let obj = read_full(game_path).ok()?;
    let entry = obj.get(ELYBY_TOKENS_KEY)?.get(profile_id)?;
    Some((entry["access_token"].as_str()?.to_string(), entry["client_token"].as_str()?.to_string()))
}

async fn fetch_png(url: &str) -> Option<Vec<u8>> {
    let response = super::install::HTTP.get(url).timeout(std::time::Duration::from_secs(8)).send().await.ok()?;
    if !response.status().is_success() {
        return None;
    }
    Some(response.bytes().await.ok()?.to_vec())
}

/// Whether `nickname` is a valid player name, which also keeps it safe to put in a URL.
fn is_nickname(nickname: &str) -> bool {
    !nickname.is_empty() && nickname.len() <= 16 && nickname.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// The cape of the player `nickname` on Ely.by as a PNG; `None` when there is none.
pub async fn find_cape(nickname: &str) -> Option<Vec<u8>> {
    if !is_nickname(nickname) {
        return None;
    }
    fetch_png(&format!("https://skinsystem.ely.by/cloaks/{nickname}.png")).await
}

/// The skin of the player `nickname` as a PNG: Ely.by's, else the licensed Mojang account's.
/// `None` when neither knows the name (or a service is unreachable).
pub async fn find_skin(nickname: &str) -> Option<Vec<u8>> {
    if !is_nickname(nickname) {
        return None;
    }
    if let Some(png) = fetch_png(&format!("https://skinsystem.ely.by/skins/{nickname}.png")).await {
        return Some(png);
    }
    let get_json = |url: String| async move {
        let response = super::install::HTTP.get(url).timeout(std::time::Duration::from_secs(8)).send().await.ok()?;
        if !response.status().is_success() {
            return None;
        }
        response.json::<serde_json::Value>().await.ok()
    };
    let id = get_json(format!("https://api.mojang.com/users/profiles/minecraft/{nickname}")).await?["id"].as_str()?.to_string();
    let profile = get_json(format!("https://sessionserver.mojang.com/session/minecraft/profile/{id}")).await?;
    let textures = profile["properties"].as_array()?.iter().find(|p| p["name"] == "textures")?["value"].as_str()?;
    use base64::Engine;
    let decoded = base64::engine::general_purpose::STANDARD.decode(textures).ok()?;
    let url = serde_json::from_slice::<serde_json::Value>(&decoded).ok()?["textures"]["SKIN"]["url"].as_str()?.to_string();
    fetch_png(&url).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_nickname_that_is_not_one_has_no_skin() {
        assert!(find_skin("../x").await.is_none());
        assert!(find_skin("").await.is_none());
    }

    #[tokio::test]
    async fn a_damaged_settings_file_is_reported_not_replaced() {
        let dir = std::env::temp_dir().join(format!("nihao-session-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let (path, file) = (dir.to_str().unwrap(), dir.join(GAME_SETTINGS_FILE_NAME));
        let one = ProfilesData {
            profiles: vec![OfflineProfile { id: "a".into(), name: "Alex".into(), service: "offline".into() }],
            default_profile_id: Some("a".into()),
        };

        std::fs::write(&file, r#"{"ram":4096}"#).unwrap();
        save_profiles(path, &one).await.unwrap();
        assert_eq!(load_profiles(path).await.profiles.len(), 1);
        assert!(std::fs::read_to_string(&file).unwrap().contains("\"ram\": 4096"), "the launcher's keys survive");

        std::fs::write(&file, "{ damaged").unwrap();
        assert!(save_profiles(path, &one).await.is_err());
        assert!(load_profiles(path).await.profiles.is_empty());
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "{ damaged", "nothing was written over it");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
