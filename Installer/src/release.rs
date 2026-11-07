//! Release lookup and unpacking. Mirrors `src-tauri/src/updater.rs`: the newest release of this project
//! on GitHub and on GitLab; the newer one is tried first and the other one is the fallback, so one host
//! being down (or lagging behind) never blocks installing. A signed launcher zip placed next to the
//! installer is used instead of both, with no network at all.
use std::io::{Cursor, Read};
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::release_lookup::{newest_first, pick_zip, THIS_OS};
use crate::release_sig;

const GITHUB_RELEASES_API: &str = "https://api.github.com/repos/BogdanCater/nihao-launcher/releases/latest";
/// Project path `BogdanCater/nihao-launcher`, URL-encoded as the GitLab API wants it.
const GITLAB_RELEASES_API: &str =
    "https://gitlab.com/api/v4/projects/BogdanCater%2Fnihao-launcher/releases/permalink/latest";
/// The project's web address on GitLab: paths in a GitLab release description (`/uploads/…`) are relative to it.
pub const GITLAB_PROJECT: &str = "https://gitlab.com/BogdanCater/nihao-launcher";
/// A lookup or a download that makes no progress for this long counts as a failure, so the other
/// host gets its turn instead of the installer waiting forever.
const STALL_TIMEOUT: Duration = Duration::from_secs(20);
/// The `host` of the archive found next to the installer; its `url` and `signature_url` are file paths.
pub const LOCAL: &str = "this folder";

#[derive(Clone)]
pub struct Release {
    pub host: &'static str,
    pub version: String,
    pub url: String,
    /// The `.sig` asset next to the zip; empty when the release has none (then it is refused).
    pub signature_url: String,
    /// The release description from the host ("what changed"), markdown; empty if none was written.
    pub notes: String,
}

impl Release {
    fn is_local(&self) -> bool {
        self.host == LOCAL
    }
}

pub struct Installed {
    pub version: String,
    pub dir: PathBuf,
    /// The launcher executable (first executable in the zip root), if the zip has one.
    pub exe: Option<PathBuf>,
}

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(STALL_TIMEOUT)
        .timeout_read(STALL_TIMEOUT)
        .user_agent("nihao-installer") // GitHub rejects requests without one
        .build()
}

fn get_json(url: &str) -> Result<Value, String> {
    agent()
        .get(url)
        .call()
        .map_err(|e| format!("release lookup failed: {e}"))?
        .into_json()
        .map_err(|e| format!("invalid response: {e}"))
}

fn release_from(
    host: &'static str,
    tag: Option<&str>,
    zip: Option<(&str, Option<&str>)>,
    notes: Option<&str>,
) -> Result<Release, String> {
    let (url, signature_url) = zip.ok_or("latest release has no .zip for this OS")?;
    Ok(Release {
        host,
        version: tag.ok_or("release has no tag_name")?.trim_start_matches('v').to_string(),
        url: url.to_string(),
        signature_url: signature_url.unwrap_or_default().to_string(),
        notes: notes.unwrap_or_default().trim().to_string(),
    })
}

fn github_release(os: &str, release: &Value) -> Result<Release, String> {
    let assets = release["assets"].as_array().map(Vec::as_slice).unwrap_or_default();
    let assets: Vec<_> = assets.iter().filter_map(|a| Some((a["name"].as_str()?, a["browser_download_url"].as_str()?))).collect();
    release_from("GitHub", release["tag_name"].as_str(), pick_zip(os, &assets), release["body"].as_str())
}

fn gitlab_release(os: &str, release: &Value) -> Result<Release, String> {
    // `assets.links` are the files attached to the release; `assets.sources` is GitLab's own source archive, not ours.
    let links = release["assets"]["links"].as_array().map(Vec::as_slice).unwrap_or_default();
    let assets: Vec<_> = links
        .iter()
        .filter_map(|l| Some((l["name"].as_str()?, l["direct_asset_url"].as_str().or_else(|| l["url"].as_str())?)))
        .collect();
    release_from("GitLab", release["tag_name"].as_str(), pick_zip(os, &assets), release["description"].as_str())
}

fn fetch_github() -> Result<Release, String> {
    github_release(THIS_OS, &get_json(GITHUB_RELEASES_API)?)
}

