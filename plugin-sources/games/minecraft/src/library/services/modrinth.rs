//! Modrinth (https://modrinth.com) as a `ContentService`, over its v2 API.

use std::collections::HashMap;

use async_trait::async_trait;
use serde::de::DeserializeOwned;
use serde::Deserialize;

use super::{
    http, mod_loader_filter, BrowseHit, BrowseSearchResult, ContentService, FileRequest, GalleryImage, KnownFile,
    ModpackVersion, ProjectBrief, ProjectDetail, RemoteFile, SearchQuery, ServiceInfo,
};

const API_BASE: &str = "https://api.modrinth.com/v2";
/// The ids go in the URL, and hundreds of them make it too long for the server.
const PROJECT_BATCH: usize = 100;

static INFO: ServiceInfo = ServiceInfo {
    id: "modrinth",
    name: "Modrinth",
    content: &["mods", "resourcepacks", "shaderpacks", "datapacks"],
    modpacks: true,
    sorts: &["downloads", "follows", "newest", "updated"],
    // Modrinth's raw `environment` facet values aren't a single either/or (e.g. `client_or_server`).
    environments: &[
        "client_and_server",
        "client_only",
        "client_only_server_optional",
        "singleplayer_only",
        "server_only",
        "server_only_client_optional",
        "dedicated_server_only",
        "client_or_server",
        "client_or_server_prefers_both",
    ],
};

pub struct Modrinth;

/// Modrinth's `project_type` values: `"shader"` (not `"shaderpack"`), and `"datapack"` is a real
/// filterable value.
fn project_type_for_category(category: &str) -> &'static str {
    match category {
        "resourcepacks" => "resourcepack",
        "shaderpacks" => "shader",
        "datapacks" => "datapack",
        "modpacks" => "modpack",
        _ => "mod",
    }
}

/// `GET {API_BASE}{path}` as JSON. `what` names the data in the error ("Cannot fetch {what}").
async fn get_json<T: DeserializeOwned>(path: &str, query: &[(&str, String)], what: &str) -> Result<T, String> {
    let response = http()
        .get(format!("{}{}", API_BASE, path))
        .query(query)
        .send()
        .await
        .map_err(|e| format!("Cannot reach Modrinth: {}", e))?;
    if !response.status().is_success() {
        return Err(format!("Cannot fetch {} ({})", what, response.status()));
    }
    response.json().await.map_err(|e| format!("Invalid response from Modrinth: {}", e))
}

#[derive(Deserialize)]
struct SearchResponse {
    hits: Vec<SearchHit>,
    total_hits: u64,
}

#[derive(Deserialize)]
struct SearchHit {
    project_id: String,
    #[serde(default)]
    slug: String,
    #[serde(default)]
    project_type: String,
    title: String,
    description: String,
    icon_url: Option<String>,
    downloads: u64,
    author: String,
    #[serde(default)]
    environment: Vec<String>,
    /// A curated UI subset of the project's categories, which also carries loaders (`fabric`,
    /// `neoforge`, ...) as Modrinth has no separate loader field.
    #[serde(default)]
    display_categories: Vec<String>,
    /// Every category, loaders included.
    #[serde(default)]
    categories: Vec<String>,
    /// Supported game versions.
    #[serde(default)]
    versions: Vec<String>,
    date_modified: Option<String>,
    featured_gallery: Option<String>,
    #[serde(default)]
    gallery: Vec<String>,
}

/// The loaders worth listing among a project's categories.
const LOADERS: [&str; 4] = ["fabric", "forge", "neoforge", "quilt"];

impl From<SearchHit> for BrowseHit {
    fn from(h: SearchHit) -> Self {
        let mut gallery: Vec<String> = h.featured_gallery.into_iter().collect();
        for url in h.gallery {
            if !gallery.contains(&url) {
                gallery.push(url);
            }
        }
        gallery.truncate(6);
        BrowseHit {
            url: format!("https://modrinth.com/{}/{}", h.project_type, if h.slug.is_empty() { &h.project_id } else { &h.slug }),
            slug: h.slug,
            authors: vec![h.author.clone()],
            project_id: h.project_id,
            title: h.title,
            description: h.description,
            icon_url: h.icon_url,
            downloads: h.downloads,
            author: h.author,
            environment: h.environment,
            categories: h.display_categories,
            gallery,
            updated: h.date_modified,
            game_versions: h.versions,
            loaders: h.categories.into_iter().filter(|c| LOADERS.contains(&c.as_str())).collect(),
        }
    }
}

#[derive(Deserialize)]
struct CategoryTag {
    name: String,
    project_type: String,
}

