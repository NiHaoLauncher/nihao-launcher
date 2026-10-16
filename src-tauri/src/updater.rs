use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Duration;

use futures_util::StreamExt;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::io::AsyncWriteExt;

use crate::get_program_path;

/// Updates are the newest release of this project; its first `.zip` asset is the payload. The same
/// release is published on GitHub and on GitLab: whichever answers, or has the newer version, is
/// used, so one of them being down (or lagging behind) never blocks updating.
const GITHUB_RELEASES_API: &str = "https://api.github.com/repos/BogdanCater/nihao-launcher/releases/latest";
/// Project path `BogdanCater/nihao-launcher`, URL-encoded as the GitLab API wants it.
const GITLAB_RELEASES_API: &str =
    "https://gitlab.com/api/v4/projects/BogdanCater%2Fnihao-launcher/releases/permalink/latest";
/// A lookup or a download that makes no progress for this long counts as a failure, so the other
/// source gets its turn instead of the launcher waiting forever.
const STALL_TIMEOUT: Duration = Duration::from_secs(20);
const PENDING_CHANGELOG_FILE: &str = "nihao.changelog.json";

#[derive(Deserialize, Serialize, Debug, Clone)]
pub struct LauncherUpdateManifest {
    pub lates_update: UpdateInfo,
}

#[derive(Deserialize, Serialize, Debug, Clone, PartialEq)]
pub struct UpdateInfo {
    pub version: String,
    pub url: String,
    pub source: String,
    #[serde(default)]
    pub description: String,
    /// Optional promo image for the update; can be empty, a full URL, or a Google Drive file id.
    #[serde(default)]
    pub image: String,
}

#[derive(Serialize, Clone)]
struct UpdateProgress {
    status: String,
    current: u64,
    total: u64,
}

/// "v1.2.3" / "1.2.3-beta" -> [1, 2, 3]; non-numeric parts count as 0. Trailing zeros are dropped,
/// so "1.2" and "1.2.0" compare equal.
fn parse_version(v: &str) -> Vec<u64> {
    let mut parts: Vec<u64> = v
        .trim_start_matches('v')
        .split('-')
        .next()
        .unwrap_or("")
        .split('.')
        .map(|p| p.parse().unwrap_or(0))
        .collect();
    while parts.last() == Some(&0) {
        parts.pop();
    }
    parts
}

async fn get_json(url: &str) -> Result<Value, String> {
    let client = Client::builder().timeout(STALL_TIMEOUT).build().map_err(|e| e.to_string())?;
    client
        .get(url)
        .header("User-Agent", "nihao-launcher") // GitHub rejects requests without one
        .send()
        .await
        .map_err(|e| format!("cannot reach it: {e}"))?
        .error_for_status()
        .map_err(|e| format!("release lookup failed: {e}"))?
        .json()
        .await
        .map_err(|e| format!("invalid response: {e}"))
}

/// The download URL of the first `.zip` among `(file name, url)` pairs.
fn pick_zip<'a>(mut assets: impl Iterator<Item = (&'a str, &'a str)>) -> Option<&'a str> {
    assets.find(|(name, url)| name.ends_with(".zip") || url.ends_with(".zip")).map(|(_, url)| url)
}

fn release_info(tag: Option<&str>, url: Option<&str>, description: Option<&str>) -> Result<UpdateInfo, String> {
    Ok(UpdateInfo {
        version: tag.ok_or("release has no tag_name")?.trim_start_matches('v').to_string(),
        url: url.ok_or("latest release has no .zip asset")?.to_string(),
        source: "Url".to_string(),
        description: description.unwrap_or("").to_string(),
        image: String::new(),
    })
}

async fn fetch_github() -> Result<UpdateInfo, String> {
    let release = get_json(GITHUB_RELEASES_API).await?;
    let assets = release["assets"].as_array().map(Vec::as_slice).unwrap_or_default();
    let url = pick_zip(assets.iter().filter_map(|a| Some((a["name"].as_str()?, a["browser_download_url"].as_str()?))));
    release_info(release["tag_name"].as_str(), url, release["body"].as_str())
}

