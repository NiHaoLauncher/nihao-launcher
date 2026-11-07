//! Exports a local instance for sharing outside this launcher (see MODPACK_FORMAT.md's "Share
//! export"). Every format is one self-contained zip usable with no server:
//!
//! - Own format (`export_own_format`), in two modes (`OwnMode`): `Compress` is a `ModpackManifest`
//! (`manifest.json`) plus every file's bytes under `overrides/`, like a CurseForge pack; unlike
//! `profile.pack` (hashes only, expects a server) it can rebuild the instance on its own. `Full` is
//! the plain files at the zip's root with the instance's `profile.nihao` next to them.
//! - Modrinth `.mrpack` (`export_mrpack`): files an online service recognises by sha1
//! (`services::identify_files`) and that live on a host the format allows point at it in
//! `modrinth.index.json`; the rest (configs, local-only files) go under `overrides/`.

use std::collections::{HashMap, HashSet};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::Serialize;
use sha1::Sha1;
use sha2::Sha256;
use zip::write::FileOptions;
use zip::ZipWriter;

use super::profile::PROFILE_FILE_NAME;
use super::modpack_format::{hash_file, hash_file_sha1, walk_export_paths, FileSource, ModpackFileEntry, ModpackManifest, MODPACK_FORMAT_VERSION};
use super::services::{self, KnownFile};
use super::version::MinecraftLoader;

fn zip_options() -> FileOptions {
    FileOptions::default().compression_method(zip::CompressionMethod::Deflated)
}

fn to_zip_path(prefix: &str, rel: &Path) -> String {
    format!("{}/{}", prefix, rel.to_string_lossy().replace('\\', "/"))
}

/// One tick of export progress, shaped like `interface.rs`'s `InstallProgress` so the caller can
/// copy the fields across without this module knowing the FFI type.
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

/// Keeps only the files the player ticked in the Share checklist: `include` holds paths relative to
/// the instance (`mods`, `config/sodium.json`...), and a file is kept when its own path or any
/// folder above it is listed. A path with no components is dropped rather than exporting something
/// unasked.
fn filter_by_selection(paths: Vec<PathBuf>, include: &HashSet<String>) -> Vec<PathBuf> {
    paths
        .into_iter()
        .filter(|rel| {
            let parts: Vec<String> = rel.components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect();
            (1..=parts.len()).any(|n| include.contains(&parts[..n].join("/")))
        })
        .collect()
}

/// How the own format packs an instance.
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum OwnMode {
    /// Plain files at the zip's root plus `profile.nihao`.
    Full,
    /// `manifest.json` and the files under `overrides/`.
    Compress,
}

impl OwnMode {
    pub fn from_str(mode: &str) -> OwnMode {
        if mode == "full" { OwnMode::Full } else { OwnMode::Compress }
    }
}

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
    mode: OwnMode,
    profile_json: Vec<u8>,
    dest_path: PathBuf,
    on_progress: ProgressCallback,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let rel_paths = filter_by_selection(walk_export_paths(&instance_dir)?, &include);
        let total = rel_paths.len();

        if mode == OwnMode::Full {
            return write_full_archive(&instance_dir, &rel_paths, &profile_json, &dest_path, &on_progress);
        }

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
            let (sha256, size) = hash_file::<Sha256>(&instance_dir.join(rel))?;
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
            zip.start_file(to_zip_path("overrides", rel), zip_options()).map_err(|e| e.to_string())?;
            zip.write_all(&bytes).map_err(|e| e.to_string())?;
        }

        zip.finish().map_err(|e| e.to_string())?;
        Ok(())
    })
    .await
    .map_err(|e| format!("Export task panicked: {}", e))?
}