fn fetch_gitlab() -> Result<Release, String> {
    gitlab_release(THIS_OS, &get_json(GITLAB_RELEASES_API)?)
}

/// The version in an archive's file name (`nihao-launcher-windows-x64-0.2.0.zip` -> `0.2.0`): the first
/// `-`/`_` separated part of digits and dots. The signature covers the version and a zip does not say it.
// shortcut: a suffix like `-beta` is cut off, so such a release needs a name that is its whole tag.
fn version_in(name: &str) -> Option<String> {
    name.trim_end_matches(".zip")
        .split(['-', '_'])
        .map(|part| part.trim_start_matches('v'))
        .find(|part| part.contains('.') && part.split('.').all(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit())))
        .map(str::to_string)
}

/// The launcher archive placed in `dir`: a zip for `os` (named like a release asset) with its `.sig`. A zip
/// without a signature is not ours and is ignored, so `None` (look online) is the common answer.
fn local_in(dir: &Path, os: &str) -> Option<Result<Release, String>> {
    let mut names: Vec<String> =
        std::fs::read_dir(dir).ok()?.flatten().filter(|e| e.path().is_file()).filter_map(|e| e.file_name().into_string().ok()).collect();
    names.sort();
    // A zip without a signature must not hide a signed one that sorts after it.
    let all = names.clone();
    names.retain(|n| !n.ends_with(".zip") || all.contains(&format!("{n}.sig")));
    // The bare file name stands in for the address, so a folder called "linux" cannot decide which OS a zip is for.
    let assets: Vec<_> = names.iter().map(|n| (n.as_str(), n.as_str())).collect();
    let (zip, signature) = pick_zip(os, &assets)?;
    let signature = signature?;
    let path = |name: &str| dir.join(name).display().to_string();
    let version = version_in(zip).ok_or_else(|| {
        format!("'{zip}' next to the installer needs its version in the file name, e.g. nihao-launcher-{os}-x64-0.2.0.zip")
    });
    Some(version.map(|version| Release {
        host: LOCAL,
        version,
        url: path(zip),
        signature_url: path(signature),
        notes: String::new(),
    }))
}

/// The archive next to this program, if any (see `local_in`).
fn local() -> Option<Result<Release, String>> {
    local_in(std::env::current_exe().ok()?.parent()?, THIS_OS)
}

/// The archive next to the installer if there is one, else the latest release of every host that
/// answered, newest first (GitHub first on a tie).
pub fn latest() -> Result<Vec<Release>, String> {
    if let Some(local) = local() {
        return local.map(|release| vec![release]);
    }
    let (github, gitlab) = std::thread::scope(|s| {
        let github = s.spawn(fetch_github);
        let gitlab = fetch_gitlab();
        (github.join().expect("lookup thread panicked"), gitlab)
    });
    sort_releases(github, gitlab)
}

/// Fails only when no host answered, naming why each one failed.
fn sort_releases(github: Result<Release, String>, gitlab: Result<Release, String>) -> Result<Vec<Release>, String> {
    let (mut releases, mut errors) = (Vec::new(), Vec::new());
    for (host, result) in [("GitHub", github), ("GitLab", gitlab)] {
        match result {
            Ok(release) => releases.push(release),
            Err(e) => errors.push(format!("{host}: {e}")),
        }
    }
    if releases.is_empty() {
        return Err(errors.join("; "));
    }
    newest_first(&mut releases, |r| &r.version); // on equal versions GitHub (pushed first) stays first
    Ok(releases)
}

/// Downloads `url` into memory, reporting `(downloaded, total)` as it goes (`total` is 0 when unknown).
/// A file that turns out bigger than `limit` bytes is refused.
// shortcut: the whole archive is held in memory, fine for tens of MB; switch to a temp file if releases pass ~200 MB.
pub fn download(url: &str, limit: usize, mut progress: impl FnMut(u64, u64)) -> Result<Vec<u8>, String> {
    let response = agent().get(url).call().map_err(|e| format!("download failed: {e}"))?;
    let total: u64 = response.header("Content-Length").and_then(|v| v.parse().ok()).unwrap_or(0);
    if total > limit as u64 {
        return Err(format!("file is too large ({total} bytes)"));
    }
    let mut reader = response.into_reader();
    let (mut data, mut chunk) = (Vec::new(), [0u8; 64 * 1024]);
    loop {
        let n = reader.read(&mut chunk).map_err(|e| format!("download interrupted: {e}"))?;
        if n == 0 {
            break;
        }
        data.extend_from_slice(&chunk[..n]);
        if data.len() > limit {
            return Err("file is too large".to_string());
        }
        progress(data.len() as u64, total);
    }
    if total != 0 && data.len() as u64 != total {
        return Err("download cut short".to_string());
    }
    Ok(data)
}

