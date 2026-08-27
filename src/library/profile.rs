use std::path::Path;

use serde::{Deserialize, Serialize};
use tokio::{fs, io::AsyncWriteExt};

use crate::library::modpack_format::ModpackManifest;
use crate::library::version::MinecraftLoader;

pub const PROFILE_FILE_NAME: &str = "profile.nihao";

fn default_min_ram() -> u32 { 512 }

/// A named local instance's saved configuration — one per `<instance_dir>/profile.nihao`.
///
/// Every field added after the original four is `#[serde(default)]` so profiles saved
/// before that field existed still load — instances created earlier in this project's life
/// (e.g. before per-instance java_path/jvm_arguments/icon support) would otherwise fail to
/// deserialize entirely.
#[derive(Serialize, Deserialize, Clone)]
pub struct MinecraftProfile {
    pub display_name: String,
    pub version_id: String,
    pub core: MinecraftLoader,
    pub loader_version: Option<String>,
    pub max_ram: u32,
    #[serde(default = "default_min_ram")]
    pub min_ram: u32,
    /// When `false` (the default), this instance's own `max_ram`/`min_ram` are ignored at
    /// launch in favor of the general "Game settings" RAM allocation — an instance only uses
    /// its own RAM once the player explicitly opts in via this checkbox.
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
    /// Set once this instance is tracking a published pack (via `generate_modpack_manifest`,
    /// or a future "install from server" flow) — the last-known manifest for it, so the client
    /// can diff against a newer `build` without re-fetching its own file list first. `None` for
    /// a from-scratch/custom instance. See MODPACK_FORMAT.md — this used to be a separate
    /// `modpack.nihao` file; merged in here since `profile.nihao` was already "the file that
    /// describes this instance's pack" in every way that mattered.
    #[serde(default)]
    pub pack: Option<ModpackManifest>,
}

impl MinecraftProfile {
    pub async fn save(&self, instance_dir: &Path) -> Result<(), String> {
        fs::create_dir_all(instance_dir)
            .await
            .map_err(|e| format!("Cannot create instance directory: {}", e))?;

        let content = serde_json::to_string(self).map_err(|e| e.to_string())?;
        let mut file = fs::File::create(instance_dir.join(PROFILE_FILE_NAME))
            .await
            .map_err(|e| format!("Cannot create profile file: {}", e))?;
        file.write_all(content.as_bytes())
            .await
            .map_err(|e| format!("Cannot write profile file: {}", e))?;
        Ok(())
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
