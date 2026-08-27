use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::{fs, io::AsyncWriteExt};

use crate::get_program_path;

#[derive(Serialize, Deserialize, Clone)]
pub struct NHDataClient {
    pub(crate) client: Option<String>,
    pub(crate) interface: NHDataClientInterface,
    pub(crate) features: Option<bool>,
    #[serde(default)]
    pub(crate) games: NHGamePaths,
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
        
        let path = get_program_path()?.join("local.data");
        let mut file = tokio::fs::File::create(path).await
            .map_err(|e|format!("Cannot create profile file(): {}", e))?;

        file.write_all(content.to_string().as_bytes()).await
                .map_err(|e|format!("Cannot write profile to file: {}", e))?;
        Ok(())
    }
}
#[derive(Serialize, Deserialize, Clone)]
pub struct NHDataClientInterface {
    pub(crate) language: String,
    pub(crate) hide_in_game_running: bool,
}

/// Only the install path lives here — the module's own settings live in `game.nihao` inside
/// that install folder instead (see `load_game_settings`/`save_game_settings` below), so a
/// module's config travels with its install rather than being embedded in the launcher's own
/// profile.
#[derive(Serialize, Deserialize, Clone, Default)]
pub struct GameLocalSettings {
    pub path: Option<String>,
}

pub type NHGamePaths = std::collections::HashMap<String, GameLocalSettings>;

const GAME_SETTINGS_FILE_NAME: &str = "game.nihao";

/// Reads a module's own settings from `{path}/game.nihao`.
pub async fn load_game_settings(path: &str) -> Result<Value, String> {
    let file = std::path::Path::new(path).join(GAME_SETTINGS_FILE_NAME);
    if let Ok(content) = fs::read_to_string(&file).await {
        return serde_json::from_str(&content).map_err(|e| e.to_string());
    }

    Ok(serde_json::json!({}))
}

pub async fn save_game_settings(path: &str, settings: &Value) -> Result<(), String> {
    fs::create_dir_all(path)
        .await
        .map_err(|e| format!("Cannot create game folder: {}", e))?;

    let file = std::path::Path::new(path).join(GAME_SETTINGS_FILE_NAME);
    let content = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    let mut f = tokio::fs::File::create(file)
        .await
        .map_err(|e| format!("Cannot create {}: {}", GAME_SETTINGS_FILE_NAME, e))?;
    f.write_all(content.as_bytes())
        .await
        .map_err(|e| format!("Cannot write {}: {}", GAME_SETTINGS_FILE_NAME, e))?;
    Ok(())
}