/// The bytes at `url`: read from disk for the local archive, downloaded otherwise.
fn fetch(release: &Release, url: &str, limit: usize, progress: impl FnMut(u64, u64)) -> Result<Vec<u8>, String> {
    if release.is_local() {
        std::fs::read(url).map_err(|e| format!("cannot read '{url}': {e}"))
    } else {
        download(url, limit, progress)
    }
}

fn is_executable(path: &Path, mode: Option<u32>) -> bool {
    if cfg!(windows) {
        path.extension().is_some_and(|e| e.eq_ignore_ascii_case("exe"))
    } else {
        mode.is_some_and(|m| m & 0o111 != 0)
    }
}

/// Unpacks the zip into `dir`. Every entry is read once up front (which checks its CRC), so a bad or
/// truncated archive fails before anything is written to `dir`. Returns the launcher executable.
fn unpack(data: Vec<u8>, dir: &Path) -> Result<Option<PathBuf>, String> {
    let mut zip = zip::ZipArchive::new(Cursor::new(data)).map_err(|e| format!("bad archive: {e}"))?;
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|e| format!("bad archive: {e}"))?;
        std::io::copy(&mut entry, &mut std::io::sink()).map_err(|e| format!("bad archive: {e}"))?;
    }

    let mut exe = None;
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|e| e.to_string())?;
        let Some(relative) = entry.enclosed_name() else { continue }; // skips `../` escapes
        let out_path = dir.join(&relative);
        if entry.is_dir() {
            std::fs::create_dir_all(&out_path).map_err(|e| e.to_string())?;
            continue;
        }
        if let Some(parent) = out_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut out = std::fs::File::create(&out_path)
            .map_err(|e| format!("cannot write '{}': {e}", out_path.display()))?;
        std::io::copy(&mut entry, &mut out).map_err(|e| e.to_string())?;
        drop(out);

        let mode = entry.unix_mode();
        #[cfg(unix)]
        if let Some(mode) = mode {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&out_path, std::fs::Permissions::from_mode(mode & 0o777))
                .map_err(|e| e.to_string())?;
        }
        if exe.is_none() && relative.components().count() == 1 && is_executable(&relative, mode) {
            exe = Some(out_path);
        }
    }
    Ok(exe)
}

/// Nothing is unpacked unless the maintainer's signature on exactly this download checks out
/// (`release_sig`). Only an archive placed next to the installer (`host == LOCAL`) is checked this
/// way: a `.sig` next to it is required, and a missing or bad one refuses the file. Archives
/// downloaded from GitHub or GitLab are trusted as-is and are not signed, so no `.sig` is asked
/// for them.
fn check_signature(release: &Release, zip: &[u8]) -> Result<(), String> {
    if !release.is_local() {
        return Ok(());
    }
    if release.signature_url.is_empty() {
        return Err("this release has no .sig file next to its zip, so it cannot be trusted".to_string());
    }
    let signature = fetch(release, &release.signature_url, 1024, |_, _| {})?;
    let signature = String::from_utf8(signature).map_err(|_| "the release signature file is not text".to_string())?;
    release_sig::verify(&release.version, &Sha256::digest(zip), &signature)
}

