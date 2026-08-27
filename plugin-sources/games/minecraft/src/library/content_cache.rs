//! Resolves display name/icon (and, secondarily, version) for mods/resourcepacks/shaderpacks/
//! datapacks in the Content Manager, backed by one persistent cache (`cache.nihao`, one per
//! instance) so re-opening the panel — or toggling/deleting a single file — never has to
//! re-parse/re-query everything else again. Two sources per file, in order:
//! 1. Whatever the file itself carries locally — see `mod_metadata.rs` (mods: fabric.mod.json/
//!    mods.toml/mcmod.info; resourcepacks/datapacks: pack.mcmeta + pack.png; shaderpacks: none,
//!    there's no standard metadata file for them).
//! 2. Modrinth, by content hash — hosts mods, resourcepacks, shaderpacks, and datapacks alike,
//!    so the same lookup applies uniformly to all four categories. Attempted for every single
//!    file (not a directory — an unpacked pack has nothing to hash as one blob), even when local
//!    metadata already has a name/icon: it's also the only way to learn the file's Modrinth
//!    `project_id`, which "Installed" detection in Browse content needs regardless of where the
//!    name/icon ultimately came from. Local data still always wins on conflicts (see the merge
//!    in `resolve_content`) — this lookup only ever fills gaps or supplies `project_id`, and its
//!    icon download is skipped outright when the local file already has one, since a one-time
//!    hash+`project_id` lookup is cheap but a discarded icon download isn't.

use std::collections::HashMap;
use std::path::Path;
use std::time::UNIX_EPOCH;

use reqwest::Client;
use serde::{Deserialize, Serialize};

use super::export::hash_file_sha1;
use super::mod_metadata::{self, to_data_uri, ModMetadata};

const CACHE_FILE_NAME: &str = "cache.nihao";
const MODRINTH_API_BASE: &str = "https://api.modrinth.com/v2";
const HASH_LOOKUP_CHUNK: usize = 200;

#[derive(Clone)]
pub struct ResolvedContent {
    pub display_name: Option<String>,
    pub version: Option<String>,
    pub icon_data: Option<String>,
    /// Only ever set when a Modrinth lookup actually happened and matched — `None` for a file
    /// fully resolved from its own local metadata (no lookup needed) even if it genuinely does
    /// have a Modrinth page. Good enough for "is this already installed?" (Browse content) —
    /// files installed *through* Browse are the ones that matter there, and those are exactly
    /// the ones likely to still be missing something locally the first time they're seen.
    pub project_id: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Default)]
struct CacheEntry {
    size: u64,
    mtime: u64,
    #[serde(default)]
    display_name: Option<String>,
    #[serde(default)]
    version: Option<String>,
    #[serde(default)]
    icon_data: Option<String>,
    #[serde(default)]
    project_id: Option<String>,
}

/// One `cache.nihao`, split by category so a mod and a resourcepack that happen to share a
/// filename never collide.
#[derive(Serialize, Deserialize, Default)]
struct ContentCache {
    #[serde(default)]
    mods: HashMap<String, CacheEntry>,
    #[serde(default)]
    resourcepacks: HashMap<String, CacheEntry>,
    #[serde(default)]
    shaderpacks: HashMap<String, CacheEntry>,
    #[serde(default)]
    datapacks: HashMap<String, CacheEntry>,
}

impl ContentCache {
    fn load(instance_dir: &Path) -> Self {
        std::fs::read_to_string(instance_dir.join(CACHE_FILE_NAME))
            .ok()
            .and_then(|content| serde_json::from_str(&content).ok())
            .unwrap_or_default()
    }

    fn save(&self, instance_dir: &Path) {
        if let Ok(json) = serde_json::to_string(self) {
            let _ = std::fs::write(instance_dir.join(CACHE_FILE_NAME), json);
        }
    }

    fn entries_mut(&mut self, category: &str) -> &mut HashMap<String, CacheEntry> {
        match category {
            "resourcepacks" => &mut self.resourcepacks,
            "shaderpacks" => &mut self.shaderpacks,
            "datapacks" => &mut self.datapacks,
            _ => &mut self.mods,
        }
    }
}

fn fingerprint(metadata: &std::fs::Metadata) -> (u64, u64) {
    let size = metadata.len();
    let mtime = metadata
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    (size, mtime)
}

fn local_metadata(category: &str, path: &Path, is_dir: bool) -> ModMetadata {
    match category {
        "resourcepacks" | "datapacks" => mod_metadata::read_pack_metadata(path, is_dir),
        "shaderpacks" => ModMetadata { name: None, version: None, icon_data: None },
        _ => mod_metadata::read_mod_metadata(path),
    }
}

