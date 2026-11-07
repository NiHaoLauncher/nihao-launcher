//! CurseForge (https://www.curseforge.com) as a `ContentService`, over its Core API v1. The API
//! needs a key (https://console.curseforge.com): `CURSEFORGE_API_KEY` at run time, else the one the
//! build was made with. Without one the service is listed but disabled, with that as the reason.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use async_trait::async_trait;
use reqwest::{Method, RequestBuilder};
use serde::de::DeserializeOwned;
use serde::Deserialize;

use super::{
    http, mod_loader_filter, BlockedFile, BrowseHit, BrowseSearchResult, ContentService, FileRequest, GalleryImage,
    ModpackVersion, PackFile, PackFileRef, PackFiles, ProjectDetail, RemoteFile, SearchQuery, ServiceInfo,
};

const API_BASE: &str = "https://api.curseforge.com/v1";
const MINECRAFT: u32 = 432;
/// The API's page size limit.
const MAX_PAGE: u32 = 50;
/// A search can't reach past this many results (`index + pageSize`).
const MAX_DEPTH: u32 = 10_000;
/// Builds listed for a modpack: enough for the version picker without paging forever.
const MAX_VERSIONS: usize = 300;
/// Ids per bulk lookup (`POST /mods/files`, `POST /mods`).
const BULK: usize = 400;

static INFO: ServiceInfo = ServiceInfo {
    id: "curseforge",
    name: "CurseForge",
    content: &["mods", "resourcepacks", "shaderpacks", "datapacks"],
    modpacks: true,
    sorts: &["popularity", "downloads", "updated"],
    // CurseForge has no client/server side metadata.
    environments: &[],
};

pub struct CurseForge;

fn api_key() -> Option<String> {
    std::env::var("CURSEFORGE_API_KEY")
        .ok()
        .or_else(|| option_env!("CURSEFORGE_API_KEY").map(str::to_string))
        .filter(|k| !k.trim().is_empty())
}

fn class_id(category: &str) -> u32 {
    match category {
        "resourcepacks" => 12,
        "shaderpacks" => 6552,
        "datapacks" => 6945,
        "modpacks" => 4471,
        _ => 6,
    }
}

/// The folder a CurseForge project class belongs in (`class_id` the other way round); mods when unknown.
fn folder_for_class(class: u32) -> &'static str {
    match class {
        12 => "resourcepacks",
        6552 => "shaderpacks",
        6945 => "datapacks",
        _ => "mods",
    }
}

/// `ModLoaderType`; the ones the launcher can't run still map, so the market can filter by them.
fn loader_id(name: &str) -> Option<u32> {
    match name.to_lowercase().as_str() {
        "forge" => Some(1),
        "fabric" => Some(4),
        "quilt" => Some(5),
        "neoforge" => Some(6),
        _ => None,
    }
}

/// `ModLoaderType` back to its name, for the ones `loader_id` knows.
fn loader_name(id: u32) -> Option<&'static str> {
    match id {
        1 => Some("forge"),
        4 => Some("fabric"),
        5 => Some("quilt"),
        6 => Some("neoforge"),
        _ => None,
    }
}

/// `ModsSearchSortField`; ids this service doesn't know sort by relevance.
fn sort_field(sort: &str) -> Option<u32> {
    match sort {
        "popularity" => Some(2),
        "updated" => Some(3),
        "downloads" => Some(6),
        _ => None,
    }
}

/// Ids go into URL paths, so refuse anything that isn't a plain number.
fn numeric(id: &str) -> Result<u64, String> {
    id.parse().map_err(|_| format!("'{}' is not a CurseForge id", id))
}

fn request(method: Method, path: &str) -> Result<RequestBuilder, String> {
    let key = api_key().ok_or("CurseForge needs an API key: set CURSEFORGE_API_KEY.")?;
    Ok(http()
        .request(method, format!("{}{}", API_BASE, path))
        .header("x-api-key", key)
        .header("Accept", "application/json"))
}

