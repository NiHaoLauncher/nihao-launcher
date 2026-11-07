//! Online content services (Modrinth, ...): where "Browse content" and the Modpack market search,
//! show and download from. A service is one `ContentService` impl listed in `all()`; the UI
//! discovers it through `list_content_services` and every command takes its `id`. Adding one is a
//! new file here, one line in `all()` and `ui/src/assets/minecraft/services/<id>.png` (its logo).

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use async_trait::async_trait;
use reqwest::Client;
use serde::{Deserialize, Serialize};

use super::export::{ExportProgress, ProgressCallback};
use super::modpack_format::safe_join;

pub mod curseforge;
pub mod modrinth;

/// The HTTP client for every service request. Modrinth's API asks for a uniquely identifying
/// `User-Agent` (a library default risks being blocked), and the CDNs see it on downloads too.
fn http() -> Client {
    Client::builder()
        .user_agent(concat!("NiHao/minecraft-plugin/", env!("CARGO_PKG_VERSION")))
        .build()
        .unwrap_or_else(|_| Client::new())
}

/// How the UI presents a service and which filters it offers.
#[derive(Serialize)]
pub struct ServiceInfo {
    /// Stable key: used in commands, in `ModpackSource::service` and as the logo file name.
    pub id: &'static str,
    pub name: &'static str,
    /// Instance-content categories it can browse and install (`mods`, `resourcepacks`, ...).
    pub content: &'static [&'static str],
    /// Whether it hosts whole modpacks (the Modpack market).
    pub modpacks: bool,
    /// Values `SearchQuery::sort` accepts; the UI offers them besides "relevance" (empty = default).
    pub sorts: &'static [&'static str],
    /// Values `SearchQuery::environments` accepts; empty hides the Environment filter.
    pub environments: &'static [&'static str],
}

#[derive(Default)]
pub struct SearchQuery {
    /// An instance-content category, or `"modpacks"` for the market.
    pub category: String,
    pub query: String,
    /// Empty = any version.
    pub minecraft_version: String,
    /// The instance's loader, applied to mods only. Empty = any.
    pub loader: String,
    pub offset: u32,
    pub limit: u32,
    /// One of `ServiceInfo::sorts`, empty for the service's default.
    pub sort: String,
    /// Each of `categories`/`environments`/`loaders` is OR'd within itself, AND'd with the rest.
    pub categories: Vec<String>,
    pub environments: Vec<String>,
    /// For the market, where there is no instance loader yet.
    pub loaders: Vec<String>,
}

#[derive(Serialize, Clone)]
pub struct BrowseHit {
    pub project_id: String,
    pub title: String,
    pub description: String,
    pub icon_url: Option<String>,
    pub downloads: u64,
    pub author: String,
    /// Every author, `author` first: what tells the same pack on two services apart from a namesake.
    pub authors: Vec<String>,
    /// The service's short name for the project (its URL slug); empty if it has none.
    pub slug: String,
    /// The project's page on the service's own site.
    pub url: String,
    /// Every environment the project's versions support (e.g. `["client_and_server"]`).
    pub environment: Vec<String>,
    /// A curated UI subset of the project's categories.
    pub categories: Vec<String>,
    /// Gallery images (the featured one first, at most 6), for a large backdrop.
    pub gallery: Vec<String>,
    /// When it last changed (RFC 3339), if the service says.
    pub updated: Option<String>,
    /// Minecraft versions it supports, in no particular order.
    pub game_versions: Vec<String>,
    /// Lowercase loader names it supports (`fabric`, `forge`, `neoforge`, `quilt`).
    pub loaders: Vec<String>,
}

/// A page of results plus the service's total hit count, for "page X of Y" without a second request.
#[derive(Serialize)]
pub struct BrowseSearchResult {
    pub hits: Vec<BrowseHit>,
    pub total_hits: u64,
}

/// One gallery screenshot (a CDN URL the webview loads directly, like hit icons).
#[derive(Serialize, Clone)]
pub struct GalleryImage {
    /// A downscaled copy: fine for thumbnails and banners.
    pub url: String,
    /// The original, for the full-size viewer and saving; `None` when the service only has one size.
    pub full_url: Option<String>,
    pub title: Option<String>,
}

