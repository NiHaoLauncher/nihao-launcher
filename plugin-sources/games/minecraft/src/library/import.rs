//! Importing a modpack file into a new local instance — the reverse of `export.rs`. Two
//! formats, matching what `export.rs` produces (and, for `.mrpack`, what other launchers do):
//!
//! - **Own format** (`import_own_format`): unzips `files/` straight into the new instance
//!   directory, using `manifest.json` for the file list.
//! - **Modrinth `.mrpack`** (`import_mrpack`): unzips `overrides/`/`client-overrides/` directly,
//!   and downloads every `files[]` entry from its own `downloads` URL (Modrinth's CDN, or
//!   wherever the pack author pointed it).
//!
//! Neither format bundles the actual Minecraft client/libraries/assets — only mods/configs/
//! resourcepacks — so `interface.rs`'s `import_modpack` runs the normal install pipeline
//! (the same one `create_modpack` uses) right after either of these finishes.

use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};

use reqwest::Client;
use serde::{Deserialize, Serialize};
use zip::ZipArchive;

use super::export::{ExportProgress as JobProgress, ProgressCallback};
use super::modpack_format::ModpackManifest;
use super::version::MinecraftLoader;

fn open_zip(source_path: &Path) -> Result<ZipArchive<std::fs::File>, String> {
    let file = std::fs::File::open(source_path).map_err(|e| format!("Cannot open file: {}", e))?;
    ZipArchive::new(file).map_err(|e| format!("Not a valid archive: {}", e))
}

fn read_zip_entry(zip: &mut ZipArchive<std::fs::File>, name: &str) -> Option<String> {
    let mut entry = zip.by_name(name).ok()?;
    let mut content = String::new();
    entry.read_to_string(&mut content).ok()?;
    Some(content)
}

#[derive(Deserialize)]
struct MrpackIndexIn {
    name: String,
    dependencies: HashMap<String, String>,
    #[serde(default)]
    files: Vec<MrpackFileIn>,
}

#[derive(Deserialize, Clone)]
struct MrpackFileIn {
    path: String,
    downloads: Vec<String>,
}

fn detect_loader(dependencies: &HashMap<String, String>) -> (MinecraftLoader, Option<String>) {
    if let Some(v) = dependencies.get("fabric-loader") {
        return (MinecraftLoader::FABRIC, Some(v.clone()));
    }
    if let Some(v) = dependencies.get("forge") {
        return (MinecraftLoader::FORGE, Some(v.clone()));
    }
    if let Some(v) = dependencies.get("neoforge") {
        return (MinecraftLoader::NEOFORGE, Some(v.clone()));
    }
    (MinecraftLoader::VANILLA, None)
}

/// What `interface.rs`'s "Install modpack" screen shows before committing — parsed from the
/// file without extracting or downloading anything, so it's fast enough to run as soon as the
/// player picks a file.
#[derive(Serialize, Clone)]
pub struct ImportPreview {
    /// `"own"` or `"mrpack"` — which of `import_own_format`/`import_mrpack` to call next.
    pub format: String,
    pub name: String,
    pub minecraft_version: String,
    /// Lowercase, matching `MinecraftLoader::to_string()`/`create_modpack`'s `core` param —
    /// not the manifest's own uppercase Rust-enum serialization.
    pub loader: String,
    pub loader_version: Option<String>,
}

pub fn peek(source_path: &Path) -> Result<ImportPreview, String> {
    let mut zip = open_zip(source_path)?;

    if let Some(content) = read_zip_entry(&mut zip, "manifest.json") {
        let manifest: ModpackManifest =
            serde_json::from_str(&content).map_err(|e| format!("Invalid manifest.json: {}", e))?;
        return Ok(ImportPreview {
            format: "own".to_string(),
            name: manifest.name,
            minecraft_version: manifest.minecraft_version,
            loader: manifest.loader.to_string(),
            loader_version: manifest.loader_version,
        });
    }

    if let Some(content) = read_zip_entry(&mut zip, "modrinth.index.json") {
        let index: MrpackIndexIn =
            serde_json::from_str(&content).map_err(|e| format!("Invalid modrinth.index.json: {}", e))?;
        let minecraft_version = index.dependencies.get("minecraft").cloned().unwrap_or_default();
        let (loader, loader_version) = detect_loader(&index.dependencies);
        return Ok(ImportPreview {
            format: "mrpack".to_string(),
            name: index.name,
            minecraft_version,
            loader: loader.to_string(),
            loader_version,
        });
    }

    Err("Not a recognized modpack file (missing manifest.json or modrinth.index.json).".to_string())
}