/// The `Full` archive: every selected file at the root of the zip, and the instance's
/// `profile.nihao` (already stripped of what is personal) so importing it knows the game version and
/// loader.
fn write_full_archive(
    instance_dir: &Path,
    rel_paths: &[PathBuf],
    profile_json: &[u8],
    dest_path: &Path,
    on_progress: &ProgressCallback,
) -> Result<(), String> {
    let file = std::fs::File::create(dest_path).map_err(|e| format!("Cannot create export file: {}", e))?;
    let mut zip = ZipWriter::new(file);
    zip.start_file(PROFILE_FILE_NAME, zip_options()).map_err(|e| e.to_string())?;
    zip.write_all(profile_json).map_err(|e| e.to_string())?;

    let total = rel_paths.len();
    for (i, rel) in rel_paths.iter().enumerate() {
        let filename = rel.to_string_lossy().replace('\\', "/");
        on_progress(ExportProgress {
            etap: "Writing archive".to_string(),
            current_etaps: 1,
            total_etaps: 1,
            current_file: i,
            total_files: total,
            status: "write".to_string(),
            filename: filename.clone(),
        });
        let abs = instance_dir.join(rel);
        let mut source = std::fs::File::open(&abs).map_err(|e| format!("Cannot read '{}': {}", abs.display(), e))?;
        zip.start_file(filename, zip_options()).map_err(|e| e.to_string())?;
        std::io::copy(&mut source, &mut zip).map_err(|e| format!("Cannot write '{}': {}", abs.display(), e))?;
    }
    zip.finish().map_err(|e| e.to_string())?;
    Ok(())
}

/// `modpack.nihao`'s shape per API.md's `POST .../builds`: deliberately not the full
/// `ModpackManifest`. No `format_version` (the file name plus fixed fields is the contract), and no
/// `id`/`name`/`build`: the server assigns them. See MODPACK_FORMAT.md's "Publish to NiHao".
#[derive(Serialize)]
struct PublishManifest {
    #[serde(skip_serializing_if = "Option::is_none")]
    version: Option<String>,
    minecraft_version: String,
    loader: MinecraftLoader,
    #[serde(skip_serializing_if = "Option::is_none")]
    loader_version: Option<String>,
    files: Vec<ModpackFileEntry>,
}

/// Publishes `modpack.nihao` (`PublishManifest`) instead of a raw file dump: files an online
/// service recognises by hash become `source: url` entries pointing at its CDN (bytes never
/// uploaded), and only the rest goes under `override/` (unpacked into the instance root:
/// `override/mods/x.jar` lands at `mods/x.jar`), mirroring `.mrpack`'s overrides (see
/// `export_mrpack`). Keeps the upload small for packs whose mods mostly come from such services.
pub async fn export_for_publish(
    instance_dir: PathBuf,
    version: Option<String>,
    minecraft_version: String,
    loader: MinecraftLoader,
    loader_version: Option<String>,
    include: HashSet<String>,
    dest_path: PathBuf,
    on_progress: ProgressCallback,
) -> Result<(), String> {
    println!("[minecraft:publish] Building publish archive from '{}' (include: {:?})", instance_dir.display(), include);

    let dir = instance_dir.clone();
    let hash_progress = on_progress.clone();
    let hashed: Vec<(PathBuf, String, String, u64)> = tokio::task::spawn_blocking(move || {
        let rel_paths = filter_by_selection(walk_export_paths(&dir)?, &include);
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
                let path = dir.join(&rel);
                let (sha1, size) = hash_file::<Sha1>(&path)?;
                let (sha256, _) = hash_file::<Sha256>(&path)?;
                Ok::<_, String>((rel, sha1, sha256, size))
            })
            .collect::<Result<Vec<_>, String>>()
    })
    .await
    .map_err(|e| format!("Export task panicked: {}", e))??;
    println!("[minecraft:publish] Hashed {} file(s).", hashed.len());

    let all_sha1: Vec<String> = hashed.iter().map(|(_, sha1, _, _)| sha1.clone()).collect();
    let resolved = lookup_known_files(&all_sha1, &on_progress).await;
    println!("[minecraft:publish] Online services resolved {}/{} file(s) by hash.", resolved.len(), hashed.len());

    let mut manifest_files = Vec::with_capacity(hashed.len());
    let mut override_paths = Vec::new();
    for (rel, sha1, sha256, size) in &hashed {
        let path = rel.to_string_lossy().replace('\\', "/");
        match resolved.get(sha1) {
            Some(found) => manifest_files.push(ModpackFileEntry {
                path,
                sha256: sha256.clone(),
                size: *size,
                source: FileSource::Url { url: found.url.clone() },
            }),
            None => {
                manifest_files.push(ModpackFileEntry {
                    path,
                    sha256: sha256.clone(),
                    size: *size,
                    source: FileSource::Server,
                });
                override_paths.push(rel.clone());
            }
        }
    }

    let total_files = manifest_files.len();
    let manifest = PublishManifest {
        version,
        minecraft_version,
        loader,
        loader_version,
        files: manifest_files,
    };

    let override_total = override_paths.len();
    println!(
        "[minecraft:publish] Writing archive to '{}' — {} resolved via online services, {} bundled in override/",
        dest_path.display(),
        total_files - override_total,
        override_total
    );
    tokio::task::spawn_blocking(move || {
        let file = std::fs::File::create(&dest_path)
            .map_err(|e| format!("Cannot create upload archive: {}", e))?;
        let mut zip = ZipWriter::new(file);

        zip.start_file("modpack.nihao", zip_options()).map_err(|e| e.to_string())?;
        let manifest_json = serde_json::to_vec_pretty(&manifest).map_err(|e| e.to_string())?;
        zip.write_all(&manifest_json).map_err(|e| e.to_string())?;

        for (i, rel) in override_paths.iter().enumerate() {
            on_progress(ExportProgress {
                etap: "Zipping files".to_string(),
                current_etaps: 3,
                total_etaps: 3,
                current_file: i,
                total_files: override_total,
                status: "write".to_string(),
                filename: rel.to_string_lossy().replace('\\', "/"),
            });
            let abs = instance_dir.join(rel);
            let mut source = std::fs::File::open(&abs).map_err(|e| format!("Cannot read '{}': {}", abs.display(), e))?;
            zip.start_file(to_zip_path("override", rel), zip_options()).map_err(|e| e.to_string())?;
            std::io::copy(&mut source, &mut zip).map_err(|e| e.to_string())?;
        }

        zip.finish().map_err(|e| e.to_string())?;
        let size = std::fs::metadata(&dest_path).map(|m| m.len()).unwrap_or(0);
        println!("[minecraft:publish] Archive written: '{}' ({:.2} MB)", dest_path.display(), size as f64 / 1_048_576.0);
        Ok(())
    })
    .await
    .map_err(|e| format!("Export task panicked: {}", e))?
}