#[derive(Deserialize)]
struct ModrinthVersionResponse {
    project_id: String,
    version_number: String,
}

/// `POST /version_files` — every hash that matches something on Modrinth maps to the project
/// (and the specific version's own label) it belongs to. Best-effort: a failed/unreachable
/// request (or a hash Modrinth doesn't recognize) just means those files aren't in the result,
/// never an error.
async fn lookup_versions_by_hash(hashes: &[String]) -> HashMap<String, (String, String)> {
    let mut result = HashMap::new();
    let client = Client::new();

    for chunk in hashes.chunks(HASH_LOOKUP_CHUNK) {
        let body = serde_json::json!({ "hashes": chunk, "algorithm": "sha1" });
        let response = match client
            .post(format!("{}/version_files", MODRINTH_API_BASE))
            .json(&body)
            .send()
            .await
        {
            Ok(res) if res.status().is_success() => res,
            _ => continue,
        };
        let parsed: HashMap<String, ModrinthVersionResponse> = match response.json().await {
            Ok(v) => v,
            Err(_) => continue,
        };
        for (hash, version) in parsed {
            result.insert(hash, (version.project_id, version.version_number));
        }
    }

    result
}

#[derive(Deserialize)]
struct ModrinthProjectResponse {
    id: String,
    title: String,
    icon_url: Option<String>,
}

/// `GET /projects?ids=[...]` — batch project lookup for title/icon, one call regardless of how
/// many distinct projects were matched by `lookup_versions_by_hash`.
async fn lookup_projects(ids: &[String]) -> HashMap<String, ModrinthProjectResponse> {
    if ids.is_empty() {
        return HashMap::new();
    }
    let ids_param = serde_json::to_string(ids).unwrap_or_else(|_| "[]".to_string());
    let client = Client::new();
    let response = match client
        .get(format!("{}/projects", MODRINTH_API_BASE))
        .query(&[("ids", ids_param)])
        .send()
        .await
    {
        Ok(res) if res.status().is_success() => res,
        _ => return HashMap::new(),
    };
    let projects: Vec<ModrinthProjectResponse> = response.json().await.unwrap_or_default();
    projects.into_iter().map(|p| (p.id.clone(), p)).collect()
}

async fn download_icon(client: &Client, url: &str) -> Option<String> {
    let bytes = client.get(url).send().await.ok()?.bytes().await.ok()?;
    Some(to_data_uri(&bytes))
}

