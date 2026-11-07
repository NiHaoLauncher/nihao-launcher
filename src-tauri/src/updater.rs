use std::path::{Path, PathBuf};
use std::time::Duration;

use futures_util::StreamExt;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;

use crate::get_program_path;
use crate::release_lookup::{newest_first, parse_version, pick_zip, THIS_OS};

/// Updates are the newest release of this project; its first `.zip` asset is the payload. The same
/// release is on GitHub and GitLab: whichever answers (or has the newer version) is used, so one
/// being down never blocks updating. A zip placed next to the launcher (if any) is checked with
/// its `.sig`; a download from GitHub or GitLab is trusted as-is and is not asked for a `.sig`.
const GITHUB_RELEASES_API: &str = "https://api.github.com/repos/BogdanCater/nihao-launcher/releases/latest";
/// Project path `BogdanCater/nihao-launcher`, URL-encoded as the GitLab API wants it.
const GITLAB_RELEASES_API: &str =
    "https://gitlab.com/api/v4/projects/BogdanCater%2Fnihao-launcher/releases/permalink/latest";
/// A download making no progress for this long counts as a failure, so the other source gets its
/// turn.
const STALL_TIMEOUT: Duration = Duration::from_secs(20);
/// The release lookup runs before the launcher shows anything, so it gets less time: a network that
/// swallows the request means "no update this time", not a twenty-second wait at every start.
const LOOKUP_TIMEOUT: Duration = Duration::from_secs(6);
const PENDING_CHANGELOG_FILE: &str = "nihao.changelog.json";

#[derive(Deserialize, Serialize, Debug, Clone, PartialEq)]
pub struct UpdateInfo {
    pub version: String,
    pub url: String,
    /// The release's `.sig` asset; empty when it has none. Cloud downloads are trusted as-is and
    /// not asked for a `.sig`; this field is carried for reference only.
    #[serde(default)]
    pub signature_url: String,
    /// The release text, shown as the changelog.
    #[serde(default)]
    pub description: String,
}

#[derive(Serialize, Clone)]
struct UpdateProgress {
    status: String,
    current: u64,
    total: u64,
}

async fn get_json(url: &str) -> Result<Value, String> {
    let client = Client::builder().timeout(LOOKUP_TIMEOUT).build().map_err(|e| e.to_string())?;
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

fn release_info(tag: Option<&str>, assets: &[(&str, &str)], description: Option<&str>) -> Result<UpdateInfo, String> {
    let (url, signature_url) = pick_zip(THIS_OS, assets).ok_or("latest release has no .zip for this OS")?;
    Ok(UpdateInfo {
        version: tag.ok_or("release has no tag_name")?.trim_start_matches('v').to_string(),
        url: url.to_string(),
        signature_url: signature_url.unwrap_or_default().to_string(),
        description: description.unwrap_or("").to_string(),
    })
}

async fn fetch_github() -> Result<UpdateInfo, String> {
    let release = get_json(GITHUB_RELEASES_API).await?;
    let assets = release["assets"].as_array().map(Vec::as_slice).unwrap_or_default();
    let assets: Vec<_> = assets.iter().filter_map(|a| Some((a["name"].as_str()?, a["browser_download_url"].as_str()?))).collect();
    release_info(release["tag_name"].as_str(), &assets, release["body"].as_str())
}

async fn fetch_gitlab() -> Result<UpdateInfo, String> {
    let release = get_json(GITLAB_RELEASES_API).await?;
    // `assets.links` are the files attached to the release; `assets.sources` is GitLab's own source archive, not ours.
    let links = release["assets"]["links"].as_array().map(Vec::as_slice).unwrap_or_default();
    let assets: Vec<_> = links
        .iter()
        .filter_map(|l| Some((l["name"].as_str()?, l["direct_asset_url"].as_str().or_else(|| l["url"].as_str())?)))
        .collect();
    release_info(release["tag_name"].as_str(), &assets, release["description"].as_str())
}

/// The latest release of every source that answered, newest first (GitHub first on a tie).
async fn fetch_releases() -> Result<Vec<(&'static str, UpdateInfo)>, String> {
    let (github, gitlab) = tokio::join!(fetch_github(), fetch_gitlab());
    sort_releases(github, gitlab)
}

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
    newest_first(&mut releases, |r| &r.1.version); // on equal versions GitHub (pushed first) stays first
    Ok(releases)
}