/// Hosts the `.mrpack` format lets `downloads` point at. An export puts only these in a pack, and an
/// import only fetches from these: a pack from anywhere cannot make the launcher request an
/// arbitrary address (a router's admin page, a plain-http server).
const MRPACK_DOWNLOAD_HOSTS: [&str; 4] = ["cdn.modrinth.com", "github.com", "raw.githubusercontent.com", "gitlab.com"];

pub(crate) fn is_allowed_mrpack_url(url: &str) -> bool {
    reqwest::Url::parse(url)
        .ok()
        .filter(|u| u.scheme() == "https")
        .and_then(|u| u.host_str().map(|h| MRPACK_DOWNLOAD_HOSTS.contains(&h)))
        .unwrap_or(false)
}

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

/// Looks up every hash with the online services (`services::identify_files`). Unrecognised files
/// (or a failed request, e.g. no internet) are simply absent from the map and get bundled as
/// overrides; never errors for that.
async fn lookup_known_files(hashes: &[String], on_progress: &ProgressCallback) -> HashMap<String, KnownFile> {
    services::identify_files(hashes, |done, total| {
        on_progress(ExportProgress {
            etap: "Checking online services".to_string(),
            current_etaps: 2,
            total_etaps: 3,
            current_file: done,
            total_files: total,
            status: "check".to_string(),
            filename: String::new(),
        });
    })
    .await
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
        let rel_paths = filter_by_selection(walk_export_paths(&dir)?, &include);
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
    let resolved = lookup_known_files(&all_hashes, &on_progress).await;

    let mut index_files = Vec::new();
    let mut override_paths = Vec::new();
    for (rel, sha1, _size) in &hashed {
        // The format needs a sha512 and limits the hosts: anything else is bundled instead.
        match resolved.get(sha1).filter(|f| is_allowed_mrpack_url(&f.url)).and_then(|f| f.sha512.as_ref().map(|h| (f, h))) {
            Some((found, sha512)) => index_files.push(MrpackFile {
                path: rel.to_string_lossy().replace('\\', "/"),
                hashes: MrpackHashes { sha1: sha1.clone(), sha512: sha512.clone() },
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

#[cfg(test)]
mod mrpack_host_tests {
    use super::*;

    #[test]
    fn only_hosts_the_format_allows() {
        assert!(is_allowed_mrpack_url("https://cdn.modrinth.com/data/x/versions/y/a.jar"));
        assert!(!is_allowed_mrpack_url("https://cdn.example.com/a.jar"));
        assert!(!is_allowed_mrpack_url("https://cdn.modrinth.com.evil.test/a.jar"));
        assert!(!is_allowed_mrpack_url("http://cdn.modrinth.com/a.jar"), "plain http is refused");
        assert!(!is_allowed_mrpack_url("not a url"));
    }
}

#[cfg(test)]
mod share_tests {
    use super::*;
    use crate::library::import;

    fn set(names: &[&str]) -> HashSet<String> {
        names.iter().map(|n| n.to_string()).collect()
    }

    #[test]
    fn a_ticked_folder_takes_everything_in_it_and_a_ticked_file_only_itself() {
        let paths: Vec<PathBuf> = ["mods/a.jar", "mods/sub/b.jar", "config/a.toml", "config/b.toml", "options.txt"].iter().map(PathBuf::from).collect();
        let kept = |include: &[&str]| -> Vec<String> {
            filter_by_selection(paths.clone(), &set(include)).iter().map(|p| p.to_string_lossy().replace(std::path::MAIN_SEPARATOR, "/")).collect()
        };
        assert_eq!(kept(&["mods"]), ["mods/a.jar", "mods/sub/b.jar"]);
        assert_eq!(kept(&["config/a.toml", "options.txt"]), ["config/a.toml", "options.txt"]);
        assert_eq!(kept(&["mods/sub", "config"]), ["mods/sub/b.jar", "config/a.toml", "config/b.toml"]);
        assert!(kept(&["mod"]).is_empty(), "a name only starting alike is not a match");
    }

    #[tokio::test]
    async fn both_own_modes_make_archives_this_launcher_reads_back() {
        let root = std::env::temp_dir().join(format!("nihao-share-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let instance = root.join("instance");
        std::fs::create_dir_all(instance.join("mods")).unwrap();
        std::fs::create_dir_all(instance.join("config")).unwrap();
        std::fs::write(instance.join("mods/a.jar"), b"jar").unwrap();
        std::fs::write(instance.join("config/a.toml"), b"toml").unwrap();
        std::fs::write(instance.join("config/other.toml"), b"left out").unwrap();
        let profile = br#"{"display_name":"Pack","version_id":"1.21.1","core":"FABRIC","loader_version":"0.19.5","max_ram":2048}"#.to_vec();
        let quiet: ProgressCallback = Arc::new(|_| {});
        let names = |archive: &Path| -> Vec<String> {
            let mut zip = zip::ZipArchive::new(std::fs::File::open(archive).unwrap()).unwrap();
            let mut names: Vec<String> = (0..zip.len()).map(|i| zip.by_index(i).unwrap().name().to_string()).collect();
            names.sort();
            names
        };
        let export = |mode: OwnMode, dest: PathBuf| {
            export_own_format(instance.clone(), "id".into(), "Pack".into(), 1, None, "1.21.1".into(), MinecraftLoader::FABRIC, None, set(&["mods", "config/a.toml"]), mode, profile.clone(), dest, quiet.clone())
        };

        let compressed = root.join("compressed.zip");
        export(OwnMode::Compress, compressed.clone()).await.unwrap();
        assert_eq!(names(&compressed), ["manifest.json", "overrides/config/a.toml", "overrides/mods/a.jar"]);
        assert_eq!(import::peek(&compressed).unwrap().format, "own");
        let restored = root.join("restored");
        import::import_own_format(restored.clone(), compressed, quiet.clone()).await.unwrap();
        assert!(restored.join("mods/a.jar").is_file() && restored.join("config/a.toml").is_file());
        assert!(!restored.join("config/other.toml").exists());

        let full = root.join("full.zip");
        export(OwnMode::Full, full.clone()).await.unwrap();
        assert_eq!(names(&full), ["config/a.toml", "mods/a.jar", "profile.nihao"]);
        let preview = import::peek(&full).unwrap();
        assert_eq!((preview.format.as_str(), preview.minecraft_version.as_str(), preview.loader.as_str()), ("full", "1.21.1", "fabric"));
        let unpacked = root.join("unpacked");
        import::import_raw_zip(unpacked.clone(), full, quiet).await.unwrap();
        assert!(unpacked.join("mods/a.jar").is_file());
        assert!(!unpacked.join("profile.nihao").exists(), "a pack never writes the launcher's own file");
        let _ = std::fs::remove_dir_all(&root);
    }
}