/// Resolves every `(filename, is_dir, metadata)` triple in `{instance_dir}/{category}` against
/// the cache, filling in anything new/changed via local parsing + a Modrinth fallback, then
/// persists the updated cache (pruning entries for files that no longer exist) before
/// returning. `category` is one of `"mods"`/`"resourcepacks"`/`"shaderpacks"`/`"datapacks"`.
/// `on_progress(done, total)` is called once up front with the number of files that actually
/// need (re)resolving — everything already cache-fresh is instant and doesn't count — and once
/// more after each one finishes, so a caller like the Content manager panel's first load after
/// importing a modpack (parsing/hashing/Modrinth-looking-up a hundred-plus mods can genuinely
/// take several seconds) can show real progress instead of an indefinite spinner.
pub async fn resolve_content(
    category: &str,
    instance_dir: &Path,
    files: &[(String, bool, std::fs::Metadata)],
    on_progress: &(dyn Fn(usize, usize) + Send + Sync),
) -> HashMap<String, ResolvedContent> {
    let content_dir = instance_dir.join(category);
    let mut cache = ContentCache::load(instance_dir);
    let mut result = HashMap::new();

    let mut stale: Vec<(String, bool, std::fs::Metadata)> = Vec::new();
    {
        let entries = cache.entries_mut(category);
        for (filename, is_dir, meta) in files {
            let fp = fingerprint(meta);
            let cached = entries.get(filename);
            let fresh = cached.map(|e| (e.size, e.mtime) == fp).unwrap_or(false);
            if fresh {
                let e = cached.unwrap();
                result.insert(
                    filename.clone(),
                    ResolvedContent {
                        display_name: e.display_name.clone(),
                        version: e.version.clone(),
                        icon_data: e.icon_data.clone(),
                        project_id: e.project_id.clone(),
                    },
                );
            } else {
                stale.push((filename.clone(), *is_dir, meta.clone()));
            }
        }
    }

    let total_stale = stale.len();
    on_progress(0, total_stale);

    if !stale.is_empty() {
        let mut needs_lookup: Vec<(String, String)> = Vec::new(); // (filename, sha1)
        let mut parsed: HashMap<String, (ModMetadata, (u64, u64))> = HashMap::new();

        let mut icon_needed: std::collections::HashSet<String> = std::collections::HashSet::new();
        for (filename, is_dir, meta) in &stale {
            let path = content_dir.join(filename);
            let info = local_metadata(category, &path, *is_dir);
            let fp = fingerprint(meta);
            // Always attempted for a non-directory file, even when local metadata already has
            // everything — the hash lookup is also the only way to learn a file's Modrinth
            // `project_id`, which "Installed" detection in Browse content needs even for a mod
            // whose name/icon came from its own `fabric.mod.json`/`mods.toml`/etc.
            if !is_dir {
                if let Ok((sha1, _)) = hash_file_sha1(&path) {
                    if info.icon_data.is_none() {
                        icon_needed.insert(sha1.clone());
                    }
                    needs_lookup.push((filename.clone(), sha1));
                }
            }
            parsed.insert(filename.clone(), (info, fp));
        }

        // sha1 -> (name, version, icon, project_id)
        let mut resolved_by_hash: HashMap<String, (Option<String>, Option<String>, Option<String>, Option<String>)> = HashMap::new();
        let mut done = 0usize;
        if !needs_lookup.is_empty() {
            let hashes: Vec<String> = needs_lookup.iter().map(|(_, h)| h.clone()).collect();
            let version_by_hash = lookup_versions_by_hash(&hashes).await;
            let project_ids: Vec<String> = version_by_hash.values().map(|(id, _)| id.clone()).collect();
            let projects = lookup_projects(&project_ids).await;

            let client = Client::new();
            let mut icon_cache: HashMap<String, Option<String>> = HashMap::new();
            // Iterates `needs_lookup` (one entry per *file*, not `version_by_hash`, which is
            // deduplicated by hash) so a progress tick lands for every file, including ones
            // Modrinth didn't recognize at all — and, crucially, so the tick happens right after
            // *this file's* icon (if any) actually finishes downloading, which is where the
            // real wall-clock time goes: the batched hash/project lookups above are one or two
            // requests total, but an icon fetch is one sequential HTTP round trip per file with
            // its own distinct icon, easily the bulk of a first scan's several seconds.
            for (_, hash) in &needs_lookup {
                if !resolved_by_hash.contains_key(hash) {
                    if let Some((project_id, version_number)) = version_by_hash.get(hash) {
                        if let Some(project) = projects.get(project_id) {
                            let icon = if !icon_needed.contains(hash) {
                                None
                            } else if let Some(url) = &project.icon_url {
                                match icon_cache.get(url) {
                                    Some(cached) => cached.clone(),
                                    None => {
                                        let downloaded = download_icon(&client, url).await;
                                        icon_cache.insert(url.clone(), downloaded.clone());
                                        downloaded
                                    }
                                }
                            } else {
                                None
                            };
                            resolved_by_hash.insert(
                                hash.clone(),
                                (Some(project.title.clone()), Some(version_number.clone()), icon, Some(project_id.clone())),
                            );
                        }
                    }
                }
                done += 1;
                on_progress(done, total_stale);
            }
        }

        let entries = cache.entries_mut(category);
        for (filename, (info, fp)) in parsed {
            let looked_up = needs_lookup.iter().find(|(f, _)| f == &filename).map(|(_, h)| h.clone());
            let modrinth = looked_up.as_ref().and_then(|h| resolved_by_hash.get(h));

            let display_name = info.name.clone().or_else(|| modrinth.and_then(|(n, _, _, _)| n.clone()));
            let version = info.version.clone().or_else(|| modrinth.and_then(|(_, v, _, _)| v.clone()));
            let icon_data = info.icon_data.clone().or_else(|| modrinth.and_then(|(_, _, i, _)| i.clone()));
            let project_id = modrinth.and_then(|(_, _, _, p)| p.clone());

            entries.insert(filename.clone(), CacheEntry {
                size: fp.0,
                mtime: fp.1,
                display_name: display_name.clone(),
                version: version.clone(),
                icon_data: icon_data.clone(),
                project_id: project_id.clone(),
            });
            result.insert(filename, ResolvedContent { display_name, version, icon_data, project_id });
            // A directory (or a file whose hash couldn't be computed) never went through
            // `needs_lookup` above, so it never got a progress tick — it was effectively
            // instant, so this is as good a moment as any to count it.
            if looked_up.is_none() {
                done += 1;
                on_progress(done.min(total_stale), total_stale);
            }
        }
    }

    // Prune anything no longer present so the cache doesn't grow unbounded across renames/
    // removals over the life of an instance.
    let current: std::collections::HashSet<&String> = files.iter().map(|(f, _, _)| f).collect();
    cache.entries_mut(category).retain(|filename, _| current.contains(filename));

    cache.save(instance_dir);
    result
}