#[derive(Deserialize)]
struct Version {
    #[serde(default)]
    id: String,
    #[serde(default)]
    project_id: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    version_number: String,
    #[serde(default)]
    version_type: String,
    #[serde(default)]
    game_versions: Vec<String>,
    #[serde(default)]
    loaders: Vec<String>,
    #[serde(default)]
    date_published: String,
    #[serde(default)]
    downloads: u64,
    #[serde(default)]
    files: Vec<VersionFile>,
}

#[derive(Deserialize)]
struct VersionFile {
    url: String,
    filename: String,
    #[serde(default)]
    primary: bool,
    #[serde(default)]
    size: u64,
    hashes: VersionHashes,
}

#[derive(Deserialize)]
struct VersionHashes {
    sha1: String,
    #[serde(default)]
    sha512: String,
}

impl Version {
    /// The file to download: the primary one, else the first.
    fn main_file(&self) -> Option<&VersionFile> {
        self.files.iter().find(|f| f.primary).or_else(|| self.files.first())
    }
}

#[derive(Deserialize)]
struct ProjectResponse {
    id: String,
    #[serde(default)]
    slug: String,
    #[serde(default)]
    project_type: String,
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
    raw_url: Option<String>,
    title: Option<String>,
}

#[derive(Deserialize)]
struct ProjectBriefResponse {
    id: String,
    title: String,
    icon_url: Option<String>,
}

