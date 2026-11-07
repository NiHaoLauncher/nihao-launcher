//! The NiHao Minecraft Client mod (github.com/NiHaoLauncher/nihao-minecraft-client, mirrored on
//! gitlab.com/nihaolauncher/nihao-minecraft-client): looks up its newest release build for a loader
//! + game version on both hosts, installs it into an instance's `mods/`, and tells whether an
//! instance has it and whether a newer build is out.
use std::path::Path;
use std::time::Duration;

use serde::Serialize;

use crate::library::install::{download_checked, HTTP};

const GITHUB_RELEASES_URL: &str = "https://api.github.com/repos/NiHaoLauncher/nihao-minecraft-client/releases";
/// Project path `nihaolauncher/nihao-minecraft-client`, URL-encoded as the GitLab API wants it.
const GITLAB_RELEASES_URL: &str = "https://gitlab.com/api/v4/projects/nihaolauncher%2Fnihao-minecraft-client/releases";
const FILE_PREFIX: &str = "nihao-";
/// A lookup that takes longer means "no answer from this host", so the other one gets its turn.
const LOOKUP_TIMEOUT: Duration = Duration::from_secs(6);

/// One release asset built for exactly one loader + game version (`nihao-fabric-0.1.0+1.21.1.jar`).
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct NihaoClientBuild {
    /// The mod's own version (`0.1.0`), not the game's.
    pub version: String,
    pub file_name: String,
    pub url: String,
    /// Hex SHA-256 from GitHub's asset `digest`; empty when the host doesn't give one.
    pub sha256: String,
    /// `"GitHub"` or `"GitLab"`: where this build is downloaded from.
    pub host: &'static str,
}

/// The numbers of a version, to compare two of them (`0.10.0` is newer than `0.9.1`); anything
/// that is not a digit only separates them, so `0.1.0-alpha` reads as `0.1.0`.
fn version_key(version: &str) -> Vec<u64> {
    version.split(|c: char| !c.is_ascii_digit()).filter(|p| !p.is_empty()).filter_map(|p| p.parse().ok()).collect()
}

/// `(name, url, sha256)` of each file attached to a release: GitHub lists them in `assets`, GitLab in `assets.links`.
fn release_files(release: &serde_json::Value) -> Vec<(&str, &str, &str)> {
    let github = release["assets"].as_array().map(|a| {
        a.iter().filter_map(|f| Some((f["name"].as_str()?, f["browser_download_url"].as_str()?, f["digest"].as_str().and_then(|d| d.strip_prefix("sha256:")).unwrap_or_default()))).collect()
    });
    github.unwrap_or_else(|| {
        release["assets"]["links"].as_array().map_or_else(Vec::new, |links| {
            links.iter().filter_map(|l| Some((l["name"].as_str()?, l["direct_asset_url"].as_str().or_else(|| l["url"].as_str())?, ""))).collect()
        })
    })
}

/// The newest release's build for `loader` + `mc_version` among one host's `releases`.
/// Releases are tried newest first, so a version dropped from a later release still resolves to the
/// last one that had it; pre-releases count (the mod has only had alphas so far).
/// shortcut: the mod's required loader version isn't checked (the file name doesn't carry it),
/// read it from the jar's `fabric.mod.json` if a build ever needs a newer loader than the pack has.
fn pick_build(releases: &serde_json::Value, host: &'static str, loader: &str, mc_version: &str) -> Option<NihaoClientBuild> {
    let prefix = format!("{FILE_PREFIX}{loader}-");
    releases.as_array()?.iter().filter(|r| r["draft"] != true && r["upcoming_release"] != true).find_map(|release| {
        release_files(release).into_iter().find_map(|(file_name, url, sha256)| {
            let (version, game) = file_name.strip_prefix(&prefix)?.strip_suffix(".jar")?.rsplit_once('+')?;
            (game == mc_version && !url.is_empty()).then(|| NihaoClientBuild {
                version: version.to_string(),
                file_name: file_name.to_string(),
                url: url.to_string(),
                sha256: sha256.to_string(),
                host,
            })
        })
    })
}

async fn fetch_releases(url: &str) -> Result<serde_json::Value, String> {
    HTTP.get(url).timeout(LOOKUP_TIMEOUT).send().await
        .and_then(|r| r.error_for_status())
        .map_err(|e| format!("cannot reach {url}: {e}"))?
        .json().await
        .map_err(|e| format!("invalid answer from {url}: {e}"))
}

/// The builds each host has for `loader` + `mc_version`, newest first (GitHub first on a tie). Empty
/// when neither has one or can be reached.
pub async fn find_builds(loader: &str, mc_version: &str) -> Vec<NihaoClientBuild> {
    let (github, gitlab) = tokio::join!(fetch_releases(GITHUB_RELEASES_URL), fetch_releases(GITLAB_RELEASES_URL));
    let mut builds: Vec<_> = [(github, "GitHub"), (gitlab, "GitLab")]
        .into_iter()
        .filter_map(|(releases, host)| pick_build(&releases.ok()?, host, loader, mc_version))
        .collect();
    builds.sort_by(|a, b| version_key(&b.version).cmp(&version_key(&a.version))); // stable: on a tie GitHub stays first
    builds
}

/// The newest build for `loader` + `mc_version`; `None` when no host has one (or can be reached).
pub async fn find_build(loader: &str, mc_version: &str) -> Option<NihaoClientBuild> {
    find_builds(loader, mc_version).await.into_iter().next()
}

/// Whether `file_name` is a NiHao Client jar (`nihao-<loader>-<version>+<game>.jar`).
fn is_client_jar(file_name: &str) -> bool {
    let name = file_name.to_lowercase();
    name.starts_with(FILE_PREFIX) && name.ends_with(".jar")
}

