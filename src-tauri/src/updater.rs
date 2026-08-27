use std::io::Read;
use std::path::{Path, PathBuf};

use futures_util::StreamExt;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::io::AsyncWriteExt;

use crate::get_program_path;

/// Google Drive file id of the update manifest. Content at this id is expected
/// to change with every release (kept in sync with nihao-updater's MAIN_MANIFEST).
pub const MAIN_MANIFEST: &str = "1zLqQkGQ6zgjH_ww75G6-k-lQUyliiDQB";
const UPDATE_RECORD_FILE: &str = "nihao.updt";
const PENDING_CHANGELOG_FILE: &str = "nihao.changelog.json";

#[derive(Deserialize, Serialize, Debug, Clone)]
pub struct LauncherUpdateManifest {
    pub lates_update: UpdateInfo,
    #[serde(default)]
    pub lates_updater: Option<UpdaterInfo>,
    #[serde(default)]
    pub others: Value,
}

#[derive(Deserialize, Serialize, Debug, Clone, PartialEq)]
pub struct UpdateInfo {
    pub server: String,
    #[serde(default)]
    pub args: Vec<String>,
    pub version: String,
    #[serde(default)]
    pub min_updater_version: String,
    pub url: String,
    pub source: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub path_notes: Vec<String>,
    /// Optional promo image for the update; can be empty, a full URL, or a Google Drive file id.
    #[serde(default)]
    pub image: String,
}

#[derive(Deserialize, Serialize, Debug, Clone)]
pub struct UpdaterInfo {
    pub version: String,
    pub url: String,
    pub source: String,
}

#[derive(Serialize, Clone)]
struct UpdateProgress {
    status: String,
    current: u64,
    total: u64,
}

fn manifest_url(file_id: &str) -> String {
    format!("https://drive.usercontent.google.com/u/0/uc?id={}", file_id)
}

async fn fetch_manifest() -> Result<LauncherUpdateManifest, String> {
    let client = Client::new();
    let response = client
        .get(manifest_url(MAIN_MANIFEST))
        .send()
        .await
        .map_err(|e| format!("Cannot reach update server: {e}"))?;
    let raw = response
        .text()
        .await
        .map_err(|e| format!("Cannot read update manifest: {e}"))?;

    serde_json::from_str::<LauncherUpdateManifest>(&raw)
        .or_else(|_| serde_json::from_str::<LauncherUpdateManifest>(&repair_missing_commas(&raw)))
        .map_err(|e| format!("Invalid update manifest: {e}"))
}

/// Best-effort fix for the common hand-editing mistake of a missing comma between
/// two JSON object members on adjacent lines (the manifest is hand-typed on the server side).
fn repair_missing_commas(raw: &str) -> String {
    let lines: Vec<&str> = raw.lines().collect();
    let mut fixed = String::with_capacity(raw.len() + lines.len());

    for (i, line) in lines.iter().enumerate() {
        let trimmed = line.trim_end();
        let next_starts_new_member = lines[i + 1..]
            .iter()
            .find(|l| !l.trim().is_empty())
            .map(|l| l.trim_start().starts_with('"'))
            .unwrap_or(false);
        let ends_with_value = trimmed.ends_with('"') || trimmed.ends_with(']') || trimmed.ends_with('}');
        let needs_comma = ends_with_value && !trimmed.ends_with(',') && next_starts_new_member;

        fixed.push_str(line);
        if needs_comma {
            fixed.push(',');
        }
        fixed.push('\n');
    }
    fixed
}

async fn read_installed_record() -> Option<UpdateInfo> {
    let path = get_program_path().ok()?.join(UPDATE_RECORD_FILE);
    let content = tokio::fs::read_to_string(path).await.ok()?;
    serde_json::from_str(&content).ok()
}

async fn write_installed_record(update: &UpdateInfo) -> Result<(), String> {
    let path = get_program_path()?.join(UPDATE_RECORD_FILE);
    let content = serde_json::to_string(update).map_err(|e| e.to_string())?;
    tokio::fs::write(path, content).await.map_err(|e| e.to_string())
}

/// Checks the remote manifest against the last-installed record.
/// Returns the full manifest when a different version is available, otherwise None.
#[tauri::command]
pub async fn check_for_update() -> Result<Option<LauncherUpdateManifest>, String> {
    let manifest = fetch_manifest().await?;
    let installed = read_installed_record().await;

    let needs_update = match &installed {
        Some(current) => {
            current.version != manifest.lates_update.version || current.url != manifest.lates_update.url
        }
        None => true,
    };

    Ok(if needs_update { Some(manifest) } else { None })
}