/// Installs the first of `releases` (from [`latest`]) that downloads and unpacks into `dir`, and returns it
/// with what was installed. `status(text, done, total)` reports progress; a host whose download or archive
/// turns out bad gives way to the next one.
pub fn install(
    dir: &Path,
    releases: Vec<Release>,
    status: impl Fn(&str, u64, u64),
) -> Result<(Installed, Release), String> {
    let mut errors = Vec::new();
    for release in releases {
        let text = if release.is_local() {
            format!("Reading {}…", release.version)
        } else {
            format!("Downloading {} from {}…", release.version, release.host)
        };
        status(&text, 0, 0);
        let result = fetch(&release, &release.url, usize::MAX, |done, total| status(&text, done, total)).and_then(|data| {
            status("Checking the signature…", 0, 0);
            check_signature(&release, &data)?;
            status("Installing…", 0, 0);
            std::fs::create_dir_all(dir).map_err(|e| format!("cannot create '{}': {e}", dir.display()))?;
            unpack(data, dir)
        });
        match result {
            Ok(exe) => {
                return Ok((Installed { version: release.version.clone(), dir: dir.to_path_buf(), exe }, release));
            }
            Err(e) => errors.push(format!("{} {}: {e}", release.host, release.version)),
        }
    }
    Err(errors.join("; "))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use zip::write::SimpleFileOptions;

    fn release(host: &'static str, version: &str) -> Release {
        release_from(host, Some(version), Some(("https://x/a.zip", None)), None).unwrap()
    }

    fn hosts(github: Result<Release, String>, gitlab: Result<Release, String>) -> Vec<&'static str> {
        sort_releases(github, gitlab).unwrap().into_iter().map(|r| r.host).collect()
    }

    fn sample_zip() -> Vec<u8> {
        let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let stored = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
        for (name, mode) in [("app.exe", 0o755), ("readme.txt", 0o644), ("lang/en.json", 0o644), ("../evil.txt", 0o644)] {
            zip.start_file(name, stored.unix_permissions(mode)).unwrap();
            zip.write_all(b"payload payload").unwrap();
        }
        zip.finish().unwrap().into_inner()
    }

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("nihao-installer-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn the_newer_host_wins_and_github_wins_a_tie() {
        assert_eq!(hosts(Ok(release("GitHub", "0.2.0")), Ok(release("GitLab", "0.3.0"))), ["GitLab", "GitHub"]);
        assert_eq!(hosts(Ok(release("GitHub", "0.3.0")), Ok(release("GitLab", "0.2.0"))), ["GitHub", "GitLab"]);
        assert_eq!(hosts(Ok(release("GitHub", "0.3.0")), Ok(release("GitLab", "0.3.0"))), ["GitHub", "GitLab"]);
    }

    fn touch(dir: &Path, names: &[&str]) {
        for name in names {
            std::fs::write(dir.join(name), "x").unwrap();
        }
    }

    #[test]
    fn a_signed_zip_for_this_os_next_to_the_installer_is_the_release() {
        let dir = scratch("local");
        touch(&dir, &["notes.zip", "nihao-linux-x64-0.2.0.zip", "nihao-linux-x64-0.2.0.zip.sig", "nihao-windows-x64-0.3.1.zip", "nihao-windows-x64-0.3.1.zip.sig"]);
        let release = local_in(&dir, "windows").unwrap().unwrap();
        assert_eq!((release.host, release.version.as_str()), (LOCAL, "0.3.1"));
        assert_eq!(release.url, dir.join("nihao-windows-x64-0.3.1.zip").display().to_string());
        assert_eq!(release.signature_url, format!("{}.sig", release.url));
        assert_eq!(local_in(&dir, "linux").unwrap().unwrap().version, "0.2.0");
        assert!(local_in(&dir, "macos").is_none(), "the other OS's zip is not ours");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_unsigned_zip_is_ignored_and_one_without_a_version_is_reported() {
        let dir = scratch("local-unsigned");
        touch(&dir, &["nihao-windows-x64-0.3.1.zip", "other.zip"]);
        assert!(local_in(&dir, "windows").is_none(), "no .sig: some zip that happens to lie there");
        // The unsigned zip sorts first but does not hide the signed one, which lacks a version.
        touch(&dir, &["nihao-windows-x64.zip", "nihao-windows-x64.zip.sig"]);
        assert!(local_in(&dir, "windows").unwrap().err().unwrap().contains("version in the file name"));
        assert_eq!(version_in("nihao-launcher-windows-x64-v1.12.0.zip").as_deref(), Some("1.12.0"));
        assert_eq!(version_in("nihao_1.2.zip").as_deref(), Some("1.2"));
        assert_eq!(version_in("nihao-x64.zip"), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_local_archive_and_its_signature_are_read_from_disk() {
        let dir = scratch("local-read");
        touch(&dir, &["nihao-windows-0.3.1.zip", "nihao-windows-0.3.1.zip.sig"]);
        let release = local_in(&dir, "windows").unwrap().unwrap();
        assert_eq!(fetch(&release, &release.url, usize::MAX, |_, _| {}).unwrap(), b"x");
        assert!(check_signature(&release, b"x").unwrap_err().contains("not a valid signature"), "the .sig file was read and judged");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn one_host_failing_falls_back_to_the_other() {
        assert_eq!(hosts(Err("down".into()), Ok(release("GitLab", "0.3.0"))), ["GitLab"]);
        let both = sort_releases(Err("a".into()), Err("b".into())).err().unwrap();
        assert!(both.contains("GitHub: a") && both.contains("GitLab: b"));
    }

    #[test]
    fn a_release_without_a_signature_is_refused_before_anything_is_unpacked() {
        let unsigned = release(LOCAL, "0.2.0");
        assert!(unsigned.signature_url.is_empty());
        assert!(check_signature(&unsigned, b"zip bytes").unwrap_err().contains("no .sig"));
        // A cloud release with no .sig is installed as-is.
        let cloud = release("GitHub", "0.2.0");
        assert!(check_signature(&cloud, b"zip bytes").is_ok());
    }

    #[test]
    fn reads_the_github_and_gitlab_release_json() {
        let github = serde_json::json!({
            "tag_name": "v0.2.0",
            "body": "
## Fixed
- a crash
",
            "assets": [
                {"name": "notes.txt", "browser_download_url": "https://gh/notes.txt"},
                {"name": "nihao-windows.zip", "browser_download_url": "https://gh/nihao-windows.zip"}
            ]
        });
        let r = github_release("windows", &github).unwrap();
        assert_eq!((r.version.as_str(), r.url.as_str()), ("0.2.0", "https://gh/nihao-windows.zip"));
        assert_eq!(r.notes, "## Fixed
- a crash");
        assert!(github_release("linux", &github).is_err());

        let gitlab = serde_json::json!({
            "tag_name": "v0.2.0",
            "description": "Faster start",
            "assets": {
                "sources": [{"format": "zip", "url": "https://gl/source.zip"}],
                "links": [{"name": "nihao-linux.zip", "url": "https://gl/old", "direct_asset_url": "https://gl/nihao-linux.zip"}]
            }
        });
        let r = gitlab_release("linux", &gitlab).unwrap();
        assert_eq!((r.url.as_str(), r.notes.as_str()), ("https://gl/nihao-linux.zip", "Faster start"));
        assert!(gitlab_release("windows", &gitlab).is_err(), "GitLab's own source zip must not be picked");
    }

    #[test]
    fn download_returns_the_body_and_reports_progress() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/a.zip", listener.local_addr().unwrap());
        let body = sample_zip();
        let served = body.clone();
        std::thread::spawn(move || {
            let (mut conn, _) = listener.accept().unwrap();
            let _ = conn.read(&mut [0u8; 1024]);
            write!(conn, "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", served.len()).unwrap();
            conn.write_all(&served).unwrap();
        });
        let mut last = (0, 0);
        let data = download(&url, usize::MAX, |done, total| last = (done, total)).unwrap();
        assert_eq!(data, body);
        assert_eq!(last, (body.len() as u64, body.len() as u64));
    }

    #[test]
    fn download_refuses_a_file_over_the_limit() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/big", listener.local_addr().unwrap());
        std::thread::spawn(move || {
            let (mut conn, _) = listener.accept().unwrap();
            let _ = conn.read(&mut [0u8; 1024]);
            let _ = write!(conn, "HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n");
            let _ = conn.write_all(&[7u8; 4096]);
        });
        assert!(download(&url, 1000, |_, _| {}).unwrap_err().contains("too large"));
    }

    #[test]
    fn unpack_writes_the_files_and_finds_the_exe() {
        let root = scratch("ok");
        let dir = root.join("install");
        let exe = unpack(sample_zip(), &dir).unwrap();
        assert_eq!(exe, Some(dir.join("app.exe")));
        assert!(dir.join("lang").join("en.json").is_file());
        assert!(!root.join("evil.txt").exists(), "`../` entry escaped the install folder");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_corrupt_archive_fails_before_anything_is_written() {
        let root = scratch("bad");
        let dir = root.join("install");
        let mut data = sample_zip();
        data[40] ^= 0xFF;
        assert!(unpack(data, &dir).is_err());
        assert!(!dir.exists());
        let _ = std::fs::remove_dir_all(&root);
    }
}