#[async_trait]
impl ContentService for Modrinth {
    fn info(&self) -> &'static ServiceInfo {
        &INFO
    }

    /// Filters by the project type of `category` plus (when known) the game version and, for
    /// mods, the loader. A loader is just another Modrinth category, so it is pushed as
    /// `categories:{value}` like the rest. Icons stay plain CDN URLs for the webview to load: these
    /// results are ephemeral, so fetching every icon server-side would be wasted work.
    async fn search(&self, q: &SearchQuery) -> Result<BrowseSearchResult, String> {
        let mut facets = vec![vec![format!("project_type:{}", project_type_for_category(&q.category))]];
        if !q.minecraft_version.is_empty() {
            facets.push(vec![format!("versions:{}", q.minecraft_version)]);
        }
        if let Some(loader) = mod_loader_filter(&q.category, &q.loader) {
            facets.push(vec![format!("categories:{}", loader)]);
        }
        let ored: [(&str, &Vec<String>); 3] =
            [("categories", &q.categories), ("environment", &q.environments), ("categories", &q.loaders)];
        for (facet, values) in ored {
            if !values.is_empty() {
                facets.push(values.iter().map(|v| format!("{}:{}", facet, v)).collect());
            }
        }

        let mut params = vec![
            ("query", q.query.clone()),
            ("facets", serde_json::to_string(&facets).map_err(|e| e.to_string())?),
            ("offset", q.offset.to_string()),
            ("limit", q.limit.to_string()),
        ];
        if !q.sort.is_empty() {
            params.push(("index", q.sort.clone()));
        }
        let parsed: SearchResponse = get_json("/search", &params, "search results").await?;
        Ok(BrowseSearchResult {
            total_hits: parsed.total_hits,
            hits: parsed.hits.into_iter().map(BrowseHit::from).collect(),
        })
    }

    /// `GET /tag/category`: the whole taxonomy filtered to `category`'s project type (each type has
    /// its own mostly disjoint set: a resourcepack's are resolutions like `"16x"`, a mod's are
    /// genres like `"technology"`).
    async fn categories(&self, category: &str) -> Result<Vec<String>, String> {
        let project_type = project_type_for_category(category);
        let all: Vec<CategoryTag> = get_json("/tag/category", &[], "categories").await?;
        Ok(all.into_iter().filter(|c| c.project_type == project_type).map(|c| c.name).collect())
    }

    async fn project(&self, project_id: &str) -> Result<ProjectDetail, String> {
        let p: ProjectResponse = get_json(&format!("/project/{}", project_id), &[], "project").await?;

        let mut categories = p.categories;
        categories.extend(p.additional_categories);

        Ok(ProjectDetail {
            url: format!("https://modrinth.com/{}/{}", p.project_type, if p.slug.is_empty() { &p.id } else { &p.slug }),
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
            gallery: p.gallery.into_iter().map(|g| GalleryImage { url: g.url, full_url: g.raw_url, title: g.title }).collect(),
        })
    }

    /// `GET /project/{id}/version`, newest first: filtered by game version/loader when asked to
    /// pick the newest, unfiltered when looking a specific `version_id` up.
    async fn resolve_file(&self, request: &FileRequest) -> Result<RemoteFile, String> {
        let mut query: Vec<(&str, String)> = Vec::new();
        if request.version_id.is_none() {
            if !request.minecraft_version.is_empty() {
                query.push(("game_versions", serde_json::to_string(&[&request.minecraft_version]).unwrap_or_default()));
            }
            if let Some(loader) = mod_loader_filter(&request.category, &request.loader) {
                query.push(("loaders", serde_json::to_string(&[loader]).unwrap_or_default()));
            }
        }
        let versions: Vec<Version> =
            get_json(&format!("/project/{}/version", request.project_id), &query, "versions").await?;
        let version = match &request.version_id {
            Some(id) => versions.iter().find(|v| &v.id == id).ok_or_else(|| "That version was not found.".to_string())?,
            None => versions
                .first()
                .ok_or_else(|| "No version of this compatible with the instance's game version/loader was found.".to_string())?,
        };
        let file = version.main_file().ok_or_else(|| "That version has no downloadable file.".to_string())?;
        Ok(RemoteFile {
            url: file.url.clone(),
            filename: file.filename.clone(),
            sha1: file.hashes.sha1.clone(),
            headers: Vec::new(),
        })
    }

    async fn modpack_versions(&self, project_id: &str) -> Result<Vec<ModpackVersion>, String> {
        let versions: Vec<Version> = get_json(&format!("/project/{}/version", project_id), &[], "versions").await?;
        Ok(versions
            .into_iter()
            .map(|v| ModpackVersion {
                id: v.id,
                name: v.name,
                version_number: v.version_number,
                version_type: v.version_type,
                game_versions: v.game_versions,
                loaders: v.loaders,
                date_published: v.date_published,
                downloads: v.downloads,
            })
            .collect())
    }

    /// `POST /version_files`.
    async fn identify_files(&self, sha1s: &[String]) -> HashMap<String, KnownFile> {
        let body = serde_json::json!({ "hashes": sha1s, "algorithm": "sha1" });
        let versions: HashMap<String, Version> = match http()
            .post(format!("{}/version_files", API_BASE))
            .json(&body)
            .send()
            .await
        {
            Ok(res) if res.status().is_success() => res.json().await.unwrap_or_default(),
            _ => return HashMap::new(),
        };
        versions
            .into_iter()
            .filter_map(|(hash, version)| {
                // The file that actually matched, which isn't always the version's primary one.
                let file = version
                    .files
                    .iter()
                    .find(|f| f.hashes.sha1.eq_ignore_ascii_case(&hash))
                    .or_else(|| version.main_file())?;
                let known = KnownFile {
                    service: INFO.id,
                    project_id: version.project_id.clone(),
                    version_number: version.version_number.clone(),
                    url: file.url.clone(),
                    size: file.size,
                    sha512: Some(file.hashes.sha512.clone()).filter(|s| !s.is_empty()),
                };
                Some((hash, known))
            })
            .collect()
    }

    /// `GET /projects?ids=[...]`.
    async fn project_briefs(&self, project_ids: &[String]) -> HashMap<String, ProjectBrief> {
        let mut unique: Vec<&String> = project_ids.iter().collect();
        unique.sort();
        unique.dedup();

        let mut result = HashMap::new();
        for chunk in unique.chunks(PROJECT_BATCH) {
            let ids = serde_json::to_string(chunk).unwrap_or_else(|_| "[]".to_string());
            let Ok(projects) = get_json::<Vec<ProjectBriefResponse>>("/projects", &[("ids", ids)], "projects").await else {
                continue;
            };
            result.extend(projects.into_iter().map(|p| (p.id, ProjectBrief { title: p.title, icon_url: p.icon_url })));
        }
        result
    }

    fn icon_prefixes(&self) -> &'static [&'static str] {
        &["https://cdn.modrinth.com/"]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Hits the real API: `cargo test -p minecraft live_ -- --ignored --nocapture`.
    #[tokio::test]
    #[ignore]
    async fn live_search_fills_the_card_facts() {
        let found = Modrinth
            .search(&SearchQuery { category: "modpacks".into(), limit: 5, ..Default::default() })
            .await
            .unwrap();
        assert!(!found.hits.is_empty());
        for hit in &found.hits {
            println!("{}: updated {:?}, versions {:?}, loaders {:?}", hit.title, hit.updated, hit.game_versions.last(), hit.loaders);
            assert!(hit.updated.is_some() && !hit.game_versions.is_empty());
            assert!(hit.url.starts_with("https://modrinth.com/modpack/") && !hit.slug.is_empty() && hit.authors == [hit.author.clone()]);
            println!("  {} | slug {}", hit.url, hit.slug);
        }
    }
}