/// The full project page (everything `BrowseHit` lacks) for the detail view. A service's own page
/// usually can't be embedded (`X-Frame-Options`), so this is built from the same data.
#[derive(Serialize, Clone)]
pub struct ProjectDetail {
    pub project_id: String,
    pub title: String,
    pub description: String,
    /// Raw Markdown (CommonMark), rendered client-side by a small from-scratch renderer, not an
    /// HTML-injecting one: it is untrusted third-party content.
    pub body: String,
    /// The project's page on the service's own site, for "Open in browser".
    pub url: String,
    pub icon_url: Option<String>,
    pub downloads: u64,
    pub followers: u64,
    pub categories: Vec<String>,
    pub environment: Vec<String>,
    pub license_name: Option<String>,
    pub license_url: Option<String>,
    pub source_url: Option<String>,
    pub issues_url: Option<String>,
    pub wiki_url: Option<String>,
    pub discord_url: Option<String>,
    pub gallery: Vec<GalleryImage>,
}

/// One build of a modpack project, for the version picker.
#[derive(Serialize, Clone)]
pub struct ModpackVersion {
    pub id: String,
    pub name: String,
    pub version_number: String,
    /// `"release"`, `"beta"` or `"alpha"`.
    pub version_type: String,
    pub game_versions: Vec<String>,
    pub loaders: Vec<String>,
    pub date_published: String,
    pub downloads: u64,
}

/// Which file of a project to fetch. `version_id` `None` = the newest one matching the filters.
#[derive(Default)]
pub struct FileRequest {
    pub category: String,
    pub project_id: String,
    pub version_id: Option<String>,
    /// Empty = no filter (a modpack carries its own versions).
    pub minecraft_version: String,
    /// The instance's loader, applied to mods only. Empty = any.
    pub loader: String,
}

/// A downloadable file. shortcut: SHA-1 only; give this an algorithm when a service lacks it.
pub struct RemoteFile {
    pub url: String,
    pub filename: String,
    pub sha1: String,
    /// Extra request headers the host wants (an API key); empty for most.
    pub headers: Vec<(&'static str, String)>,
}

/// A local file a service recognised by hash (see `ContentService::identify_files`).
#[derive(Clone)]
pub struct KnownFile {
    /// `ServiceInfo::id` of the service that matched it.
    pub service: &'static str,
    pub project_id: String,
    pub version_number: String,
    pub url: String,
    pub size: u64,
    pub sha512: Option<String>,
}

/// A file a modpack manifest names by id, for `ContentService::resolve_pack_files`.
pub struct PackFileRef {
    pub project_id: String,
    pub file_id: String,
}

/// Where a manifest-named file goes and where to fetch it.
pub struct PackFile {
    /// Relative to the instance (e.g. `mods/a.jar`).
    pub path: String,
    pub url: String,
    /// Empty if the service gave none: the download is then not verified.
    pub sha1: String,
    /// Extra request headers the host wants (an API key); empty for most.
    pub headers: Vec<(&'static str, String)>,
}

/// A file the service won't hand out: its author disabled downloads outside the service.
#[derive(Serialize, Deserialize, Clone)]
pub struct BlockedFile {
    /// Relative to the instance (e.g. `mods/a.jar`).
    pub path: String,
    pub sha1: String,
    /// What to call it for the player: its project's name.
    pub name: String,
    /// A link that starts the file's download in the player's browser.
    pub page_url: String,
}

/// What `ContentService::resolve_pack_files` found: files to download and files it can't give.
pub struct PackFiles {
    pub files: Vec<PackFile>,
    pub blocked: Vec<BlockedFile>,
}

/// What an installed-file list needs to show a recognised project.
pub struct ProjectBrief {
    pub title: String,
    pub icon_url: Option<String>,
}

#[async_trait]
pub trait ContentService: Send + Sync {
    fn info(&self) -> &'static ServiceInfo;

    /// Why it can't be used right now (e.g. its API key isn't configured), shown to the player next
    /// to the disabled service. Default: always usable.
    fn unavailable(&self) -> Option<&'static str> {
        None
    }

    async fn search(&self, query: &SearchQuery) -> Result<BrowseSearchResult, String>;

    /// The filter categories for `category`, in the service's own taxonomy.
    async fn categories(&self, category: &str) -> Result<Vec<String>, String>;

    async fn project(&self, project_id: &str) -> Result<ProjectDetail, String>;

    /// Picks the file `request` asks for; `install` and `download_modpack` do the fetching.
    async fn resolve_file(&self, request: &FileRequest) -> Result<RemoteFile, String>;

    /// Every build of a modpack, newest first. Only for services with `ServiceInfo::modpacks`.
    async fn modpack_versions(&self, _project_id: &str) -> Result<Vec<ModpackVersion>, String> {
        Err(format!("{} has no modpacks", self.info().name))
    }