/// Unzips `files/` into `instance_dir`, per `manifest.json`. Returns the manifest so the
/// caller can track it as the new instance's `profile.pack` (this format round-trips through
/// `export_own_format` exactly, unlike `.mrpack`).
pub async fn import_own_format(
    instance_dir: PathBuf,
    source_path: PathBuf,
    on_progress: ProgressCallback,
) -> Result<ModpackManifest, String> {
    tokio::task::spawn_blocking(move || {
        let mut zip = open_zip(&source_path)?;
        let manifest_content = read_zip_entry(&mut zip, "manifest.json")
            .ok_or_else(|| "manifest.json not found in archive".to_string())?;
        let manifest: ModpackManifest =
            serde_json::from_str(&manifest_content).map_err(|e| format!("Invalid manifest.json: {}", e))?;

        std::fs::create_dir_all(&instance_dir).map_err(|e| format!("Cannot create instance folder: {}", e))?;

        let total = manifest.files.len();
        for (i, entry) in manifest.files.iter().enumerate() {
            on_progress(JobProgress {
                etap: "Extracting files".to_string(),
                current_etaps: 1,
                total_etaps: 1,
                current_file: i,
                total_files: total,
                status: "extract".to_string(),
                filename: entry.path.clone(),
            });

            let zip_path = format!("files/{}", entry.path);
            let mut zip_file = zip
                .by_name(&zip_path)
                .map_err(|e| format!("Missing '{}' in archive: {}", zip_path, e))?;
            let dest = instance_dir.join(&entry.path);
            if let Some(parent) = dest.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            let mut out = std::fs::File::create(&dest)
                .map_err(|e| format!("Cannot write '{}': {}", dest.display(), e))?;
            std::io::copy(&mut zip_file, &mut out)
                .map_err(|e| format!("Cannot extract '{}': {}", entry.path, e))?;
        }

        Ok(manifest)
    })
    .await
    .map_err(|e| format!("Import task panicked: {}", e))?
}

/// Unzips `overrides/`/`client-overrides/` into `instance_dir`, then downloads every
/// `files[]` entry from its `downloads` URL.
pub async fn import_mrpack(
    instance_dir: PathBuf,
    source_path: PathBuf,
    on_progress: ProgressCallback,
) -> Result<(), String> {
    let extract_progress = on_progress.clone();
    let dir_for_extract = instance_dir.clone();
    let index: MrpackIndexIn = tokio::task::spawn_blocking(move || {
        let mut zip = open_zip(&source_path)?;
        let index_content = read_zip_entry(&mut zip, "modrinth.index.json")
            .ok_or_else(|| "modrinth.index.json not found in archive".to_string())?;
        let index: MrpackIndexIn =
            serde_json::from_str(&index_content).map_err(|e| format!("Invalid modrinth.index.json: {}", e))?;

        std::fs::create_dir_all(&dir_for_extract).map_err(|e| format!("Cannot create instance folder: {}", e))?;

        // `by_name` needs a fresh borrow per entry, so gather names first rather than holding
        // one across the `on_progress` call below.
        let override_names: Vec<String> = (0..zip.len())
            .filter_map(|i| zip.by_index(i).ok().map(|f| f.name().to_string()))
            .filter(|n| (n.starts_with("overrides/") || n.starts_with("client-overrides/")) && !n.ends_with('/'))
            .collect();

        let total = override_names.len();
        for (i, entry_name) in override_names.iter().enumerate() {
            extract_progress(JobProgress {
                etap: "Extracting overrides".to_string(),
                current_etaps: 1,
                total_etaps: 2,
                current_file: i,
                total_files: total,
                status: "extract".to_string(),
                filename: entry_name.clone(),
            });

            let rel = entry_name
                .strip_prefix("overrides/")
                .or_else(|| entry_name.strip_prefix("client-overrides/"))
                .unwrap_or(entry_name);
            let mut zip_file = zip.by_name(entry_name).map_err(|e| e.to_string())?;
            let dest = dir_for_extract.join(rel);
            if let Some(parent) = dest.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            let mut out = std::fs::File::create(&dest)
                .map_err(|e| format!("Cannot write '{}': {}", dest.display(), e))?;
            std::io::copy(&mut zip_file, &mut out)
                .map_err(|e| format!("Cannot extract '{}': {}", entry_name, e))?;
        }

        Ok::<_, String>(index)
    })
    .await
    .map_err(|e| format!("Import task panicked: {}", e))??;

    let client = Client::new();
    let total = index.files.len();
    for (i, file) in index.files.iter().enumerate() {
        on_progress(JobProgress {
            etap: "Downloading mods".to_string(),
            current_etaps: 2,
            total_etaps: 2,
            current_file: i,
            total_files: total,
            status: "install".to_string(),
            filename: file.path.clone(),
        });

        let url = file
            .downloads
            .first()
            .ok_or_else(|| format!("No download URL for '{}'", file.path))?;
        let bytes = client
            .get(url)
            .send()
            .await
            .map_err(|e| format!("Cannot download '{}': {}", file.path, e))?
            .bytes()
            .await
            .map_err(|e| format!("Cannot download '{}': {}", file.path, e))?;

        let dest = instance_dir.join(&file.path);
        if let Some(parent) = dest.parent() {
            tokio::fs::create_dir_all(parent).await.map_err(|e| e.to_string())?;
        }
        tokio::fs::write(&dest, &bytes)
            .await
            .map_err(|e| format!("Cannot write '{}': {}", file.path, e))?;
    }

    Ok(())
}
