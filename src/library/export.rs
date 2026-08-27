//! Exporting a local instance for sharing outside this launcher — see MODPACK_FORMAT.md's
//! "Share export" section. Two formats, both a single self-contained zip a receiver can use
//! with no server involved:
//!
//! - **Own format** (`export_own_format`): this project's `ModpackManifest` (`manifest.json`)
//!   plus every file's actual bytes under `files/`. Unlike the `pack` field on `profile.nihao`
//!   (which only lists hashes and expects a server to host the bytes for diffing), this bundles
//!   everything needed to reconstruct the instance on its own.
//! - **Modrinth `.mrpack`** (`export_mrpack`): the standard format other launchers understand.
//!   Every file is hashed (sha1) and checked against Modrinth's `version_files` API — files it
//!   recognizes point straight at Modrinth's CDN in `modrinth.index.json`; everything else
//!   (configs, local-only files, anything not on Modrinth) is bundled under `overrides/`.

use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use reqwest::Client;
use serde::{Deserialize, Serialize};
use sha1::{Digest, Sha1};
use zip::write::FileOptions;
use zip::ZipWriter;

use super::modpack_format::{hash_file, walk_export_paths, FileSource, ModpackFileEntry, ModpackManifest, MODPACK_FORMAT_VERSION};
use super::version::MinecraftLoader;

fn zip_options() -> FileOptions {
    FileOptions::default().compression_method(zip::CompressionMethod::Deflated)
}

fn to_zip_path(prefix: &str, rel: &Path) -> String {
    format!("{}/{}", prefix, rel.to_string_lossy().replace('\\', "/"))
}

/// One tick of export progress — shaped like `interface.rs`'s `InstallProgress` (which the
/// launcher's bottom `.progress` bar already knows how to render) so the caller there can just
/// copy the fields across instead of this module needing to know about that FFI-facing type.
#[derive(Clone)]
pub struct ExportProgress {
    pub etap: String,
    pub current_etaps: usize,
    pub total_etaps: usize,
    pub current_file: usize,
    pub total_files: usize,
    pub status: String,
    pub filename: String,
}

pub type ProgressCallback = Arc<dyn Fn(ExportProgress) + Send + Sync>;

/// Keeps only the files whose top-level folder/file (the player's checklist selection —
/// `list_top_level_entries` in `modpack_format.rs`) was included. A file with no components
/// (shouldn't happen — `walk_export_paths` always returns at least one) is dropped rather than
/// risk exporting something the player didn't ask for.
fn filter_by_top_level(paths: Vec<PathBuf>, include: &HashSet<String>) -> Vec<PathBuf> {
    paths
        .into_iter()
        .filter(|rel| {
            rel.components()
                .next()
                .map(|c| include.contains(c.as_os_str().to_string_lossy().as_ref()))
                .unwrap_or(false)
        })
        .collect()
}

// ───────────────────────────── Own format ─────────────────────────────

pub async fn export_own_format(
    instance_dir: PathBuf,
    id: String,
    name: String,
    build: u64,
    version: Option<String>,
    minecraft_version: String,
    loader: MinecraftLoader,
    loader_version: Option<String>,
    include: HashSet<String>,
    dest_path: PathBuf,
    on_progress: ProgressCallback,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let rel_paths = filter_by_top_level(walk_export_paths(&instance_dir)?, &include);
        let total = rel_paths.len();

        let mut files = Vec::with_capacity(total);
        for (i, rel) in rel_paths.iter().enumerate() {
            let filename = rel.to_string_lossy().replace('\\', "/");
            on_progress(ExportProgress {
                etap: "Hashing files".to_string(),
                current_etaps: 1,
                total_etaps: 2,
                current_file: i,
                total_files: total,
                status: "check".to_string(),
                filename: filename.clone(),
            });
            let (sha256, size) = hash_file(&instance_dir.join(rel))?;
            files.push(ModpackFileEntry { path: filename, sha256, size, source: FileSource::Server });
        }

        let manifest = ModpackManifest {
            format_version: MODPACK_FORMAT_VERSION,
            id,
            name,
            build,
            version,
            minecraft_version,
            loader,
            loader_version,
            files,
        };

        let file = std::fs::File::create(&dest_path)
            .map_err(|e| format!("Cannot create export file: {}", e))?;
        let mut zip = ZipWriter::new(file);

        zip.start_file("manifest.json", zip_options()).map_err(|e| e.to_string())?;
        let manifest_json = serde_json::to_vec_pretty(&manifest).map_err(|e| e.to_string())?;
        zip.write_all(&manifest_json).map_err(|e| e.to_string())?;

        for (i, rel) in rel_paths.iter().enumerate() {
            on_progress(ExportProgress {
                etap: "Writing archive".to_string(),
                current_etaps: 2,
                total_etaps: 2,
                current_file: i,
                total_files: total,
                status: "write".to_string(),
                filename: rel.to_string_lossy().replace('\\', "/"),
            });
            let abs = instance_dir.join(rel);
            let bytes = std::fs::read(&abs).map_err(|e| format!("Cannot read '{}': {}", abs.display(), e))?;
            zip.start_file(to_zip_path("files", rel), zip_options()).map_err(|e| e.to_string())?;
            zip.write_all(&bytes).map_err(|e| e.to_string())?;
        }

        zip.finish().map_err(|e| e.to_string())?;
        Ok(())
    })
    .await
    .map_err(|e| format!("Export task panicked: {}", e))?
}