/// The version of the NiHao Client jar in the instance's `mods/`, read from its file name;
/// `None` when there is none. A jar renamed by hand has no version to read: it still counts as
/// installed (`is_installed`), just never as out of date.
pub fn installed_version(instance_dir: &Path) -> Option<String> {
    std::fs::read_dir(instance_dir.join("mods")).into_iter().flatten().flatten().find_map(|e| {
        let name = e.file_name().to_string_lossy().into_owned();
        if !is_client_jar(&name) {
            return None;
        }
        // `nihao-<loader>-<version>+<game>.jar`: the version may itself hold dashes (`0.1.0-alpha`).
        let (_, rest) = name.get(FILE_PREFIX.len()..)?.split_once('-')?;
        Some(rest.rsplit_once('+')?.0.to_string())
    })
}

/// Whether the instance's `mods/` holds a NiHao Client jar.
pub fn is_installed(instance_dir: &Path) -> bool {
    std::fs::read_dir(instance_dir.join("mods")).into_iter().flatten().flatten().any(|e| is_client_jar(&e.file_name().to_string_lossy()))
}

/// Whether `latest` is a newer version than the `installed` one.
pub fn is_newer(latest: &str, installed: &str) -> bool {
    version_key(latest) > version_key(installed)
}

/// Downloads the build for `loader` + `mc_version` into the instance's `mods/` and only then
/// removes the older NiHao Client jar, so a failed download leaves the mod as it was. Each host's
/// build is tried in turn (newest first) until one downloads.
pub async fn install(instance_dir: &Path, loader: &str, mc_version: &str) -> Result<NihaoClientBuild, String> {
    let builds = find_builds(loader, mc_version).await;
    if builds.is_empty() {
        return Err(format!("NiHao Client has no build for {loader} {mc_version}"));
    }
    let mods = instance_dir.join("mods");
    let mut errors = Vec::new();
    for build in builds {
        match download_checked(&build.url, mods.join(&build.file_name), &build.sha256).await {
            Ok(()) => {
                for entry in std::fs::read_dir(&mods).into_iter().flatten().flatten() {
                    let name = entry.file_name().to_string_lossy().into_owned();
                    if is_client_jar(&name) && name != build.file_name {
                        let _ = std::fs::remove_file(entry.path());
                    }
                }
                return Ok(build);
            }
            Err(e) => errors.push(format!("{} {}: {e}", build.host, build.version)),
        }
    }
    Err(errors.join("; "))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn asset(name: &str) -> serde_json::Value {
        serde_json::json!({ "name": name, "browser_download_url": format!("https://x/{name}") })
    }

    #[test]
    fn picks_the_newest_release_with_the_exact_loader_and_game_version() {
        let releases = serde_json::json!([
            { "draft": true, "assets": [asset("nihao-fabric-0.3.0+1.21.1.jar")] },
            { "assets": [asset("nihao-fabric-0.2.0+1.21.1.jar"), asset("nihao-fabric-0.2.0+1.21.jar")] },
            { "assets": [asset("nihao-fabric-0.1.0+1.20.4.jar"), asset("nihao-fabric-0.1.0+1.21.1.jar")] },
        ]);
        assert_eq!(pick_build(&releases, "GitHub", "fabric", "1.21.1").unwrap().version, "0.2.0");
        assert_eq!(pick_build(&releases, "GitHub", "fabric", "1.21").unwrap().file_name, "nihao-fabric-0.2.0+1.21.jar");
        assert_eq!(pick_build(&releases, "GitHub", "fabric", "1.20.4").unwrap().version, "0.1.0");
        assert!(pick_build(&releases, "GitHub", "fabric", "1.19.4").is_none());
        assert!(pick_build(&releases, "GitHub", "neoforge", "1.21.1").is_none());
    }

    #[test]
    fn reads_a_gitlab_release_whose_files_are_links() {
        let releases = serde_json::json!([
            { "upcoming_release": true, "assets": { "links": [{ "name": "nihao-fabric-9.0.0+1.21.1.jar", "direct_asset_url": "https://g/9" }] } },
            { "assets": { "sources": [], "links": [{ "name": "nihao-fabric-0.2.0+1.21.1.jar", "direct_asset_url": "https://g/a.jar" }] } },
            { "assets": { "links": [] } },
        ]);
        let build = pick_build(&releases, "GitLab", "fabric", "1.21.1").unwrap();
        assert_eq!((build.version.as_str(), build.url.as_str(), build.host), ("0.2.0", "https://g/a.jar", "GitLab"));
    }

    #[test]
    fn versions_compare_by_their_numbers_not_their_letters() {
        assert!(is_newer("0.10.0", "0.9.1"));
        assert!(is_newer("0.2.0", "0.1.0"));
        assert!(!is_newer("0.1.0", "0.1.0"));
        assert!(!is_newer("0.1.0", "0.1.1"));
        assert_eq!(installed_version(Path::new("/definitely/not/here")), None);
    }

    #[test]
    fn the_installed_version_is_read_from_the_jar_name() {
        let dir = std::env::temp_dir().join(format!("nihao-client-test-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("mods")).unwrap();
        std::fs::write(dir.join("mods/other-mod-1.0.jar"), b"").unwrap();
        assert_eq!(installed_version(&dir), None);
        assert!(!is_installed(&dir));
        std::fs::write(dir.join("mods/nihao-fabric-0.1.0-alpha+1.21.1.jar"), b"").unwrap();
        assert_eq!(installed_version(&dir).as_deref(), Some("0.1.0-alpha"));
        assert!(is_installed(&dir));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
