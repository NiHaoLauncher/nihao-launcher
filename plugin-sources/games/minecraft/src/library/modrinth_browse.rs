//! "Browse content" — searches Modrinth for mods/resourcepacks/shaders/datapacks to add to an
//! instance, and downloads the chosen project's best-matching version's primary file straight
//! into the right folder. Separate from `content_cache.rs`, which only ever *reads* what's
//! already on disk (by content hash, for files that already exist) — this is the other
//! direction: finding and fetching something new by name.

use std::path::Path;

use reqwest::Client;
use serde::{Deserialize, Serialize};

use super::export::{ExportProgress, ProgressCallback};

const MODRINTH_API_BASE: &str = "https://api.modrinth.com/v2";

/// Modrinth's own `project_type` values — note `"shader"` (not `"shaderpack"`) and that
/// `"datapack"` isn't one of the four headline types but is still a real, filterable value.
fn project_type_for_category(category: &str) -> &'static str {
    match category {
        "resourcepacks" => "resourcepack",
        "shaderpacks" => "shader",
        "datapacks" => "datapack",
        _ => "mod",
    }
}

#[derive(Serialize, Clone)]
pub struct BrowseHit {
    pub project_id: String,
    pub title: String,
    pub description: String,
    pub icon_url: Option<String>,
    pub downloads: u64,
    pub author: String,
    /// All the raw Modrinth `environment` values this project's versions support (e.g.
    /// `["client_and_server"]`) — an array, not a single enum, since different versions of the
    /// same project can support different environments over time.
    pub environment: Vec<String>,
    /// Modrinth's own `display_categories` — its curated, UI-facing subset of the project's
    /// full category list, which is also where loaders (`fabric`, `neoforge`, ...) show up
    /// since Modrinth's data model has no separate "loader" field, just categories.
    pub categories: Vec<String>,
}

/// A page of search results plus how many total hits Modrinth has for the query — lets the
/// frontend render "page X of Y" / "N more" without a second request.
#[derive(Serialize)]
pub struct BrowseSearchResult {
    pub hits: Vec<BrowseHit>,
    pub total_hits: u64,
}

#[derive(Deserialize)]
struct SearchResponse {
    hits: Vec<SearchHit>,
    total_hits: u64,
}

#[derive(Deserialize)]
struct SearchHit {
    project_id: String,
    title: String,
    description: String,
    icon_url: Option<String>,
    downloads: u64,
    author: String,
    #[serde(default)]
    environment: Vec<String>,
    #[serde(default)]
    display_categories: Vec<String>,
}