async fn fetch_gitlab() -> Result<UpdateInfo, String> {
    let release = get_json(GITLAB_RELEASES_API).await?;
    // `assets.links` are the files attached to the release; `assets.sources` is GitLab's own source archive, not ours.
    let links = release["assets"]["links"].as_array().map(Vec::as_slice).unwrap_or_default();
    let url = pick_zip(links.iter().filter_map(|l| {
        Some((l["name"].as_str()?, l["direct_asset_url"].as_str().or_else(|| l["url"].as_str())?))
    }));
    release_info(release["tag_name"].as_str(), url, release["description"].as_str())
}

/// The latest release of every source that answered, newest first (GitHub first on a tie).
async fn fetch_releases() -> Result<Vec<(&'static str, UpdateInfo)>, String> {
    let (github, gitlab) = tokio::join!(fetch_github(), fetch_gitlab());
    sort_releases(github, gitlab)
}

/// Fails only when no source answered, naming why each one failed.
fn sort_releases(
    github: Result<UpdateInfo, String>,
    gitlab: Result<UpdateInfo, String>,
) -> Result<Vec<(&'static str, UpdateInfo)>, String> {
    let (mut releases, mut errors) = (Vec::new(), Vec::new());
    for (host, result) in [("GitHub", github), ("GitLab", gitlab)] {
        match result {
            Ok(info) => releases.push((host, info)),
            Err(e) => errors.push(format!("{host}: {e}")),
        }
    }
    if releases.is_empty() {
        return Err(errors.join("; "));
    }
    // Stable sort: on equal versions GitHub (pushed first) stays first.
    releases.sort_by(|a, b| parse_version(&b.1.version).cmp(&parse_version(&a.1.version)));
    Ok(releases)
}

fn is_newer_than_running(update: &UpdateInfo) -> bool {
    parse_version(&update.version) > parse_version(env!("CARGO_PKG_VERSION"))
}

/// Returns the newest release (GitHub or GitLab) when it is newer than the running build, otherwise None.
#[tauri::command]
pub async fn check_for_update() -> Result<Option<LauncherUpdateManifest>, String> {
    let (_, newest) = fetch_releases().await?.remove(0);
    Ok(is_newer_than_running(&newest).then_some(LauncherUpdateManifest { lates_update: newest }))
}

#[tauri::command]
pub async fn install_update(window: tauri::Window) -> Result<(), String> {
    // Always re-ask the sources: the webview (which also runs third-party themes/modules) must never
    // be able to choose what gets unpacked over the launcher's own files.
    let candidates: Vec<_> = fetch_releases().await?.into_iter().filter(|(_, u)| is_newer_than_running(u)).collect();
    if candidates.is_empty() {
        return Err("No newer release is available".to_string());
    }

    let program_path = get_program_path()?;
    let cache_dir = program_path.join(".cache");
    tokio::fs::create_dir_all(&cache_dir).await.map_err(|e| e.to_string())?;
    let archive_path = cache_dir.join("launcher_update.cache");
    let staging = cache_dir.join("update_new");

    // Newest first; if a source's download or archive turns out bad, the next source gets its turn.
    // Everything is unpacked aside first, so a bad/truncated zip fails before any launcher file is touched.
    let mut errors = Vec::new();
    let mut staged = None;
    for (host, update) in candidates {
        match stage_update(&window, &update.url, &archive_path, &staging).await {
            Ok(()) => {
                staged = Some(update);
                break;
            }
            Err(e) => errors.push(format!("{host} {}: {e}", update.version)),
        }
    }
    let _ = tokio::fs::remove_file(&archive_path).await;
    let Some(update) = staged else { return Err(errors.join("; ")) };

    let program_path_blocking = program_path.clone();
    tokio::task::spawn_blocking(move || {
        let applied = apply_staged(&staging, &program_path_blocking);
        let _ = std::fs::remove_dir_all(&staging);
        applied
    })
    .await
    .map_err(|e| e.to_string())??;

    write_pending_changelog(&update).await?;
    emit_progress(&window, "done", 1, 1);

    Ok(())
}