fn is_newer_than_running(update: &UpdateInfo) -> bool {
    parse_version(&update.version) > parse_version(env!("CARGO_PKG_VERSION"))
}

/// The newest release (GitHub or GitLab) whether or not it is newer than the running build: the
/// launcher's "What's new" card shows its notes.
#[tauri::command]
pub async fn get_latest_release() -> Result<UpdateInfo, String> {
    Ok(fetch_releases().await?.remove(0).1)
}

/// Returns the newest release (GitHub or GitLab) when it is newer than the running build, otherwise None.
#[tauri::command]
pub async fn check_for_update() -> Result<Option<UpdateInfo>, String> {
    let (_, newest) = fetch_releases().await?.remove(0);
    Ok(is_newer_than_running(&newest).then_some(newest))
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

    // Newest first; if a source's download or archive is bad, the next gets its turn. Everything
    // is unpacked aside first, so a bad zip fails before any launcher file is touched.
    let mut errors = Vec::new();
    let mut staged = None;
    for (host, update) in candidates {
        match stage_update(&window, &update, &archive_path, &staging).await {
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

/// Downloads the zip and unpacks it aside. Nothing from a bad or truncated download is ever
/// unpacked, let alone run. Cloud downloads (GitHub/GitLab) are trusted as-is and are not asked
/// for a `.sig`.
async fn stage_update(window: &tauri::Window, update: &UpdateInfo, archive_path: &Path, staging: &Path) -> Result<(), String> {
    let digest = download_with_progress(window, &update.url, &archive_path.to_path_buf()).await?;

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

/// Saves `url` to `dest` and returns the SHA-256 of what arrived.
async fn download_with_progress(window: &tauri::Window, url: &str, dest: &PathBuf) -> Result<[u8; 32], String> {
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
    let mut hasher = Sha256::new();

    // No total timeout (the archive can be big), but a stalled connection must not hang forever.
    while let Some(chunk) = tokio::time::timeout(STALL_TIMEOUT, stream.next())
        .await
        .map_err(|_| "Download stalled".to_string())?
    {
        let chunk = chunk.map_err(|e| format!("Download interrupted: {e}"))?;
        hasher.update(&chunk);
        file.write_all(&chunk).await.map_err(|e| e.to_string())?;
        downloaded += chunk.len() as u64;
        emit_progress(window, "downloading", downloaded, total);
    }
    file.flush().await.map_err(|e| e.to_string())?;
    Ok(hasher.finalize().into())
}

fn emit_progress(window: &tauri::Window, status: &str, current: u64, total: u64) {
    let _ = window.emit(
        "update-progress",
        UpdateProgress { status: status.to_string(), current, total },
    );
}

/// The files under `dir`, as paths relative to it.
fn staged_files(dir: &Path, relative: &Path, out: &mut Vec<PathBuf>) -> Result<(), String> {
    for entry in std::fs::read_dir(dir).map_err(|e| e.to_string())?.flatten() {
        let rel = relative.join(entry.file_name());
        if entry.path().is_dir() {
            staged_files(&entry.path(), &rel, out)?;
        } else {
            out.push(rel);
        }
    }
    Ok(())
}

fn set_aside_name(path: &Path) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(".old");
    path.with_file_name(name)
}

/// Puts the staged file `from` at `to`. A file already there is first renamed to `<name>.old`:
/// Windows allows that for our own running .exe and the loaded module DLLs, though not an overwrite.
/// `done` records what was installed, with whether an old file was set aside, for `undo`.
fn install_one(from: &Path, to: &Path, done: &mut Vec<(PathBuf, bool)>) -> Result<(), String> {
    if let Some(parent) = to.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("cannot create '{}': {e}", parent.display()))?;
    }
    let old = set_aside_name(to);
    let set_aside = to.exists();
    if set_aside {
        let _ = std::fs::remove_file(&old);
        std::fs::rename(to, &old).map_err(|e| format!("'{}' cannot be replaced: {e}", to.display()))?;
    }
    // The staging folder is inside the launcher's, so this is a rename; copy only if that is refused.
    if let Err(e) = std::fs::rename(from, to).or_else(|_| std::fs::copy(from, to).map(|_| ())) {
        if set_aside {
            let _ = std::fs::rename(&old, to);
        }
        return Err(format!("cannot write '{}': {e}", to.display()));
    }
    done.push((to.to_path_buf(), set_aside));
    Ok(())
}

fn undo(done: &[(PathBuf, bool)]) {
    for (path, set_aside) in done.iter().rev() {
        let _ = std::fs::remove_file(path);
        if *set_aside {
            let _ = std::fs::rename(set_aside_name(path), path);
        }
    }
}

/// Puts every file under `staged` over the same relative path in `target`, all or nothing: if any
/// file cannot be put in place, the ones done so far are taken back out, so a launcher is never left
/// half old and half new (a new module next to an old exe).
fn apply_staged(staged: &Path, target: &Path) -> Result<(), String> {
    let mut files = Vec::new();
    staged_files(staged, Path::new(""), &mut files)?;
    files.sort();
    let mut done = Vec::new();
    for rel in &files {
        if let Err(e) = install_one(&staged.join(rel), &target.join(rel), &mut done) {
            undo(&done);
            return Err(e);
        }
    }
    // Old files still locked (our own .exe) stay as `.old` and go at the next start.
    for (path, set_aside) in &done {
        if *set_aside {
            let _ = std::fs::remove_file(set_aside_name(path));
        }
    }
    Ok(())
}

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

#[cfg(test)]
mod tests {
    use super::*;

    fn release(version: &str) -> UpdateInfo {
        release_info(Some(version), &[("a.zip", "https://x/a.zip")], None).unwrap()
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
    fn the_release_info_carries_the_zip_and_its_signature_or_none() {
        let signed = release_info(Some("v1.0.0"), &[("nihao.zip", "https://x/n.zip"), ("nihao.zip.sig", "https://x/n.zip.sig")], Some("notes")).unwrap();
        assert_eq!((signed.version.as_str(), signed.url.as_str(), signed.signature_url.as_str()), ("1.0.0", "https://x/n.zip", "https://x/n.zip.sig"));
        assert!(release_info(Some("v1.0.0"), &[("n.zip", "https://x/n.zip")], None).unwrap().signature_url.is_empty());
        assert!(release_info(Some("v1.0.0"), &[("notes.txt", "https://x/notes.txt")], None).is_err());
    }

    fn write(path: &Path, content: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, content).unwrap();
    }

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("nihao-update-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn an_update_replaces_and_adds_files_and_leaves_no_old_ones() {
        let root = scratch("apply");
        let (staged, target) = (root.join("staged"), root.join("app"));
        write(&staged.join("launcher.exe"), "new exe");
        write(&staged.join("plugins/mod.dll"), "new dll");
        write(&target.join("launcher.exe"), "old exe");
        apply_staged(&staged, &target).unwrap();
        assert_eq!(std::fs::read_to_string(target.join("launcher.exe")).unwrap(), "new exe");
        assert_eq!(std::fs::read_to_string(target.join("plugins/mod.dll")).unwrap(), "new dll");
        assert!(!target.join("launcher.exe.old").exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn an_update_that_fails_halfway_puts_every_old_file_back() {
        let root = scratch("rollback");
        let (staged, target) = (root.join("staged"), root.join("app"));
        write(&staged.join("a.txt"), "new a");
        write(&staged.join("x/y.txt"), "new y");
        write(&target.join("a.txt"), "old a");
        write(&target.join("x"), "a file where the update needs a folder");
        assert!(apply_staged(&staged, &target).is_err());
        assert_eq!(std::fs::read_to_string(target.join("a.txt")).unwrap(), "old a", "the first file is back as it was");
        assert!(!target.join("a.txt.old").exists());
        assert_eq!(std::fs::read_to_string(target.join("x")).unwrap(), "a file where the update needs a folder");
        let _ = std::fs::remove_dir_all(&root);
    }
}