    /// Resolves the files a modpack manifest names by id, in `refs` order. Only for services whose
    /// pack format works that way (CurseForge's `manifest.json`); `.mrpack` carries URLs instead.
    async fn resolve_pack_files(&self, _refs: &[PackFileRef]) -> Result<PackFiles, String> {
        Err(format!("{} packs can't be installed from a manifest", self.info().name))
    }

    /// Recognises local files by SHA-1 (at most `HASH_BATCH` per call). Best-effort: unknown
    /// hashes and failed requests are just absent. Default: recognises nothing.
    async fn identify_files(&self, _sha1s: &[String]) -> HashMap<String, KnownFile> {
        HashMap::new()
    }

    /// Title and icon for the projects `identify_files` returned. Best-effort, like it.
    async fn project_briefs(&self, _project_ids: &[String]) -> HashMap<String, ProjectBrief> {
        HashMap::new()
    }

    /// URL prefixes `fetch_icon` may download from; the URL comes from the frontend, so anything
    /// else is refused. Default: none.
    fn icon_prefixes(&self) -> &'static [&'static str] {
        &[]
    }

    /// An image of one of this service's projects (a gallery picture), for saving it to a file.
    /// Only `icon_prefixes` hosts, capped at 25 MB.
    async fn fetch_image(&self, url: &str) -> Result<Vec<u8>, String> {
        const MAX: u64 = 25 * 1024 * 1024;
        if !self.icon_prefixes().iter().any(|p| url.starts_with(p)) {
            return Err(format!("Only {} images can be saved.", self.info().name));
        }
        let response = http()
            .get(url)
            .send()
            .await
            .and_then(|r| r.error_for_status())
            .map_err(|e| format!("Cannot download the image: {}", e))?;
        if response.content_length().is_some_and(|n| n > MAX) {
            return Err("The image is too large.".to_string());
        }
        let bytes = response.bytes().await.map_err(|e| format!("Cannot download the image: {}", e))?;
        if bytes.len() as u64 > MAX {
            return Err("The image is too large.".to_string());
        }
        Ok(bytes.to_vec())
    }

    /// A modpack's icon, for the instance made from it. Capped at 5 MB; any failure just means "no
    /// icon".
    async fn fetch_icon(&self, url: &str) -> Option<Vec<u8>> {
        const MAX: usize = 5 * 1024 * 1024;
        if !self.icon_prefixes().iter().any(|p| url.starts_with(p)) {
            return None;
        }
        let response = http().get(url).send().await.ok()?;
        if !response.status().is_success() || response.content_length().is_some_and(|n| n > MAX as u64) {
            return None;
        }
        let bytes = response.bytes().await.ok()?;
        (bytes.len() <= MAX).then(|| bytes.to_vec())
    }
}

/// A vanilla/unset loader filters nothing; resourcepacks/shaders/datapacks aren't loader-specific.
fn mod_loader_filter(category: &str, loader: &str) -> Option<String> {
    let loader = loader.to_lowercase();
    (category == "mods" && loader != "vanilla" && !loader.is_empty()).then_some(loader)
}

/// Every service, in the order the UI lists them.
pub fn all() -> &'static [&'static dyn ContentService] {
    static SERVICES: [&dyn ContentService; 2] = [&modrinth::Modrinth, &curseforge::CurseForge];
    &SERVICES
}

pub fn get(id: &str) -> Result<&'static dyn ContentService, String> {
    all()
        .iter()
        .copied()
        .find(|s| s.info().id == id)
        .ok_or_else(|| format!("Unknown service '{}'", id))
}

/// Keeps each hash-lookup request modest: there's no reason to send a pack's whole file list at once.
const HASH_BATCH: usize = 200;

/// Asks every service about `sha1s`, batch by batch; the first to recognise a hash wins.
/// `on_batch(done, total)` fires before each batch (`total` is at least 1).
pub async fn identify_files(sha1s: &[String], on_batch: impl Fn(usize, usize)) -> HashMap<String, KnownFile> {
    let mut found: HashMap<String, KnownFile> = HashMap::new();
    let batches = sha1s.chunks(HASH_BATCH);
    let total = batches.len().max(1);
    for (i, batch) in batches.enumerate() {
        on_batch(i, total);
        for service in all() {
            let unknown: Vec<String> = batch.iter().filter(|h| !found.contains_key(*h)).cloned().collect();
            if unknown.is_empty() {
                break;
            }
            found.extend(service.identify_files(&unknown).await);
        }
    }
    found
}