/// Downloads the release archive and unpacks it into a fresh `staging` folder.
async fn stage_update(window: &tauri::Window, url: &str, archive_path: &Path, staging: &Path) -> Result<(), String> {
    download_with_progress(window, url, &archive_path.to_path_buf()).await?;

    emit_progress(window, "extracting", 0, 1);
    let (archive, staging) = (archive_path.to_path_buf(), staging.to_path_buf());
    tokio::task::spawn_blocking(move || {
        let _ = std::fs::remove_dir_all(&staging);
        let extracted = extract_archive(&archive, &staging);
        if extracted.is_err() {
            let _ = std::fs::remove_dir_all(&staging);
        }
        extracted
    })
    .await
    .map_err(|e| e.to_string())?
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
    let client = Client::builder().connect_timeout(STALL_TIMEOUT).build().map_err(|e| e.to_string())?;
    let response = tokio::time::timeout(STALL_TIMEOUT, client.get(url).send())
        .await
        .map_err(|_| "Download request timed out".to_string())?
        .and_then(|r| r.error_for_status())
        .map_err(|e| format!("Download request failed: {e}"))?;
    let total = response.content_length().unwrap_or(0);

    let mut file = tokio::fs::File::create(dest).await.map_err(|e| e.to_string())?;
    let mut stream = response.bytes_stream();
    let mut downloaded: u64 = 0;

    // No total timeout (the archive can be big), but a stalled connection must not hang forever.
    while let Some(chunk) = tokio::time::timeout(STALL_TIMEOUT, stream.next())
        .await
        .map_err(|_| "Download stalled".to_string())?
    {
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

/// Moves every file under `staged` over the same relative path in `target`. Files locked by the
/// running process (e.g. our own .exe) are renamed aside first (see `write_replacing`), since
/// Windows allows renaming an open executable even though it can't be overwritten in place.
fn apply_staged(staged: &Path, target: &Path) -> Result<(), String> {
    for entry in std::fs::read_dir(staged).map_err(|e| e.to_string())?.flatten() {
        let from = entry.path();
        let to = target.join(entry.file_name());
        if from.is_dir() {
            std::fs::create_dir_all(&to).map_err(|e| e.to_string())?;
            apply_staged(&from, &to)?;
        } else {
            let mut src = std::fs::File::open(&from).map_err(|e| e.to_string())?;
            write_replacing(&to, &mut src)?;
        }
    }
    Ok(())
}

/// Extracts `archive_path` (a zip) into `target_dir`.
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

        let mut out = std::fs::File::create(&out_path).map_err(|e| e.to_string())?;
        std::io::copy(&mut entry, &mut out).map_err(|e| e.to_string())?;
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

#[cfg(test)]
mod tests {
    use super::*;

    fn release(version: &str) -> UpdateInfo {
        release_info(Some(version), Some("https://x/a.zip"), None).unwrap()
    }

    #[test]
    fn version_ordering() {
        assert!(parse_version("v0.10.0") > parse_version("0.9.9"));
        assert!(parse_version("0.1.1") > parse_version("0.1.0"));
        assert!(parse_version("0.1.0-beta") == parse_version("0.1.0"));
        assert!(parse_version("1.2") == parse_version("1.2.0"));
    }

    #[test]
    fn the_newer_source_wins_and_github_wins_a_tie() {
        let order = |g: Result<UpdateInfo, String>, l: Result<UpdateInfo, String>| {
            sort_releases(g, l).unwrap().into_iter().map(|(host, _)| host).collect::<Vec<_>>()
        };
        assert_eq!(order(Ok(release("0.2.0")), Ok(release("0.3.0"))), ["GitLab", "GitHub"]);
        assert_eq!(order(Ok(release("0.3.0")), Ok(release("0.2.0"))), ["GitHub", "GitLab"]);
        assert_eq!(order(Ok(release("0.3.0")), Ok(release("0.3.0"))), ["GitHub", "GitLab"]);
    }

    #[test]
    fn one_source_failing_falls_back_to_the_other() {
        assert_eq!(sort_releases(Err("down".into()), Ok(release("0.3.0"))).unwrap()[0].0, "GitLab");
        assert_eq!(sort_releases(Ok(release("0.3.0")), Err("down".into())).unwrap()[0].0, "GitHub");
        let both = sort_releases(Err("a".into()), Err("b".into())).unwrap_err();
        assert!(both.contains("GitHub: a") && both.contains("GitLab: b"));
    }

    #[test]
    fn picks_the_zip_not_other_assets() {
        let assets = [("notes.txt", "https://x/notes.txt"), ("nihao.zip", "https://x/nihao.zip")];
        assert_eq!(pick_zip(assets.into_iter()), Some("https://x/nihao.zip"));
        assert_eq!(pick_zip([("a.exe", "https://x/a.exe")].into_iter()), None);
    }
}