#[derive(Deserialize)]
struct Envelope<T> {
    data: T,
    pagination: Option<Pagination>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Pagination {
    total_count: u64,
}

/// Sends `req` and unwraps CurseForge's `{ data, pagination }` envelope. `what` names the data in the
/// error ("Cannot fetch {what}").
async fn send<T: DeserializeOwned>(req: RequestBuilder, what: &str) -> Result<Envelope<T>, String> {
    let response = req.send().await.map_err(|e| format!("Cannot reach CurseForge: {}", e))?;
    let status = response.status();
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        return Err(format!("CurseForge rejected the API key ({})", status));
    }
    if !status.is_success() {
        return Err(format!("Cannot fetch {} ({})", what, status));
    }
    response.json().await.map_err(|e| format!("Invalid response from CurseForge: {}", e))
}

async fn get<T: DeserializeOwned>(path: &str, query: &[(&str, String)], what: &str) -> Result<Envelope<T>, String> {
    send(request(Method::GET, path)?.query(query), what).await
}

async fn post<T: DeserializeOwned>(path: &str, body: serde_json::Value, what: &str) -> Result<Envelope<T>, String> {
    send(request(Method::POST, path)?.json(&body), what).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Mod {
    id: u64,
    name: String,
    #[serde(default)]
    slug: String,
    #[serde(default)]
    summary: String,
    #[serde(default)]
    download_count: f64,
    #[serde(default)]
    thumbs_up_count: u64,
    logo: Option<Asset>,
    #[serde(default)]
    screenshots: Vec<Asset>,
    #[serde(default)]
    authors: Vec<Author>,
    #[serde(default)]
    categories: Vec<Category>,
    links: Option<Links>,
    #[serde(default)]
    class_id: u32,
    /// When the newest file was released: the real "last updated" (`date_modified` also moves on
    /// page edits).
    date_released: Option<String>,
    date_modified: Option<String>,
    #[serde(default)]
    latest_files_indexes: Vec<FileIndex>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileIndex {
    game_version: String,
    /// `ModLoaderType`, null for files without one.
    mod_loader: Option<u32>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Asset {
    #[serde(default)]
    url: String,
    #[serde(default)]
    thumbnail_url: String,
    title: Option<String>,
}

#[derive(Deserialize)]
struct Author {
    name: String,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Category {
    id: u64,
    name: String,
    #[serde(default)]
    is_class: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Links {
    website_url: Option<String>,
    wiki_url: Option<String>,
    issues_url: Option<String>,
    source_url: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct File {
    id: u64,
    #[serde(default)]
    display_name: String,
    file_name: String,
    /// 1 release, 2 beta, 3 alpha.
    #[serde(default)]
    release_type: u8,
    #[serde(default)]
    file_date: String,
    #[serde(default)]
    download_count: f64,
    /// `None` when the author disallows downloads outside CurseForge.
    download_url: Option<String>,
    #[serde(default)]
    hashes: Vec<Hash>,
    #[serde(default)]
    game_versions: Vec<String>,
    is_server_pack: Option<bool>,
}

#[derive(Deserialize)]
struct Hash {
    value: String,
    /// 1 SHA-1, 2 MD5.
    algo: u8,
}

impl File {
    fn sha1(&self) -> Option<&str> {
        self.hashes.iter().find(|h| h.algo == 1).map(|h| h.value.as_str())
    }

    fn url(&self) -> Option<&str> {
        self.download_url.as_deref().filter(|u| !u.is_empty())
    }
}

/// CurseForge's CDN wants the API key on downloads too. Sent only to its own hosts (never to a URL
/// that merely appears in a response), and as a header so it can't end up in a URL or an error.
fn cdn_headers(url: &str) -> Vec<(&'static str, String)> {
    let on_cdn = reqwest::Url::parse(url)
        .ok()
        .is_some_and(|u| u.scheme() == "https" && u.host_str().is_some_and(|h| h.ends_with(".forgecdn.net")));
    match api_key() {
        Some(key) if on_cdn => vec![("x-api-key", key)],
        _ => Vec::new(),
    }
}

/// Non-empty `Some`, so an empty string from the API counts as missing.
fn non_empty(s: Option<String>) -> Option<String> {
    s.filter(|s| !s.is_empty())
}

/// A project's categories within `class` (a cached list: it is small and never changes mid-session).
async fn class_categories(class: u32) -> Result<Vec<Category>, String> {
    static CACHE: OnceLock<Mutex<HashMap<u32, Vec<Category>>>> = OnceLock::new();
    let cache = CACHE.get_or_init(Default::default);
    if let Some(known) = cache.lock().unwrap_or_else(|e| e.into_inner()).get(&class) {
        return Ok(known.clone());
    }
    let fetched = get::<Vec<Category>>(
        "/categories",
        &[("gameId", MINECRAFT.to_string()), ("classId", class.to_string())],
        "categories",
    )
    .await?
    .data;
    cache.lock().unwrap_or_else(|e| e.into_inner()).insert(class, fetched.clone());
    Ok(fetched)
}

/// The items without repeats, in first-seen order.
fn unique(items: impl Iterator<Item = String>) -> Vec<String> {
    let mut seen = Vec::new();
    for item in items {
        if !seen.contains(&item) {
            seen.push(item);
        }
    }
    seen
}

fn to_hit(m: Mod) -> BrowseHit {
    let url = non_empty(m.links.and_then(|l| l.website_url)).unwrap_or_else(|| format!("https://www.curseforge.com/projects/{}", m.id));
    let authors: Vec<String> = m.authors.into_iter().map(|a| a.name).collect();
    let logo = m.logo.and_then(|l| non_empty(Some(l.thumbnail_url)).or_else(|| non_empty(Some(l.url))));
    BrowseHit {
        project_id: m.id.to_string(),
        title: m.name,
        description: m.summary,
        icon_url: logo,
        downloads: m.download_count as u64,
        author: authors.first().cloned().unwrap_or_default(),
        authors,
        slug: m.slug,
        url,
        environment: Vec::new(),
        categories: m.categories.into_iter().map(|c| c.name).collect(),
        gallery: m.screenshots.into_iter().filter(|s| !s.url.is_empty()).take(6).map(|s| s.url).collect(),
        updated: m.date_released.or(m.date_modified),
        game_versions: unique(m.latest_files_indexes.iter().map(|i| i.game_version.clone())),
        loaders: unique(m.latest_files_indexes.iter().filter_map(|i| i.mod_loader.and_then(loader_name)).map(str::to_string)),
    }
}

fn remote_file(file: File) -> Result<RemoteFile, String> {
    let url = file.url().map(str::to_string).ok_or_else(|| {
        format!("The author of '{}' doesn't allow downloading it outside CurseForge; get it from curseforge.com.", file.file_name)
    })?;
    let sha1 = file
        .sha1()
        .map(str::to_string)
        .ok_or_else(|| format!("CurseForge lists no SHA-1 for '{}'.", file.file_name))?;
    Ok(RemoteFile { headers: cdn_headers(&url), url, filename: file.file_name, sha1 })
}

/// Orders game versions like `1.9` < `1.20.1`; anything non-numeric sorts first.
fn version_key(version: &str) -> Vec<u32> {
    version.split('.').map(|part| part.parse().unwrap_or(0)).collect()
}

#[async_trait]
impl ContentService for CurseForge {
    fn info(&self) -> &'static ServiceInfo {
        &INFO
    }

    fn unavailable(&self) -> Option<&'static str> {
        api_key().is_none().then_some("Needs a CurseForge API key: set the CURSEFORGE_API_KEY environment variable.")
    }

    /// `GET /mods/search`, several requests when `limit` exceeds the API's page size. The loader goes
    /// in as `modLoaderTypes` (several are OR'd), categories as the ids behind the names
    /// `categories` returned (several are AND'd, unlike Modrinth's: the API wants all of them).
    async fn search(&self, q: &SearchQuery) -> Result<BrowseSearchResult, String> {
        let class = class_id(&q.category);
        let mut params = vec![
            ("gameId", MINECRAFT.to_string()),
            ("classId", class.to_string()),
            ("sortOrder", "desc".to_string()),
        ];
        if !q.query.is_empty() {
            params.push(("searchFilter", q.query.clone()));
        }
        if !q.minecraft_version.is_empty() {
            params.push(("gameVersion", q.minecraft_version.clone()));
        }
        let loaders: Vec<String> = q
            .loaders
            .iter()
            .chain(mod_loader_filter(&q.category, &q.loader).as_ref())
            .filter_map(|l| loader_id(l))
            .map(|id| id.to_string())
            .collect();
        if !loaders.is_empty() {
            params.push(("modLoaderTypes", format!("[{}]", loaders.join(","))));
        }
        if !q.categories.is_empty() {
            let known = class_categories(class).await?;
            let ids: Vec<String> = q
                .categories
                .iter()
                .filter_map(|name| known.iter().find(|c| &c.name == name))
                .map(|c| c.id.to_string())
                .collect();
            if !ids.is_empty() {
                params.push(("categoryIds", format!("[{}]", ids.join(","))));
            }
        }
        if let Some(field) = sort_field(&q.sort) {
            params.push(("sortField", field.to_string()));
        }

        let end = q.offset + q.limit;
        let mut index = q.offset;
        let mut hits = Vec::new();
        let mut total = 0;
        while index < end.min(MAX_DEPTH) {
            let size = MAX_PAGE.min(end - index).min(MAX_DEPTH - index);
            let mut page = params.clone();
            page.push(("index", index.to_string()));
            page.push(("pageSize", size.to_string()));
            let found = get::<Vec<Mod>>("/mods/search", &page, "search results").await?;
            total = found.pagination.map_or(0, |p| p.total_count);
            let count = found.data.len() as u32;
            hits.extend(found.data.into_iter().map(to_hit));
            if count < size {
                break;
            }
            index += size;
        }
        Ok(BrowseSearchResult { hits, total_hits: total.min(MAX_DEPTH as u64) })
    }

    async fn categories(&self, category: &str) -> Result<Vec<String>, String> {
        let mut names: Vec<String> =
            class_categories(class_id(category)).await?.into_iter().filter(|c| !c.is_class).map(|c| c.name).collect();
        names.sort();
        names.dedup();
        Ok(names)
    }

    /// `GET /mods/{id}` plus `/description` (HTML, turned into the Markdown the UI renders).
    async fn project(&self, project_id: &str) -> Result<ProjectDetail, String> {
        let id = numeric(project_id)?;
        let (path, description_path) = (format!("/mods/{}", id), format!("/mods/{}/description", id));
        let (project, description) = tokio::try_join!(
            get::<Mod>(&path, &[], "project"),
            get::<String>(&description_path, &[], "description"),
        )?;
        let m = project.data;
        let links = m.links.unwrap_or(Links { website_url: None, wiki_url: None, issues_url: None, source_url: None });
        Ok(ProjectDetail {
            url: non_empty(links.website_url).unwrap_or_else(|| format!("https://www.curseforge.com/projects/{}", m.id)),
            project_id: m.id.to_string(),
            title: m.name,
            description: m.summary,
            body: html_to_markdown(&description.data),
            icon_url: m.logo.and_then(|l| non_empty(Some(l.url))),
            downloads: m.download_count as u64,
            followers: m.thumbs_up_count,
            categories: m.categories.into_iter().map(|c| c.name).collect(),
            environment: Vec::new(),
            license_name: None,
            license_url: None,
            source_url: non_empty(links.source_url),
            issues_url: non_empty(links.issues_url),
            wiki_url: non_empty(links.wiki_url),
            discord_url: None,
            gallery: m
                .screenshots
                .into_iter()
                .filter(|s| !s.url.is_empty())
                .map(|s| GalleryImage {
                    url: non_empty(Some(s.thumbnail_url)).unwrap_or_else(|| s.url.clone()),
                    full_url: Some(s.url),
                    title: non_empty(s.title),
                })
                .collect(),
        })
    }

    /// The named file, or the newest one for the game version/loader (the API gives no order, so
    /// it is picked by date). Server packs are never what a player wants.
    async fn resolve_file(&self, request: &FileRequest) -> Result<RemoteFile, String> {
        let mod_id = numeric(&request.project_id)?;
        let file = match &request.version_id {
            Some(file_id) => {
                get::<File>(&format!("/mods/{}/files/{}", mod_id, numeric(file_id)?), &[], "file").await?.data
            }
            None => {
                let mut query = vec![("pageSize", MAX_PAGE.to_string())];
                // The API only honours a loader together with a game version.
                if !request.minecraft_version.is_empty() {
                    query.push(("gameVersion", request.minecraft_version.clone()));
                    if let Some(loader) =
                        mod_loader_filter(&request.category, &request.loader).as_deref().and_then(loader_id)
                    {
                        query.push(("modLoaderType", loader.to_string()));
                    }
                }
                get::<Vec<File>>(&format!("/mods/{}/files", mod_id), &query, "versions")
                    .await?
                    .data
                    .into_iter()
                    .filter(|f| f.is_server_pack != Some(true))
                    .max_by(|a, b| a.file_date.cmp(&b.file_date))
                    .ok_or_else(|| {
                        "No version of this compatible with the instance's game version/loader was found.".to_string()
                    })?
            }
        };
        remote_file(file)
    }

    async fn modpack_versions(&self, project_id: &str) -> Result<Vec<ModpackVersion>, String> {
        let mod_id = numeric(project_id)?;
        let mut files: Vec<File> = Vec::new();
        loop {
            let query = [("pageSize", MAX_PAGE.to_string()), ("index", files.len().to_string())];
            let page = get::<Vec<File>>(&format!("/mods/{}/files", mod_id), &query, "versions").await?;
            let total = page.pagination.map_or(0, |p| p.total_count) as usize;
            let empty = page.data.is_empty();
            files.extend(page.data);
            if empty || files.len() >= total || files.len() >= MAX_VERSIONS {
                break;
            }
        }
        files.retain(|f| f.is_server_pack != Some(true));
        files.sort_by(|a, b| b.file_date.cmp(&a.file_date));
        Ok(files
            .into_iter()
            .map(|f| {
                let (loaders, mut game_versions): (Vec<String>, Vec<String>) = f
                    .game_versions
                    .iter()
                    .filter(|v| loader_id(v).is_some() || v.starts_with(|c: char| c.is_ascii_digit()))
                    .cloned()
                    .partition(|v| loader_id(v).is_some());
                game_versions.sort_by_key(|v| version_key(v));
                ModpackVersion {
                    id: f.id.to_string(),
                    version_number: f.display_name.clone(),
                    name: f.file_name,
                    version_type: match f.release_type {
                        1 => "release",
                        2 => "beta",
                        _ => "alpha",
                    }
                    .to_string(),
                    game_versions,
                    loaders: loaders.iter().map(|l| l.to_lowercase()).collect(),
                    date_published: f.file_date,
                    downloads: f.download_count as u64,
                }
            })
            .collect())
    }

    /// `POST /mods/files` for the download URLs and `POST /mods` for which folder each project
    /// class belongs in. A file whose author disabled third-party downloads has no URL: it comes
    /// back as `blocked`, for the caller to find elsewhere or hand to the player.
    async fn resolve_pack_files(&self, refs: &[PackFileRef]) -> Result<PackFiles, String> {
        let file_ids = refs.iter().map(|r| numeric(&r.file_id)).collect::<Result<Vec<_>, _>>()?;
        let mut mod_ids = refs.iter().map(|r| numeric(&r.project_id)).collect::<Result<Vec<_>, _>>()?;
        mod_ids.sort_unstable();
        mod_ids.dedup();

        let mut files: HashMap<u64, File> = HashMap::new();
        for chunk in file_ids.chunks(BULK) {
            let found: Envelope<Vec<File>> = post("/mods/files", serde_json::json!({ "fileIds": chunk }), "files").await?;
            files.extend(found.data.into_iter().map(|f| (f.id, f)));
        }
        let mut mods: HashMap<u64, Mod> = HashMap::new();
        for chunk in mod_ids.chunks(BULK) {
            let found: Envelope<Vec<Mod>> = post("/mods", serde_json::json!({ "modIds": chunk }), "projects").await?;
            mods.extend(found.data.into_iter().map(|m| (m.id, m)));
        }

        let mut files_out = Vec::with_capacity(refs.len());
        let mut blocked = Vec::new();
        for (r, file_id) in refs.iter().zip(&file_ids) {
            let file = files
                .get(file_id)
                .ok_or_else(|| format!("File {} of project {} is no longer on CurseForge.", r.file_id, r.project_id))?;
            let project = mods.get(&numeric(&r.project_id)?);
            let path = format!("{}/{}", folder_for_class(project.map_or(0, |m| m.class_id)), file.file_name);
            let sha1 = file.sha1().unwrap_or_default().to_string();
            match file.url() {
                Some(url) => files_out.push(PackFile { path, url: url.to_string(), sha1, headers: cdn_headers(url) }),
                None => {
                    let site = project
                        .and_then(|m| m.links.as_ref())
                        .and_then(|l| non_empty(l.website_url.clone()))
                        .unwrap_or_else(|| format!("https://www.curseforge.com/projects/{}", r.project_id));
                    blocked.push(BlockedFile {
                        path,
                        sha1,
                        name: project.map_or_else(|| file.file_name.clone(), |m| m.name.clone()),
                        page_url: format!("{}/download/{}", site.trim_end_matches('/'), file.id),
                    });
                }
            }
        }
        Ok(PackFiles { files: files_out, blocked })
    }

    fn icon_prefixes(&self) -> &'static [&'static str] {
        &["https://media.forgecdn.net/"]
    }
}

/// CurseForge's descriptions are HTML while the UI renders (safe) Markdown, so this keeps the
/// structure that survives there: headings, paragraphs, lists, images, bold and code. Every other
/// tag is dropped down to its text.
fn html_to_markdown(html: &str) -> String {
    let mut out = String::new();
    let mut in_pre = false;
    let mut rest = html;
    while let Some(open) = rest.find('<') {
        push_text(&mut out, &rest[..open], in_pre);
        rest = &rest[open..];
        if let Some(comment) = rest.strip_prefix("<!--") {
            rest = comment.find("-->").map_or("", |end| &comment[end + 3..]);
            continue;
        }
        let Some(close) = rest.find('>') else {
            rest = "";
            break;
        };
        let tag = &rest[1..close];
        rest = &rest[close + 1..];

        let closing = tag.starts_with('/');
        let name = tag
            .trim_start_matches('/')
            .split(|c: char| c.is_whitespace() || c == '/')
            .next()
            .unwrap_or("")
            .to_ascii_lowercase();
        match (name.as_str(), closing) {
            ("script" | "style", false) => {
                let end_tag = format!("</{}", name);
                rest = rest
                    .to_ascii_lowercase()
                    .find(&end_tag)
                    .and_then(|at| rest[at..].find('>').map(|end| &rest[at + end + 1..]))
                    .unwrap_or("");
            }
            ("h1" | "h2" | "h3" | "h4" | "h5" | "h6", false) => {
                out.push_str(&format!("\n\n{} ", "#".repeat(name[1..].parse().unwrap_or(1))));
            }
            ("h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "p" | "div" | "ul" | "ol" | "table" | "tr" | "blockquote", _) => {
                out.push_str("\n\n");
            }
            ("br", _) => out.push('\n'),
            ("li", false) => out.push_str("\n- "),
            ("li", true) => out.push('\n'),
            ("strong" | "b", _) => out.push_str("**"),
            ("code", _) if !in_pre => out.push('`'),
            ("pre", false) => {
                in_pre = true;
                out.push_str("\n\n```\n");
            }
            ("pre", true) => {
                in_pre = false;
                out.push_str("\n```\n\n");
            }
            ("img", false) => {
                if let Some(src) = html_attr(tag, "src").filter(|s| s.starts_with("https://") || s.starts_with("http://")) {
                    let alt = html_attr(tag, "alt").unwrap_or_default().replace(['[', ']'], "");
                    out.push_str(&format!("\n\n![{}]({})\n\n", alt, src));
                }
            }
            _ => {}
        }
    }
    push_text(&mut out, rest, in_pre);

    let mut tidy = String::new();
    let mut blank_lines = 0;
    for line in out.lines() {
        // A `<strong>` that only wrapped an image leaves bare markers behind.
        if matches!(line.trim(), "" | "**") {
            blank_lines += 1;
            continue;
        }
        if blank_lines > 0 && !tidy.is_empty() {
            tidy.push_str("\n\n");
        } else if !tidy.is_empty() {
            tidy.push('\n');
        }
        blank_lines = 0;
        tidy.push_str(line.trim_end());
    }
    tidy
}

/// Appends HTML text: entities decoded, whitespace collapsed unless inside `<pre>`.
fn push_text(out: &mut String, text: &str, in_pre: bool) {
    let text = decode_entities(text);
    if in_pre {
        out.push_str(&text);
        return;
    }
    for c in text.chars() {
        if !c.is_whitespace() {
            out.push(c);
        } else if !out.ends_with(char::is_whitespace) {
            out.push(' ');
        }
    }
}

fn decode_entities(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(at) = rest.find('&') {
        out.push_str(&rest[..at]);
        rest = &rest[at..];
        let decoded = rest.find(';').filter(|&end| end <= 10).and_then(|end| entity(&rest[1..end]).map(|c| (c, end)));
        match decoded {
            Some((c, end)) => {
                out.push(c);
                rest = &rest[end + 1..];
            }
            None => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

fn entity(name: &str) -> Option<char> {
    match name {
        "amp" => Some('&'),
        "lt" => Some('<'),
        "gt" => Some('>'),
        "quot" => Some('"'),
        "apos" => Some('\''),
        "nbsp" => Some(' '),
        _ => {
            let number = name.strip_prefix('#')?;
            let code = match number.strip_prefix(['x', 'X']) {
                Some(hex) => u32::from_str_radix(hex, 16).ok()?,
                None => number.parse().ok()?,
            };
            char::from_u32(code)
        }
    }
}

/// The quoted value of attribute `name` in the text of one tag.
fn html_attr(tag: &str, name: &str) -> Option<String> {
    let start = tag.to_ascii_lowercase().find(&format!(" {}=", name))? + name.len() + 2;
    let value = &tag[start..];
    let quote = value.chars().next().filter(|c| matches!(c, '"' | '\''))?;
    let end = value[1..].find(quote)?;
    Some(decode_entities(&value[1..1 + end]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn description_html_becomes_markdown() {
        let html = "<h2>About &amp; more</h2><p>Some <strong>bold</strong>\n text.<br/>Next</p>\
                    <ul><li>one</li><li>two</li></ul><img src=\"https://media.forgecdn.net/a.png\" alt=\"A [pic]\">\
                    <script>alert(1)</script><!-- hidden --><pre>a  b</pre>";
        assert_eq!(
            html_to_markdown(html),
            "## About & more\n\nSome **bold** text.\nNext\n\n- one\n\n- two\n\n![A pic](https://media.forgecdn.net/a.png)\n\n```\na  b\n```"
        );
        assert_eq!(html_to_markdown("<img src=\"javascript:x\">"), "");
        assert_eq!(
            html_to_markdown("<p><strong><img src=\"https://x.test/a.png\"></strong></p>"),
            "![](https://x.test/a.png)"
        );
    }

    #[test]
    fn versions_sort_numerically() {
        let mut v = vec!["1.20.1", "1.9", "1.21"];
        v.sort_by_key(|s| version_key(s));
        assert_eq!(v, ["1.9", "1.20.1", "1.21"]);
    }

    #[test]
    fn the_key_goes_only_to_cdn_hosts_over_https() {
        std::env::set_var("CURSEFORGE_API_KEY", "test-key");
        assert_eq!(cdn_headers("https://edge.forgecdn.net/files/1/2/a.jar"), vec![("x-api-key", "test-key".to_string())]);
        assert!(cdn_headers("https://example.com/a.jar").is_empty());
        assert!(cdn_headers("https://forgecdn.net.example.com/a.jar").is_empty());
        assert!(cdn_headers("http://edge.forgecdn.net/a.jar").is_empty());
    }

    /// Walks the real API end to end (needs `CURSEFORGE_API_KEY`), so a changed response shape shows
    /// up here: `cargo test -p minecraft live_ -- --ignored --nocapture`.
    #[tokio::test]
    #[ignore]
    async fn live_api_smoke() {
        let cf = CurseForge;
        assert!(cf.unavailable().is_none(), "set CURSEFORGE_API_KEY");

        // Two pages' worth: the 50-per-request limit is stitched together.
        let packs = cf
            .search(&SearchQuery { category: "modpacks".into(), limit: 60, sort: "popularity".into(), ..Default::default() })
            .await
            .unwrap();
        assert_eq!(packs.hits.len(), 60);
        let pack = &packs.hits[0];
        println!("top pack: {} ({} downloads), total {}", pack.title, pack.downloads, packs.total_hits);
        assert!(pack.updated.is_some() && !pack.game_versions.is_empty());
        assert!(pack.url.starts_with("https://") && !pack.slug.is_empty() && !pack.authors.is_empty(), "{:?}", pack.url);
        println!("  {} | slug {} | authors {:?}", pack.url, pack.slug, pack.authors);
        println!("  updated {:?}, versions {:?}, loaders {:?}", pack.updated, pack.game_versions, pack.loaders);

        let detail = cf.project(&pack.project_id).await.unwrap();
        assert!(detail.url.starts_with("https://"));
        println!("description as markdown:
{}", detail.body.chars().take(300).collect::<String>());

        let versions = cf.modpack_versions(&pack.project_id).await.unwrap();
        assert!(!versions.is_empty());
        println!("{} builds, newest: {} {:?} {:?}", versions.len(), versions[0].version_number, versions[0].game_versions, versions[0].loaders);
        let file = cf
            .resolve_file(&FileRequest {
                category: "modpacks".into(),
                project_id: pack.project_id.clone(),
                version_id: Some(versions[0].id.clone()),
                ..Default::default()
            })
            .await
            .unwrap();
        assert!(file.url.starts_with("https://") && file.sha1.len() == 40);

        let wanted = SearchQuery {
            category: "mods".into(),
            minecraft_version: "1.20.1".into(),
            loader: "fabric".into(),
            limit: 5,
            ..Default::default()
        };
        let mods = cf.search(&wanted).await.unwrap();
        assert!(!mods.hits.is_empty());
        let categories = cf.categories("mods").await.unwrap();
        assert!(!categories.is_empty());
        for class in ["resourcepacks", "shaderpacks", "datapacks"] {
            let found = cf.search(&SearchQuery { category: class.into(), limit: 3, ..Default::default() }).await.unwrap();
            assert!(!found.hits.is_empty(), "{class}");
        }

        // A real mod file: newest build for 1.20.1/Fabric, downloaded and SHA-1 checked.
        let jei = FileRequest {
            category: "mods".into(),
            project_id: mods.hits[0].project_id.clone(),
            minecraft_version: "1.20.1".into(),
            loader: "fabric".into(),
            ..Default::default()
        };
        let mod_file = cf.resolve_file(&jei).await.unwrap();
        let dest = std::env::temp_dir().join(format!("nihao-live-{}-{}", std::process::id(), mod_file.filename));
        super::super::download_verified(&mod_file, dest.clone()).await.unwrap();
        println!("downloaded {} ({} bytes), sha1 verified", mod_file.filename, std::fs::metadata(&dest).unwrap().len());
        let _ = std::fs::remove_file(&dest);

        // The pack's own file, by id through the bulk endpoint.
        let refs = [PackFileRef { project_id: "925200".into(), file_id: "9190157".into() }];
        let resolved = cf.resolve_pack_files(&refs).await.unwrap();
        assert_eq!(resolved.files.len() + resolved.blocked.len(), 1);
        println!("pack file resolves to {}", resolved.files[0].path);
    }

    #[test]
    fn ids_must_be_numbers() {
        assert_eq!(numeric("238222").unwrap(), 238222);
        assert!(numeric("../x").is_err());
    }
}