// ───────────────────────────── Modrinth .mrpack ─────────────────────────────

const MODRINTH_API_BASE: &str = "https://api.modrinth.com/v2";
/// Keeps each hash-lookup request modest — Modrinth doesn't document a hard cap, but there's
/// no reason to send a pack's entire file list (potentially hundreds of entries) in one call.
const HASH_LOOKUP_CHUNK: usize = 200;

#[derive(Serialize)]
struct MrpackIndex {
    #[serde(rename = "formatVersion")]
    format_version: u32,
    game: &'static str,
    #[serde(rename = "versionId")]
    version_id: String,
    name: String,
    files: Vec<MrpackFile>,
    dependencies: HashMap<String, String>,
}

#[derive(Serialize)]
struct MrpackFile {
    path: String,
    hashes: MrpackHashes,
    env: MrpackEnv,
    downloads: Vec<String>,
    #[serde(rename = "fileSize")]
    file_size: u64,
}

#[derive(Serialize)]
struct MrpackHashes {
    sha1: String,
    sha512: String,
}

#[derive(Serialize)]
struct MrpackEnv {
    client: &'static str,
    server: &'static str,
}

#[derive(Deserialize)]
struct ModrinthVersionResponse {
    files: Vec<ModrinthFileResponse>,
}

#[derive(Deserialize, Clone)]
struct ModrinthFileResponse {
    hashes: ModrinthHashesResponse,
    url: String,
    primary: bool,
    size: u64,
}

#[derive(Deserialize, Clone)]
struct ModrinthHashesResponse {
    sha1: String,
    sha512: String,
}

pub(crate) fn hash_file_sha1(path: &Path) -> Result<(String, u64), String> {
    let mut file =
        std::fs::File::open(path).map_err(|e| format!("Cannot read '{}': {}", path.display(), e))?;
    let mut hasher = Sha1::new();
    let mut buffer = [0u8; 65536];
    let mut size = 0u64;
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|e| format!("Cannot read '{}': {}", path.display(), e))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        size += read as u64;
    }
    Ok((format!("{:x}", hasher.finalize()), size))
}

/// Looks up every hash against Modrinth's `POST /version_files` — files it doesn't recognize
/// (or if the request itself fails, e.g. no internet) simply aren't in the returned map, and
/// the caller falls back to bundling them as overrides instead. Never errors for that reason.
async fn lookup_modrinth_hashes(hashes: &[String], on_progress: &ProgressCallback) -> HashMap<String, ModrinthFileResponse> {
    let mut result = HashMap::new();
    let client = Client::new();
    let chunks: Vec<&[String]> = hashes.chunks(HASH_LOOKUP_CHUNK).collect();
    let total_chunks = chunks.len().max(1);

    for (i, chunk) in chunks.into_iter().enumerate() {
        on_progress(ExportProgress {
            etap: "Checking Modrinth".to_string(),
            current_etaps: 2,
            total_etaps: 3,
            current_file: i,
            total_files: total_chunks,
            status: "check".to_string(),
            filename: String::new(),
        });

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
            if let Some(file) = version.files.iter().find(|f| f.primary).or_else(|| version.files.first()) {
                result.insert(hash, file.clone());
            }
        }
    }

    result
}

