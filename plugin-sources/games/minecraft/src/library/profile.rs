use std::collections::HashMap;
use std::path::Path;

use serde::{Deserialize, Serialize};
use tokio::fs;

use crate::library::modpack_format::ModpackManifest;
use crate::library::services::BlockedFile;
use crate::library::version::MinecraftLoader;

pub const PROFILE_FILE_NAME: &str = "profile.nihao";

fn default_min_ram() -> u32 { 512 }

/// The online service project (and build of it) an instance was downloaded from. Our own server's
/// packs are tracked by `MinecraftProfile::pack` instead; this is for third-party services.
#[derive(Serialize, Deserialize, Clone)]
pub struct ModpackSource {
    /// `ServiceInfo::id` of the `services::ContentService` it came from (e.g. `"modrinth"`).
    pub service: String,
    pub project_id: String,
    pub version_id: String,
    pub version_number: String,
    pub name: String,
    /// Public icon and project page on the service; used for Discord presence.
    #[serde(default)]
    pub icon_url: Option<String>,
    #[serde(default)]
    pub url: Option<String>,
}

/// Where an instance's play time went, in seconds per place, read from the game log while it runs.
#[derive(Serialize, Deserialize, Clone, Default)]
pub struct PlayStats {
    /// Title screen and loading, i.e. in no world and on no server.
    #[serde(default)]
    pub menu_secs: u64,
    /// Singleplayer worlds by name.
    #[serde(default)]
    pub worlds: HashMap<String, u64>,
    /// Multiplayer servers by address.
    #[serde(default)]
    pub servers: HashMap<String, u64>,
    /// Seconds played per local calendar day, keyed `YYYY-MM-DD` (the activity chart).
    #[serde(default)]
    pub daily: HashMap<String, u64>,
}

/// A named local instance's saved configuration, one per `<instance_dir>/profile.nihao`. Every
/// field added after the original four is `#[serde(default)]`, so older profiles still load.
#[derive(Serialize, Deserialize, Clone)]
pub struct MinecraftProfile {
    pub display_name: String,
    pub version_id: String,
    pub core: MinecraftLoader,
    pub loader_version: Option<String>,
    pub max_ram: u32,
    #[serde(default = "default_min_ram")]
    pub min_ram: u32,
    /// When `false` (default), this instance's `max_ram`/`min_ram` are ignored at launch in favour
    /// of the general "Game settings" RAM; an instance uses its own only when the player opts in.
    #[serde(default)]
    pub use_custom_ram: bool,
    /// Overrides the auto-downloaded/managed JRE when set — a path to a `java`/`javaw` exe.
    #[serde(default)]
    pub java_path: Option<String>,
    /// Extra raw JVM args (space-separated), appended after the loader's own.
    #[serde(default)]
    pub jvm_arguments: String,
    /// Filename of the instance's custom icon ("icon"), relative to the instance directory —
    /// `None` means "use the default icon".
    #[serde(default)]
    pub icon: Option<String>,
    /// Filename of the instance's custom banner ("banner") — shown on its tile in the modpack
    /// list and as the launch page's backdrop. `None` means "use the plugin's shared background".
    #[serde(default)]
    pub banner: Option<String>,
    /// Set once this instance tracks a published pack (via `generate_modpack_manifest` or
    /// `install_online_modpack`): the last-known manifest, so the client can diff against a newer
    /// `build` without re-fetching its file list. `None` for a custom instance. See
    /// MODPACK_FORMAT.md.
    #[serde(default)]
    pub pack: Option<ModpackManifest>,
    /// `true` only for an instance created by `install_online_modpack` ("Public" tab download),
    /// unlike `pack.is_some()`, which is also true for a local instance its owner later published.
    /// Its content is dictated by the server, so the UI hides local-only editing
    /// (icon/banner/name/duplicate) and keeps it out of the "Custom" tab.
    #[serde(default)]
    pub downloaded: bool,
    /// Total time the game ran from this instance, in seconds (counted when it exits).
    #[serde(default)]
    pub play_secs: u64,
    /// `play_secs` split by place; only covers sessions since it was introduced, so it can sum to less.
    #[serde(default)]
    pub play_stats: PlayStats,
    /// Unix time (seconds) of the last launch.
    #[serde(default)]
    pub last_played: Option<u64>,
    /// Set when the instance was downloaded from a third-party `services::ContentService`, tying it
    /// to that project/build.
    #[serde(default)]
    pub source: Option<ModpackSource>,
    /// Files the pack needs that couldn't be downloaded for the player (their authors disabled
    /// third-party downloads and no other service has them): the player gets them by hand. Cleared
    /// as `check_missing_files` finds them in place.
    #[serde(default)]
    pub missing_files: Vec<BlockedFile>,
}

impl MinecraftProfile {
    pub async fn save(&self, instance_dir: &Path) -> Result<(), String> {
        fs::create_dir_all(instance_dir)
            .await
            .map_err(|e| format!("Cannot create instance directory: {}", e))?;

        let content = serde_json::to_string(self).map_err(|e| e.to_string())?;
        launcher_common::write_atomic(&instance_dir.join(PROFILE_FILE_NAME), content.as_bytes())
    }

    pub async fn load(instance_dir: &Path) -> Result<Self, String> {
        let path = instance_dir.join(PROFILE_FILE_NAME);
        let content = fs::read_to_string(&path)
            .await
            .map_err(|e| format!("Cannot read '{}': {}", path.display(), e))?;
        serde_json::from_str(&content).map_err(|e| e.to_string())
    }
}

/// Scans `instances_root` for subdirectories containing a `profile.nihao`, returning
/// `(instance_name, profile)` pairs — mirrors the old project's instance listing.
pub async fn list_instances(instances_root: &Path) -> Vec<(String, MinecraftProfile)> {
    let mut result = Vec::new();

    let mut entries = match fs::read_dir(instances_root).await {
        Ok(entries) => entries,
        Err(_) => return result,
    };

    while let Ok(Some(entry)) = entries.next_entry().await {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        if let Ok(profile) = MinecraftProfile::load(&path).await {
            if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                result.push((name.to_string(), profile));
            }
        }
    }

    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn profiles_saved_before_missing_files_existed_still_load() {
        let profile: MinecraftProfile = serde_json::from_str(
            r#"{"display_name":"x","version_id":"1.21.1","core":"VANILLA","loader_version":null,"max_ram":2048}"#,
        )
        .unwrap();
        assert!(profile.missing_files.is_empty());
    }
}
