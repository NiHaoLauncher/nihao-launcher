//! Resolves display name/icon (and version) for mods/resourcepacks/shaderpacks/datapacks in the
//! Content Manager, backed by one persistent cache (`cache.nihao`, per instance) so re-opening the
//! panel or toggling a file never re-parses/re-queries the rest. Two sources per file, in order:
//! (1) what the file carries locally (see `mod_metadata.rs`; shaderpacks have none); (2) the online
//! services (`services::identify_files`) by content hash, for all four categories. It is attempted
//! for every file (not directories) even when local metadata has a name/icon, because it is the
//! only way to learn the `(service, project_id)` that Browse's "Installed" detection needs.

use std::collections::HashMap;
use std::path::Path;
use std::time::UNIX_EPOCH;

use reqwest::Client;
use serde::{Deserialize, Serialize};

use super::modpack_format::hash_file_sha1;
use super::mod_metadata::{self, to_data_uri, ModMetadata};
use super::services;

const CACHE_FILE_NAME: &str = "cache.nihao";
const MAX_ICON_BYTES: usize = 2 * 1024 * 1024;

/// Serializes the final read-merge-write of `cache.nihao`, so two categories scanning at once
/// can't overwrite each other's results.
static CACHE_SAVE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[derive(Clone)]
pub struct ResolvedContent {
    pub display_name: Option<String>,
    pub version: Option<String>,
    pub icon_data: Option<String>,
    /// Set only when an online lookup actually matched; `None` for a file fully resolved locally,
    /// even if it has an online page. Good enough for "is this already installed?" in Browse:
    /// files installed through Browse are the ones likely to lack local metadata.
    pub project_id: Option<String>,
    /// `ServiceInfo::id` of the service `project_id` belongs to; set together with it.
    pub service: Option<String>,
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
    #[serde(default)]
    service: Option<String>,
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

    /// Write-then-rename, so a crash mid-write can't leave a truncated cache.
    fn save(&self, instance_dir: &Path) {
        if let Ok(json) = serde_json::to_string(self) {
            let tmp = instance_dir.join(format!("{}.tmp", CACHE_FILE_NAME));
            if std::fs::write(&tmp, json).is_ok() {
                let _ = std::fs::rename(&tmp, instance_dir.join(CACHE_FILE_NAME));
            }
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

async fn download_icon(client: &Client, url: &str) -> Option<String> {
    let bytes = client.get(url).send().await.ok()?.error_for_status().ok()?.bytes().await.ok()?;
    if bytes.len() > MAX_ICON_BYTES {
        return None;
    }
    Some(to_data_uri(&bytes))
}

/// Resolves every `(filename, is_dir, metadata)` in `{instance_dir}/{category}`
/// (`mods`/`resourcepacks`/`shaderpacks`/`datapacks`) against the cache, filling in new or changed
/// entries via local parsing plus an online-service fallback, then persists the cache (pruning vanished
/// files). `on_progress(done, total)` fires once up front with the number of files that need
/// (re)resolving (cache-fresh ones don't count) and after each one, so the Content manager can show
/// real progress on a first scan of a big modpack.
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
                        // Entries cached before there were several services were all Modrinth's.
                        service: e.service.clone().or_else(|| e.project_id.as_ref().map(|_| "modrinth".to_string())),
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
            // Always attempted for a non-directory file, even when local metadata is complete: the
            // hash lookup is the only way to learn the online `project_id` that Browse's
            // "Installed" detection needs.
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

        let mut resolved_by_hash: HashMap<String, ResolvedContent> = HashMap::new();
        let mut done = 0usize;
        if !needs_lookup.is_empty() {
            let hashes: Vec<String> = needs_lookup.iter().map(|(_, h)| h.clone()).collect();
            let known_by_hash = services::identify_files(&hashes, |_, _| {}).await;
            let mut ids_by_service: HashMap<&str, Vec<String>> = HashMap::new();
            for known in known_by_hash.values() {
                ids_by_service.entry(known.service).or_default().push(known.project_id.clone());
            }
            let mut projects = HashMap::new(); // (service, project id) -> title/icon
            for (service_id, ids) in ids_by_service {
                if let Ok(service) = services::get(service_id) {
                    for (id, brief) in service.project_briefs(&ids).await {
                        projects.insert((service_id, id), brief);
                    }
                }
            }

            let client = Client::new();
            let mut icon_cache: HashMap<String, Option<String>> = HashMap::new();
            // Iterates `needs_lookup` (one entry per file, unlike the hash-deduplicated
            // `known_by_hash`) so a progress tick lands per file, right after that file's icon
            // downloads, where most of a first scan's time goes (one sequential round trip per
            // distinct icon).
            for (_, hash) in &needs_lookup {
                if !resolved_by_hash.contains_key(hash) {
                    if let Some(known) = known_by_hash.get(hash) {
                        if let Some(project) = projects.get(&(known.service, known.project_id.clone())) {
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
                                ResolvedContent {
                                    display_name: Some(project.title.clone()),
                                    version: Some(known.version_number.clone()),
                                    icon_data: icon,
                                    project_id: Some(known.project_id.clone()),
                                    service: Some(known.service.to_string()),
                                },
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
            let online = looked_up.as_ref().and_then(|h| resolved_by_hash.get(h));

            let display_name = info.name.clone().or_else(|| online.and_then(|o| o.display_name.clone()));
            let version = info.version.clone().or_else(|| online.and_then(|o| o.version.clone()));
            let icon_data = info.icon_data.clone().or_else(|| online.and_then(|o| o.icon_data.clone()));
            let project_id = online.and_then(|o| o.project_id.clone());
            let service = online.and_then(|o| o.service.clone());

            entries.insert(filename.clone(), CacheEntry {
                size: fp.0,
                mtime: fp.1,
                display_name: display_name.clone(),
                version: version.clone(),
                icon_data: icon_data.clone(),
                project_id: project_id.clone(),
                service: service.clone(),
            });
            result.insert(filename, ResolvedContent { display_name, version, icon_data, project_id, service });
            // A directory (or an unhashable file) never went through `needs_lookup`, so it gets
            // its progress tick here.
            if looked_up.is_none() {
                done += 1;
                on_progress(done.min(total_stale), total_stale);
            }
        }
    }

    // Prune files that no longer exist so the cache doesn't grow unbounded.
    let current: std::collections::HashSet<&String> = files.iter().map(|(f, _, _)| f).collect();
    cache.entries_mut(category).retain(|filename, _| current.contains(filename));

    {
        let _guard = CACHE_SAVE_LOCK.lock().unwrap();
        let mut latest = ContentCache::load(instance_dir);
        *latest.entries_mut(category) = std::mem::take(cache.entries_mut(category));
        latest.save(instance_dir);
    }
    result
}