/// Downloads `file` to `dest` through the install pipeline's downloader: streamed into `dest.part`
/// (a big modpack never sits in memory), given up on when the host stops sending, and kept only if
/// its SHA-1 is the service's own. A file the service gave no SHA-1 for is refused.
async fn download_verified(file: &RemoteFile, dest: PathBuf) -> Result<(), String> {
    if file.sha1.is_empty() {
        return Err(format!("'{}' has no checksum to verify it with", file.filename));
    }
    let headers: Vec<(&str, String)> = file.headers.iter().map(|(name, value)| (*name, value.clone())).collect();
    super::install::download_checked_with(&file.url, dest, &file.sha1, &headers).await.map_err(|e| {
        if e.contains("401") {
            format!("The host refused '{}': a valid API key is required.", file.filename)
        } else {
            e
        }
    })
}

const INSTALL_TOTAL_ETAPS: usize = 3;

fn install_progress(etap: &str, current_etaps: usize, status: &str, filename: &str) -> ExportProgress {
    ExportProgress {
        etap: etap.to_string(),
        current_etaps,
        total_etaps: INSTALL_TOTAL_ETAPS,
        current_file: 0,
        total_files: 0,
        status: status.to_string(),
        filename: filename.to_string(),
    }
}

/// Downloads the file `request` resolves to into `{instance_dir}/{request.category}` and returns
/// its name. `progress` feeds `install_state()` (the bottom bar) via `interface.rs`'s
/// `job_progress_callback`.
pub async fn install(
    service: &dyn ContentService,
    request: &FileRequest,
    instance_dir: &Path,
    progress: &ProgressCallback,
) -> Result<String, String> {
    progress(install_progress("Fetching version info", 0, "check", ""));
    let file = service.resolve_file(request).await?;

    let dir = instance_dir.join(&request.category);
    tokio::fs::create_dir_all(&dir).await.map_err(|e| format!("Cannot create '{}': {}", request.category, e))?;
    let dest = safe_join(&dir, &file.filename)?;

    progress(install_progress("Downloading", 1, "download", &file.filename));
    download_verified(&file, dest).await?;

    progress(install_progress("Installing", 2, "write", &file.filename));
    Ok(file.filename)
}

/// Downloads a modpack project's version `version_id` (the newest when `None`) into the OS temp
/// directory, for Create Modpack's Browse, which has no instance yet. The path goes straight into
/// the local-file import pipeline (`peek_modpack_file` then `import_modpack`): the pack's own
/// manifest decides game version and loader, so nothing is filtered here.
pub async fn download_modpack(service: &dyn ContentService, project_id: &str, version_id: Option<&str>) -> Result<PathBuf, String> {
    let request = FileRequest {
        category: "modpacks".to_string(),
        project_id: project_id.to_string(),
        version_id: version_id.map(str::to_string),
        ..Default::default()
    };
    let file = service.resolve_file(&request).await?;
    let dest = safe_join(&std::env::temp_dir(), &format!("{}{}-{}", DOWNLOADED_PACK_PREFIX, project_id, file.filename))?;
    download_verified(&file, dest.clone()).await?;
    Ok(dest)
}

/// Start of the name of a pack saved by `download_modpack`.
const DOWNLOADED_PACK_PREFIX: &str = "nihao-modpack-";

/// A pack saved by `download_modpack`: removed from the temp folder when this goes out of scope
/// (see `remove_downloaded_pack`), whether the import worked or not.
pub struct TempPack(pub PathBuf);

impl Drop for TempPack {
    fn drop(&mut self) {
        remove_downloaded_pack(&self.0);
    }
}

/// Deletes `path` if it is a pack `download_modpack` saved in the temp folder: once imported, nothing
/// needs it. A file the player picked themselves is never touched.
pub fn remove_downloaded_pack(path: &Path) {
    let ours = path.parent() == Some(std::env::temp_dir().as_path())
        && path.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with(DOWNLOADED_PACK_PREFIX));
    if ours {
        let _ = std::fs::remove_file(path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_ids_are_unique_and_resolvable() {
        let mut seen = std::collections::HashSet::new();
        for service in all() {
            let id = service.info().id;
            assert!(seen.insert(id), "duplicate service id {id}");
            assert_eq!(get(id).unwrap().info().id, id);
        }
        assert!(get("no-such-service").is_err());
    }

    #[test]
    fn loader_filter_applies_to_modded_mods_only() {
        assert_eq!(mod_loader_filter("mods", "Fabric").as_deref(), Some("fabric"));
        assert_eq!(mod_loader_filter("mods", "vanilla"), None);
        assert_eq!(mod_loader_filter("mods", ""), None);
        assert_eq!(mod_loader_filter("shaderpacks", "fabric"), None);
    }
}