/// Searches Modrinth for `query`, filtered to `category`'s project type plus (when known) the
/// instance's game version — and, for mods specifically, its loader too (a resourcepack/
/// shader/datapack isn't loader-specific, so that facet is skipped for those). Icons come back
/// as plain Modrinth CDN URLs, not downloaded/base64'd here — this list is ephemeral search
/// results, not something that needs to work offline the way `content_cache.rs`'s persisted
/// entries do, so letting the webview load them directly (in parallel) is both simpler and
/// faster than fetching every hit's icon server-side just to throw most of them away.
/// `offset`/`limit` page through Modrinth's own result set directly (its `/search` endpoint
/// natively supports both), so pagination costs nothing beyond the one request per page.
/// `sort` is Modrinth's own `index` values (`relevance`/`downloads`/`follows`/`newest`/
/// `updated`) — empty falls back to Modrinth's own default. `extra_categories` are the
/// player-picked filter categories (see `categories()`) — OR'd together as one extra facet
/// group, same as the loader facet below, so a result only needs to match *one* of them.
/// `extra_environments` are the player-picked `environment` facet values (Modrinth's own raw
/// enum — `client_and_server`, `client_or_server`, `singleplayer_only`, ...; not simplified down
/// to a single pick, since a project's actual environment support isn't a single either/or —
/// e.g. `client_or_server` is neither "client" nor "server" nor "both required") — OR'd together
/// the same way `extra_categories` is, so the player can multi-select exactly like Categories.
pub async fn search(
    category: &str,
    query: String,
    minecraft_version: &str,
    loader: &str,
    offset: u32,
    limit: u32,
    sort: &str,
    extra_categories: &[String],
    extra_environments: &[String],
) -> Result<BrowseSearchResult, String> {
    let mut facets = vec![vec![format!("project_type:{}", project_type_for_category(category))]];
    if !minecraft_version.is_empty() {
        facets.push(vec![format!("versions:{}", minecraft_version)]);
    }
    if category == "mods" {
        let loader_lower = loader.to_lowercase();
        if loader_lower != "vanilla" && !loader_lower.is_empty() {
            facets.push(vec![format!("categories:{}", loader_lower)]);
        }
    }
    if !extra_categories.is_empty() {
        facets.push(extra_categories.iter().map(|c| format!("categories:{}", c)).collect());
    }
    if !extra_environments.is_empty() {
        facets.push(extra_environments.iter().map(|e| format!("environment:{}", e)).collect());
    }
    let facets_json = serde_json::to_string(&facets).map_err(|e| e.to_string())?;

    let client = Client::new();
    let mut query_params = vec![
        ("query", query.clone()),
        ("facets", facets_json),
        ("offset", offset.to_string()),
        ("limit", limit.to_string()),
    ];
    if !sort.is_empty() {
        query_params.push(("index", sort.to_string()));
    }
    let response = client
        .get(format!("{}/search", MODRINTH_API_BASE))
        .query(&query_params)
        .send()
        .await
        .map_err(|e| format!("Cannot reach Modrinth: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("Modrinth search failed ({})", response.status()));
    }
    let parsed: SearchResponse = response.json().await.map_err(|e| format!("Invalid response from Modrinth: {}", e))?;
    Ok(BrowseSearchResult {
        total_hits: parsed.total_hits,
        hits: parsed
            .hits
            .into_iter()
            .map(|h| BrowseHit {
                project_id: h.project_id,
                title: h.title,
                description: h.description,
                icon_url: h.icon_url,
                downloads: h.downloads,
                author: h.author,
                environment: h.environment,
                categories: h.display_categories,
            })
            .collect(),
    })
}

#[derive(Serialize, Deserialize, Clone)]
pub struct CategoryTag {
    pub name: String,
    icon: String,
    project_type: String,
}

/// `GET /tag/category` — Modrinth's full category taxonomy across every project type in one
/// call (mods, resourcepacks, shaders, and datapacks each have their own, mostly disjoint, set
/// — e.g. a resourcepack's categories are resolutions like `"16x"`, a mod's are genres like
/// `"technology"`), filtered down to just `category`'s. Powers the Browse content filters panel
/// — since the available filters are inherently service-specific, this list *is* the filter UI
/// for whatever service is active, rather than a fixed one this module hardcodes.
pub async fn categories(category: &str) -> Result<Vec<String>, String> {
    let project_type = project_type_for_category(category);
    let client = Client::new();
    let response = client
        .get(format!("{}/tag/category", MODRINTH_API_BASE))
        .send()
        .await
        .map_err(|e| format!("Cannot reach Modrinth: {}", e))?;
    if !response.status().is_success() {
        return Err(format!("Cannot fetch categories ({})", response.status()));
    }
    let all: Vec<CategoryTag> = response.json().await.map_err(|e| format!("Invalid response from Modrinth: {}", e))?;
    Ok(all
        .into_iter()
        .filter(|c| c.project_type == project_type)
        .map(|c| c.name)
        .collect())
}

#[derive(Deserialize)]
struct VersionResponse {
    files: Vec<VersionFile>,
}

#[derive(Deserialize)]
struct VersionFile {
    url: String,
    filename: String,
    primary: bool,
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

/// Downloads `project_id`'s latest version compatible with the instance (game version, and —
/// for mods — loader) into `{instance_dir}/{category}`. Picks the first version Modrinth
/// returns (newest first, by default) rather than offering a version picker — matches this
/// panel's "just get me the right file" scope; a player who needs a specific older version can
/// still grab it manually and drop it in. `progress` feeds the same `install_state()` the
/// bottom `.progress` bar polls for real installs/exports — see `interface.rs`'s
/// `job_progress_callback`, reused here rather than duplicated.
pub async fn install(
    category: &str,
    instance_dir: &Path,
    project_id: &str,
    minecraft_version: &str,
    loader: &str,
    progress: &ProgressCallback,
) -> Result<String, String> {
    let client = Client::new();

    let mut query: Vec<(&str, String)> = Vec::new();
    if !minecraft_version.is_empty() {
        query.push(("game_versions", serde_json::to_string(&[minecraft_version]).unwrap_or_default()));
    }
    if category == "mods" {
        let loader_lower = loader.to_lowercase();
        if loader_lower != "vanilla" && !loader_lower.is_empty() {
            query.push(("loaders", serde_json::to_string(&[loader_lower]).unwrap_or_default()));
        }
    }

    progress(install_progress("Fetching version info", 0, "check", ""));
    let response = client
        .get(format!("{}/project/{}/version", MODRINTH_API_BASE, project_id))
        .query(&query)
        .send()
        .await
        .map_err(|e| format!("Cannot reach Modrinth: {}", e))?;
    if !response.status().is_success() {
        return Err(format!("Cannot fetch versions ({})", response.status()));
    }
    let versions: Vec<VersionResponse> = response.json().await.map_err(|e| format!("Invalid response from Modrinth: {}", e))?;
    let version = versions
        .first()
        .ok_or_else(|| "No version of this compatible with the instance's game version/loader was found.".to_string())?;
    let file = version
        .files
        .iter()
        .find(|f| f.primary)
        .or_else(|| version.files.first())
        .ok_or_else(|| "That version has no downloadable file.".to_string())?;

    progress(install_progress("Downloading", 1, "download", &file.filename));
    let bytes = client
        .get(&file.url)
        .send()
        .await
        .map_err(|e| format!("Cannot download '{}': {}", file.filename, e))?
        .bytes()
        .await
        .map_err(|e| format!("Cannot download '{}': {}", file.filename, e))?;

    progress(install_progress("Installing", 2, "write", &file.filename));
    let dir = instance_dir.join(category);
    tokio::fs::create_dir_all(&dir).await.map_err(|e| format!("Cannot create '{}': {}", category, e))?;
    let dest = dir.join(&file.filename);
    tokio::fs::write(&dest, &bytes)
        .await
        .map_err(|e| format!("Cannot write '{}': {}", file.filename, e))?;

    Ok(file.filename.clone())
}

/// One gallery screenshot — Modrinth CDN URLs, loaded directly by the webview same as search
/// hit icons.
#[derive(Serialize, Clone)]
pub struct GalleryImage {
    pub url: String,
    pub title: Option<String>,
}

/// The full project page — everything `BrowseHit` doesn't carry (the search endpoint only
/// returns a summary), for the detail view a click on a search result opens. There's no way to
/// actually embed Modrinth's own page (`modrinth.com` sends `X-Frame-Options: DENY`, so an
/// `<iframe>` just refuses to load) — this is a from-scratch page built from the same data
/// instead.
#[derive(Serialize, Clone)]
pub struct ProjectDetail {
    pub project_id: String,
    pub title: String,
    pub description: String,
    /// Raw Markdown (CommonMark, per Modrinth's docs) — rendered client-side by a small
    /// from-scratch renderer rather than any HTML-injecting one, since this is arbitrary
    /// third-party content the webview cannot trust the way it trusts this app's own UI.
    pub body: String,
    pub icon_url: Option<String>,
    pub downloads: u64,
    pub followers: u64,
    /// `categories` + `additional_categories` combined — the detail page has room to just show
    /// everything, unlike the search hit row's `display_categories` (a curated, space-limited
    /// subset).
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

#[derive(Deserialize)]
struct ProjectResponse {
    id: String,
    title: String,
    description: String,
    body: String,
    icon_url: Option<String>,
    downloads: u64,
    followers: u64,
    #[serde(default)]
    categories: Vec<String>,
    #[serde(default)]
    additional_categories: Vec<String>,
    #[serde(default)]
    environment: Vec<String>,
    license: Option<LicenseResponse>,
    source_url: Option<String>,
    issues_url: Option<String>,
    wiki_url: Option<String>,
    discord_url: Option<String>,
    #[serde(default)]
    gallery: Vec<GalleryImageResponse>,
}

#[derive(Deserialize)]
struct LicenseResponse {
    name: String,
    url: Option<String>,
}

#[derive(Deserialize)]
struct GalleryImageResponse {
    url: String,
    title: Option<String>,
}

/// `GET /project/{id}` — the "open a mod" detail view's data source.
pub async fn project_detail(project_id: &str) -> Result<ProjectDetail, String> {
    let client = Client::new();
    let response = client
        .get(format!("{}/project/{}", MODRINTH_API_BASE, project_id))
        .send()
        .await
        .map_err(|e| format!("Cannot reach Modrinth: {}", e))?;
    if !response.status().is_success() {
        return Err(format!("Cannot fetch project ({})", response.status()));
    }
    let p: ProjectResponse = response.json().await.map_err(|e| format!("Invalid response from Modrinth: {}", e))?;

    let mut categories = p.categories;
    categories.extend(p.additional_categories);

    Ok(ProjectDetail {
        project_id: p.id,
        title: p.title,
        description: p.description,
        body: p.body,
        icon_url: p.icon_url,
        downloads: p.downloads,
        followers: p.followers,
        categories,
        environment: p.environment,
        license_name: p.license.as_ref().map(|l| l.name.clone()),
        license_url: p.license.and_then(|l| l.url),
        source_url: p.source_url,
        issues_url: p.issues_url,
        wiki_url: p.wiki_url,
        discord_url: p.discord_url,
        gallery: p.gallery.into_iter().map(|g| GalleryImage { url: g.url, title: g.title }).collect(),
    })
}