#[tauri::command]
pub async fn install_update(window: tauri::Window, manifest: LauncherUpdateManifest) -> Result<(), String> {
    let update = manifest.lates_update;
    let download_url = match update.source.as_str() {
        "GoogleDrive" => format!("https://drive.usercontent.google.com/u/0/uc?id={}&export=download", update.url),
        _ => update.url.clone(),
    };

    let program_path = get_program_path()?;
    let cache_dir = program_path.join(".cache");
    tokio::fs::create_dir_all(&cache_dir).await.map_err(|e| e.to_string())?;
    let archive_path = cache_dir.join("launcher_update.cache");

    download_with_progress(&window, &download_url, &archive_path).await?;

    emit_progress(&window, "extracting", 0, 1);
    let archive_path_blocking = archive_path.clone();
    let program_path_blocking = program_path.clone();
    tokio::task::spawn_blocking(move || extract_archive(&archive_path_blocking, &program_path_blocking))
        .await
        .map_err(|e| e.to_string())??;

    let _ = tokio::fs::remove_file(&archive_path).await;
    write_installed_record(&update).await?;
    write_pending_changelog(&update).await?;
    emit_progress(&window, "done", 1, 1);

    Ok(())
}

async fn write_pending_changelog(update: &UpdateInfo) -> Result<(), String> {
    let path = get_program_path()?.join(PENDING_CHANGELOG_FILE);
    let content = serde_json::to_string(update).map_err(|e| e.to_string())?;
    tokio::fs::write(path, content).await.map_err(|e| e.to_string())
}

/// Returns (and consumes) the changelog of the update that was applied just before this run,
/// so the caller can show a "what's new" screen exactly once, on the first launch after updating.
#[tauri::command]
pub async fn take_pending_update_info() -> Result<Option<UpdateInfo>, String> {
    let path = get_program_path()?.join(PENDING_CHANGELOG_FILE);
    if !path.exists() {
        return Ok(None);
    }
    let content = tokio::fs::read_to_string(&path).await.map_err(|e| e.to_string())?;
    let info: Option<UpdateInfo> = serde_json::from_str(&content).ok();
    let _ = tokio::fs::remove_file(&path).await;
    Ok(info)
}

/// Relaunches the launcher from its (now updated) executable and exits the current process.
#[tauri::command]
pub fn relaunch_app() {
    tauri::api::process::restart(&tauri::Env::default());
}

/// Best-effort cleanup of `*.old` files left behind by a previous self-update
/// (they couldn't be deleted while still locked by the process that produced them).
pub fn cleanup_previous_update_artifacts() {
    let Ok(program_path) = get_program_path() else { return };
    remove_old_files_in(&program_path);
    remove_old_files_in(&program_path.join("plugins"));
}

fn remove_old_files_in(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) == Some("old") {
            let _ = std::fs::remove_file(path);
        }
    }
}

async fn download_with_progress(window: &tauri::Window, url: &str, dest: &PathBuf) -> Result<(), String> {
    let client = Client::new();
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("Download request failed: {e}"))?;
    let total = response.content_length().unwrap_or(0);

    let mut file = tokio::fs::File::create(dest).await.map_err(|e| e.to_string())?;
    let mut stream = response.bytes_stream();
    let mut downloaded: u64 = 0;

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("Download interrupted: {e}"))?;
        file.write_all(&chunk).await.map_err(|e| e.to_string())?;
        downloaded += chunk.len() as u64;
        emit_progress(window, "downloading", downloaded, total);
    }
    file.flush().await.map_err(|e| e.to_string())?;
    Ok(())
}

fn emit_progress(window: &tauri::Window, status: &str, current: u64, total: u64) {
    let _ = window.emit(
        "update-progress",
        UpdateProgress { status: status.to_string(), current, total },
    );
}

/// Extracts `archive_path` (a zip) into `target_dir`, overwriting existing files.
/// Files locked by the running process (e.g. our own .exe) are renamed aside first,
/// since Windows allows renaming an open executable even though it can't be overwritten in place.
fn extract_archive(archive_path: &Path, target_dir: &Path) -> Result<(), String> {
    let file = std::fs::File::open(archive_path).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;

    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        let Some(relative_path) = entry.enclosed_name().map(|p| p.to_path_buf()) else {
            continue;
        };
        let out_path = target_dir.join(&relative_path);

        if entry.is_dir() {
            std::fs::create_dir_all(&out_path).map_err(|e| e.to_string())?;
            continue;
        }
        if let Some(parent) = out_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }

        write_replacing(&out_path, &mut entry)?;
    }
    Ok(())
}

fn write_replacing(out_path: &Path, entry: &mut impl Read) -> Result<(), String> {
    match std::fs::File::create(out_path) {
        Ok(mut f) => {
            std::io::copy(entry, &mut f).map_err(|e| e.to_string())?;
            Ok(())
        }
        Err(_) => {
            let mut backup_name = out_path.file_name().unwrap_or_default().to_os_string();
            backup_name.push(".old");
            let backup_path = out_path.with_file_name(backup_name);
            let _ = std::fs::remove_file(&backup_path);
            std::fs::rename(out_path, &backup_path)
                .map_err(|e| format!("'{}' is locked and cannot be replaced: {e}", out_path.display()))?;

            let mut f = std::fs::File::create(out_path).map_err(|e| e.to_string())?;
            std::io::copy(entry, &mut f).map_err(|e| e.to_string())?;
            Ok(())
        }
    }
}