fn loader_dependency_key(loader: &MinecraftLoader) -> Option<&'static str> {
    match loader {
        MinecraftLoader::VANILLA => None,
        MinecraftLoader::FABRIC => Some("fabric-loader"),
        MinecraftLoader::FORGE => Some("forge"),
        MinecraftLoader::NEOFORGE => Some("neoforge"),
    }
}

pub async fn export_mrpack(
    instance_dir: PathBuf,
    name: String,
    version_label: String,
    minecraft_version: String,
    loader: MinecraftLoader,
    loader_version: Option<String>,
    include: HashSet<String>,
    dest_path: PathBuf,
    on_progress: ProgressCallback,
) -> Result<(), String> {
    let dir = instance_dir.clone();
    let hash_progress = on_progress.clone();
    let hashed: Vec<(PathBuf, String, u64)> = tokio::task::spawn_blocking(move || {
        let rel_paths = filter_by_top_level(walk_export_paths(&dir)?, &include);
        let total = rel_paths.len();
        rel_paths
            .into_iter()
            .enumerate()
            .map(|(i, rel)| {
                hash_progress(ExportProgress {
                    etap: "Hashing files".to_string(),
                    current_etaps: 1,
                    total_etaps: 3,
                    current_file: i,
                    total_files: total,
                    status: "check".to_string(),
                    filename: rel.to_string_lossy().replace('\\', "/"),
                });
                let (sha1, size) = hash_file_sha1(&dir.join(&rel))?;
                Ok::<_, String>((rel, sha1, size))
            })
            .collect::<Result<Vec<_>, String>>()
    })
    .await
    .map_err(|e| format!("Export task panicked: {}", e))??;

    let all_hashes: Vec<String> = hashed.iter().map(|(_, sha1, _)| sha1.clone()).collect();
    let resolved = lookup_modrinth_hashes(&all_hashes, &on_progress).await;

    let mut index_files = Vec::new();
    let mut override_paths = Vec::new();
    for (rel, sha1, _size) in &hashed {
        match resolved.get(sha1) {
            Some(found) => index_files.push(MrpackFile {
                path: rel.to_string_lossy().replace('\\', "/"),
                hashes: MrpackHashes { sha1: found.hashes.sha1.clone(), sha512: found.hashes.sha512.clone() },
                env: MrpackEnv { client: "required", server: "required" },
                downloads: vec![found.url.clone()],
                file_size: found.size,
            }),
            None => override_paths.push(rel.clone()),
        }
    }

    let mut dependencies = HashMap::new();
    dependencies.insert("minecraft".to_string(), minecraft_version);
    if let Some(key) = loader_dependency_key(&loader) {
        if let Some(v) = &loader_version {
            dependencies.insert(key.to_string(), v.clone());
        }
    }

    let index = MrpackIndex {
        format_version: 1,
        game: "minecraft",
        version_id: version_label,
        name,
        files: index_files,
        dependencies,
    };

    let override_total = override_paths.len();
    tokio::task::spawn_blocking(move || {
        let file = std::fs::File::create(&dest_path)
            .map_err(|e| format!("Cannot create export file: {}", e))?;
        let mut zip = ZipWriter::new(file);

        zip.start_file("modrinth.index.json", zip_options()).map_err(|e| e.to_string())?;
        let index_json = serde_json::to_vec_pretty(&index).map_err(|e| e.to_string())?;
        zip.write_all(&index_json).map_err(|e| e.to_string())?;

        for (i, rel) in override_paths.iter().enumerate() {
            on_progress(ExportProgress {
                etap: "Writing archive".to_string(),
                current_etaps: 3,
                total_etaps: 3,
                current_file: i,
                total_files: override_total,
                status: "write".to_string(),
                filename: rel.to_string_lossy().replace('\\', "/"),
            });
            let abs = instance_dir.join(rel);
            let bytes = std::fs::read(&abs).map_err(|e| format!("Cannot read '{}': {}", abs.display(), e))?;
            zip.start_file(to_zip_path("overrides", rel), zip_options()).map_err(|e| e.to_string())?;
            zip.write_all(&bytes).map_err(|e| e.to_string())?;
        }

        zip.finish().map_err(|e| e.to_string())?;
        Ok(())
    })
    .await
    .map_err(|e| format!("Export task panicked: {}", e))?
}
