//! Imports a modpack file into a new local instance (the reverse of `export.rs`).
//!
//! - Own format (`import_own_format`): unzips `overrides/` (`files/` in older exports) into the
//! instance per `manifest.json`. An own-format `Full` archive (plain files plus `profile.nihao`) is
//! a `"full"` pack: its game version and loader come from that profile, the files are extracted as they are.
//! - Modrinth `.mrpack` (`import_mrpack`): unzips `overrides/`/`client-overrides/` and downloads
//! every `files[]` entry from its `downloads` URL.
//! - CurseForge (`import_curseforge`): unzips the manifest's overrides folder and downloads every
//! file it names by id, with URLs resolved through the CurseForge service.
//!
//! Neither bundles the Minecraft client/libraries/assets, so `interface.rs`'s `import_modpack` runs
//! the normal install pipeline afterwards.

use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use zip::ZipArchive;

use super::export::{ExportProgress as JobProgress, ProgressCallback};
use super::modpack_format::{hash_file_sha1, is_reserved, safe_join, ModpackManifest};
use super::profile::{MinecraftProfile, PROFILE_FILE_NAME};
use super::services::{self, BlockedFile, PackFile, PackFileRef};
use super::version::MinecraftLoader;

fn open_zip(source_path: &Path) -> Result<ZipArchive<std::fs::File>, String> {
    let file = std::fs::File::open(source_path).map_err(|e| format!("Cannot open file: {}", e))?;
    ZipArchive::new(file).map_err(|e| format!("Not a valid archive: {}", e))
}

/// `safe_join`, but `None` for the launcher's own per-instance files (`profile.nihao`, icon, banner):
/// a pack must never overwrite them — `profile.nihao` holds `java_path`/`jvm_arguments`, which Play runs.
fn pack_dest(base: &Path, rel: &str) -> Result<Option<PathBuf>, String> {
    let dest = safe_join(base, rel)?;
    Ok((!is_reserved(Path::new(rel))).then_some(dest))
}

fn read_zip_entry(zip: &mut ZipArchive<std::fs::File>, name: &str) -> Option<String> {
    let mut entry = zip.by_name(name).ok()?;
    let mut content = String::new();
    entry.read_to_string(&mut content).ok()?;
    Some(content)
}

#[derive(Deserialize)]
struct MrpackIndexIn {
    name: String,
    dependencies: HashMap<String, String>,
    #[serde(default)]
    files: Vec<MrpackFileIn>,
}

#[derive(Deserialize, Clone)]
struct MrpackFileIn {
    path: String,
    downloads: Vec<String>,
    #[serde(default)]
    hashes: HashMap<String, String>,
}

/// The parts of CurseForge's `manifest.json` an import needs.
#[derive(Deserialize)]
struct CurseManifest {
    name: String,
    minecraft: CurseMinecraft,
    #[serde(default)]
    files: Vec<CurseFile>,
    /// Folder of the zip copied over the instance; `"overrides"` unless the manifest says otherwise.
    overrides: Option<String>,
}

#[derive(Deserialize)]
struct CurseMinecraft {
    version: String,
    #[serde(rename = "modLoaders", default)]
    mod_loaders: Vec<CurseLoader>,
}

#[derive(Deserialize)]
struct CurseLoader {
    /// `"fabric-0.15.11"`, `"neoforge-21.1.172"`, `"forge-47.1.0"`.
    id: String,
    #[serde(default)]
    primary: bool,
}

#[derive(Deserialize)]
struct CurseFile {
    #[serde(rename = "projectID")]
    project_id: u64,
    #[serde(rename = "fileID")]
    file_id: u64,
}

/// A CurseForge `manifest.json` carries `"manifestType": "minecraftModpack"`; this project's own
/// manifest has the same file name but not that key.
fn is_curse_manifest(content: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(content)
        .ok()
        .and_then(|v| v.get("manifestType").and_then(|t| t.as_str()).map(|t| t == "minecraftModpack"))
        .unwrap_or(false)
}

/// Only the loaders the launcher can run: a Forge or Quilt pack would otherwise install as vanilla
/// and silently not load its mods.
fn curse_loader(minecraft: &CurseMinecraft) -> Result<(MinecraftLoader, Option<String>), String> {
    let Some(loader) = minecraft.mod_loaders.iter().find(|l| l.primary).or(minecraft.mod_loaders.first()) else {
        return Ok((MinecraftLoader::VANILLA, None));
    };
    let (name, version) = loader.id.split_once('-').unwrap_or((&loader.id, ""));
    let version = (!version.is_empty()).then(|| version.to_string());
    match name {
        "fabric" => Ok((MinecraftLoader::FABRIC, version)),
        "neoforge" => Ok((MinecraftLoader::NEOFORGE, version)),
        other => Err(format!("This pack needs the {} loader, which the launcher can't run yet.", other)),
    }
}

fn detect_loader(dependencies: &HashMap<String, String>) -> (MinecraftLoader, Option<String>) {
    if let Some(v) = dependencies.get("fabric-loader") {
        return (MinecraftLoader::FABRIC, Some(v.clone()));
    }
    if let Some(v) = dependencies.get("forge") {
        return (MinecraftLoader::FORGE, Some(v.clone()));
    }
    if let Some(v) = dependencies.get("neoforge") {
        return (MinecraftLoader::NEOFORGE, Some(v.clone()));
    }
    (MinecraftLoader::VANILLA, None)
}

/// What the "Install modpack" screen shows before committing: parsed without extracting or
/// downloading anything.
#[derive(Serialize, Clone)]
pub struct ImportPreview {
    /// `"own"`, `"full"`, `"mrpack"`, `"curseforge"` or `"raw"` — which of `import_own_format`/
    /// `import_raw_zip` (for `"full"` too)/`import_mrpack`/`import_curseforge` to call next.
    pub format: String,
    pub name: String,
    /// Empty for `"raw"` (no manifest to read it from): `import_modpack` takes it, `loader` and
    /// `loader_version` from the player, like "Custom setup".
    pub minecraft_version: String,
    /// Lowercase, matching `MinecraftLoader::to_string()`/`create_modpack`'s `core` param —
    /// not the manifest's own uppercase Rust-enum serialization.
    pub loader: String,
    pub loader_version: Option<String>,
}

pub fn peek(source_path: &Path) -> Result<ImportPreview, String> {
    let mut zip = open_zip(source_path)?;

    if let Some(content) = read_zip_entry(&mut zip, "manifest.json") {
        if is_curse_manifest(&content) {
            let manifest: CurseManifest =
                serde_json::from_str(&content).map_err(|e| format!("Invalid manifest.json: {}", e))?;
            let (loader, loader_version) = curse_loader(&manifest.minecraft)?;
            return Ok(ImportPreview {
                format: "curseforge".to_string(),
                name: manifest.name,
                minecraft_version: manifest.minecraft.version,
                loader: loader.to_string(),
                loader_version,
            });
        }
        let manifest: ModpackManifest =
            serde_json::from_str(&content).map_err(|e| format!("Invalid manifest.json: {}", e))?;
        return Ok(ImportPreview {
            format: "own".to_string(),
            name: manifest.name,
            minecraft_version: manifest.minecraft_version,
            loader: manifest.loader.to_string(),
            loader_version: manifest.loader_version,
        });
    }

    if let Some(content) = read_zip_entry(&mut zip, "modrinth.index.json") {
        let index: MrpackIndexIn =
            serde_json::from_str(&content).map_err(|e| format!("Invalid modrinth.index.json: {}", e))?;
        let minecraft_version = index.dependencies.get("minecraft").cloned().unwrap_or_default();
        let (loader, loader_version) = detect_loader(&index.dependencies);
        return Ok(ImportPreview {
            format: "mrpack".to_string(),
            name: index.name,
            minecraft_version,
            loader: loader.to_string(),
            loader_version,
        });
    }

    // A `Full` export of this launcher: plain files with the instance's profile beside them. Only
    // what says how to run the game is read from it, never the player's settings.
    if let Some(profile) = read_zip_entry(&mut zip, PROFILE_FILE_NAME).and_then(|c| serde_json::from_str::<MinecraftProfile>(&c).ok()) {
        return Ok(ImportPreview {
            format: "full".to_string(),
            name: profile.display_name,
            minecraft_version: profile.version_id,
            loader: profile.core.to_string(),
            loader_version: profile.loader_version,
        });
    }

    // Neither of our manifests: a hand-made plain .zip (a mods/configs/resourcepacks folder zipped
    // directly). Instead of rejecting it, the confirm screen lets the player supply what a
    // manifest would, and `import_raw_zip` extracts everything as-is.
    let name = source_path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "Modpack".to_string());
    Ok(ImportPreview {
        format: "raw".to_string(),
        name,
        minecraft_version: String::new(),
        loader: MinecraftLoader::VANILLA.to_string(),
        loader_version: None,
    })
}

/// Unzips `overrides/` (`files/` in older exports) into `instance_dir` per `manifest.json`. Returns the manifest to track as the
/// new instance's `profile.pack` (this format round-trips through `export_own_format`, unlike
/// `.mrpack`).
pub async fn import_own_format(
    instance_dir: PathBuf,
    source_path: PathBuf,
    on_progress: ProgressCallback,
) -> Result<ModpackManifest, String> {
    tokio::task::spawn_blocking(move || {
        let mut zip = open_zip(&source_path)?;
        let manifest_content = read_zip_entry(&mut zip, "manifest.json")
            .ok_or_else(|| "manifest.json not found in archive".to_string())?;
        let manifest: ModpackManifest =
            serde_json::from_str(&manifest_content).map_err(|e| format!("Invalid manifest.json: {}", e))?;

        std::fs::create_dir_all(&instance_dir).map_err(|e| format!("Cannot create instance folder: {}", e))?;

        // Packs made before the folder was renamed keep their files under `files/`.
        let folder = if zip.file_names().any(|n| n.starts_with("overrides/")) { "overrides" } else { "files" };
        let total = manifest.files.len();
        for (i, entry) in manifest.files.iter().enumerate() {
            on_progress(JobProgress {
                etap: "Extracting files".to_string(),
                current_etaps: 1,
                total_etaps: 1,
                current_file: i,
                total_files: total,
                status: "extract".to_string(),
                filename: entry.path.clone(),
            });

            let zip_path = format!("{}/{}", folder, entry.path);
            let mut zip_file = zip
                .by_name(&zip_path)
                .map_err(|e| format!("Missing '{}' in archive: {}", zip_path, e))?;
            let Some(dest) = pack_dest(&instance_dir, &entry.path)? else { continue };
            if let Some(parent) = dest.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            let mut out = std::fs::File::create(&dest)
                .map_err(|e| format!("Cannot write '{}': {}", dest.display(), e))?;
            std::io::copy(&mut zip_file, &mut out)
                .map_err(|e| format!("Cannot extract '{}': {}", entry.path, e))?;
        }

        Ok(manifest)
    })
    .await
    .map_err(|e| format!("Import task panicked: {}", e))?
}

/// What importing a pack left in the instance.
pub struct PackReport {
    /// Every file the pack downloads into the instance (also those nobody could hand out), as
    /// relative paths: what an update compares between two builds to find the files it dropped.
    pub files: Vec<String>,
    /// The files that must be fetched by hand (see `import_curseforge`).
    pub missing: Vec<BlockedFile>,
}

/// Whether `dest` already holds the file a pack asks for (its `sha1` when it names one), so a
/// restore can leave it be.
async fn is_in_place(dest: &Path, sha1: &str) -> bool {
    let (dest, sha1) = (dest.to_path_buf(), sha1.to_string());
    tokio::task::spawn_blocking(move || {
        dest.is_file() && (sha1.is_empty() || hash_file_sha1(&dest).is_ok_and(|(have, _)| have.eq_ignore_ascii_case(&sha1)))
    })
    .await
    .unwrap_or(false)
}

/// Copies every entry under one of `prefixes` (the zip's override folders) into `instance_dir`
/// without the prefix, as the first of the two import steps. `keep_existing` leaves a file that is
/// already there (a restore must not undo the player's edits to configs).
fn extract_overrides(
    zip: &mut ZipArchive<std::fs::File>,
    prefixes: &[&str],
    instance_dir: &Path,
    keep_existing: bool,
    on_progress: &ProgressCallback,
) -> Result<(), String> {
    // `by_name` needs a fresh borrow per entry, so gather names first rather than holding
    // one across the `on_progress` call below.
    let override_names: Vec<String> = (0..zip.len())
        .filter_map(|i| zip.by_index(i).ok().map(|f| f.name().to_string()))
        .filter(|n| prefixes.iter().any(|p| n.starts_with(p)) && !n.ends_with('/'))
        .collect();

    let total = override_names.len();
    for (i, entry_name) in override_names.iter().enumerate() {
        on_progress(JobProgress {
            etap: "Extracting overrides".to_string(),
            current_etaps: 1,
            total_etaps: 2,
            current_file: i,
            total_files: total,
            status: "extract".to_string(),
            filename: entry_name.clone(),
        });

        let rel = prefixes.iter().find_map(|p| entry_name.strip_prefix(p)).unwrap_or(entry_name);
        let mut zip_file = zip.by_name(entry_name).map_err(|e| e.to_string())?;
        let Some(dest) = pack_dest(instance_dir, rel)? else { continue };
        if keep_existing && dest.exists() {
            continue;
        }
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut out = std::fs::File::create(&dest)
            .map_err(|e| format!("Cannot write '{}': {}", dest.display(), e))?;
        std::io::copy(&mut zip_file, &mut out)
            .map_err(|e| format!("Cannot extract '{}': {}", entry_name, e))?;
    }
    Ok(())
}

/// Unzips `overrides/`/`client-overrides/` into `instance_dir`, then downloads every
/// `files[]` entry from its `downloads` URL. `restore` keeps what is already in place (and right)
/// and fetches only the rest.
pub async fn import_mrpack(
    instance_dir: PathBuf,
    source_path: PathBuf,
    restore: bool,
    on_progress: ProgressCallback,
) -> Result<PackReport, String> {
    let extract_progress = on_progress.clone();
    let dir_for_extract = instance_dir.clone();
    let index: MrpackIndexIn = tokio::task::spawn_blocking(move || {
        let mut zip = open_zip(&source_path)?;
        let index_content = read_zip_entry(&mut zip, "modrinth.index.json")
            .ok_or_else(|| "modrinth.index.json not found in archive".to_string())?;
        let index: MrpackIndexIn =
            serde_json::from_str(&index_content).map_err(|e| format!("Invalid modrinth.index.json: {}", e))?;

        std::fs::create_dir_all(&dir_for_extract).map_err(|e| format!("Cannot create instance folder: {}", e))?;

        extract_overrides(&mut zip, &["overrides/", "client-overrides/"], &dir_for_extract, restore, &extract_progress)?;

        Ok::<_, String>(index)
    })
    .await
    .map_err(|e| format!("Import task panicked: {}", e))??;

    let total = index.files.len();
    let mut files = Vec::new();
    for (i, file) in index.files.iter().enumerate() {
        on_progress(JobProgress {
            etap: "Downloading mods".to_string(),
            current_etaps: 2,
            total_etaps: 2,
            current_file: i,
            total_files: total,
            status: "install".to_string(),
            filename: file.path.clone(),
        });

        let Some(dest) = pack_dest(&instance_dir, &file.path)? else { continue };
        files.push(file.path.clone());
        // Only the hosts the format allows, and only with the sha1 it requires: an address the pack
        // names on its own is not fetched, and a file nothing vouches for is not kept.
        let url = file
            .downloads
            .iter()
            .find(|u| super::export::is_allowed_mrpack_url(u))
            .ok_or_else(|| format!("'{}' has no download address on a host the Modrinth format allows", file.path))?;
        let sha1 = file
            .hashes
            .get("sha1")
            .map(String::as_str)
            .filter(|h| !h.is_empty())
            .ok_or_else(|| format!("'{}' has no sha1 in the pack, so it cannot be checked", file.path))?;
        // Streams to disk and checks the sha1 instead of buffering.
        if restore && is_in_place(&dest, sha1).await {
            continue;
        }
        if let Some(parent) = dest.parent() {
            tokio::fs::create_dir_all(parent).await.map_err(|e| e.to_string())?;
        }
        super::install::download_checked(url, dest, sha1)
            .await
            .map_err(|e| format!("Cannot download '{}': {}", file.path, e))?;
    }

    Ok(PackReport { files, missing: Vec::new() })
}

/// Turns a CurseForge manifest's file ids into downloads. A file whose author keeps it off
/// third-party downloads is looked up on the other services by its SHA-1 (the same file is often
/// published on Modrinth too); what nobody can hand out comes back as the second list.
async fn resolve_curse(manifest: &CurseManifest) -> Result<(Vec<PackFile>, Vec<BlockedFile>), String> {
    let refs: Vec<PackFileRef> = manifest
        .files
        .iter()
        .map(|f| PackFileRef { project_id: f.project_id.to_string(), file_id: f.file_id.to_string() })
        .collect();
    let resolved = services::get("curseforge")?.resolve_pack_files(&refs).await?;
    let mut files = resolved.files;
    let mut missing = Vec::new();
    if !resolved.blocked.is_empty() {
        let hashes: Vec<String> = resolved.blocked.iter().map(|b| b.sha1.clone()).filter(|h| !h.is_empty()).collect();
        let elsewhere = services::identify_files(&hashes, |_, _| {}).await;
        for blocked in resolved.blocked {
            match elsewhere.get(&blocked.sha1) {
                Some(known) => files.push(PackFile { path: blocked.path, url: known.url.clone(), sha1: blocked.sha1, headers: Vec::new() }),
                None => missing.push(blocked),
            }
        }
    }
    Ok((files, missing))
}

/// Unzips the manifest's overrides folder into `instance_dir`, then downloads every file the
/// manifest names by id: `services::get("curseforge")` turns the ids into URLs and folders
/// (`resolve_curse`).
///
/// What nobody can hand out isn't an error: the pack installs without it, and the report says what
/// the player has to fetch. `restore` keeps what is already in place (and right) and fetches only
/// the rest.
pub async fn import_curseforge(
    instance_dir: PathBuf,
    source_path: PathBuf,
    restore: bool,
    on_progress: ProgressCallback,
) -> Result<PackReport, String> {
    let extract_progress = on_progress.clone();
    let dir_for_extract = instance_dir.clone();
    let manifest: CurseManifest = tokio::task::spawn_blocking(move || {
        let mut zip = open_zip(&source_path)?;
        let content = read_zip_entry(&mut zip, "manifest.json")
            .ok_or_else(|| "manifest.json not found in archive".to_string())?;
        let manifest: CurseManifest =
            serde_json::from_str(&content).map_err(|e| format!("Invalid manifest.json: {}", e))?;

        std::fs::create_dir_all(&dir_for_extract).map_err(|e| format!("Cannot create instance folder: {}", e))?;
        let prefix = format!("{}/", manifest.overrides.as_deref().unwrap_or("overrides").trim_matches('/'));
        extract_overrides(&mut zip, &[prefix.as_str()], &dir_for_extract, restore, &extract_progress)?;
        Ok::<_, String>(manifest)
    })
    .await
    .map_err(|e| format!("Import task panicked: {}", e))??;

    on_progress(JobProgress {
        etap: "Resolving mods".to_string(),
        current_etaps: 2,
        total_etaps: 2,
        current_file: 0,
        total_files: manifest.files.len(),
        status: "check".to_string(),
        filename: String::new(),
    });
    let (files, missing) = resolve_curse(&manifest).await?;

    let total = files.len();
    for (i, file) in files.iter().enumerate() {
        on_progress(JobProgress {
            etap: "Downloading mods".to_string(),
            current_etaps: 2,
            total_etaps: 2,
            current_file: i,
            total_files: total,
            status: "install".to_string(),
            filename: file.path.clone(),
        });

        let Some(dest) = pack_dest(&instance_dir, &file.path)? else { continue };
        if restore && is_in_place(&dest, &file.sha1).await {
            continue;
        }
        if let Some(parent) = dest.parent() {
            tokio::fs::create_dir_all(parent).await.map_err(|e| e.to_string())?;
        }
        super::install::download_checked_with(&file.url, dest, &file.sha1, &file.headers)
            .await
            .map_err(|e| format!("Cannot download '{}': {}", file.path, e))?;
    }

    let files = files.into_iter().map(|f| f.path).chain(missing.iter().map(|m| m.path.clone())).collect();
    Ok(PackReport { files, missing })
}

/// The files a Modrinth or CurseForge pack downloads into an instance, without fetching any of
/// them.
pub async fn pack_paths(source_path: PathBuf) -> Result<Vec<String>, String> {
    let (mrpack, curse) = tokio::task::spawn_blocking(move || {
        let mut zip = open_zip(&source_path)?;
        let mrpack = read_zip_entry(&mut zip, "modrinth.index.json")
            .map(|c| serde_json::from_str::<MrpackIndexIn>(&c).map_err(|e| format!("Invalid modrinth.index.json: {}", e)))
            .transpose()?;
        let curse = read_zip_entry(&mut zip, "manifest.json")
            .filter(|c| is_curse_manifest(c))
            .map(|c| serde_json::from_str::<CurseManifest>(&c).map_err(|e| format!("Invalid manifest.json: {}", e)))
            .transpose()?;
        Ok::<_, String>((mrpack, curse))
    })
    .await
    .map_err(|e| format!("Import task panicked: {}", e))??;

    if let Some(index) = mrpack {
        return Ok(index.files.into_iter().map(|f| f.path).collect());
    }
    let manifest = curse.ok_or_else(|| "Not a Modrinth or CurseForge modpack".to_string())?;
    let (files, missing) = resolve_curse(&manifest).await?;
    Ok(files.into_iter().map(|f| f.path).chain(missing.into_iter().map(|m| m.path)).collect())
}

/// Extracts every entry straight into `instance_dir`: no folder prefix and no manifest (see
/// `peek`'s `"raw"` and `"full"` cases; `profile.nihao` is never written, see `pack_dest`).
pub async fn import_raw_zip(
    instance_dir: PathBuf,
    source_path: PathBuf,
    on_progress: ProgressCallback,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let mut zip = open_zip(&source_path)?;
        std::fs::create_dir_all(&instance_dir).map_err(|e| format!("Cannot create instance folder: {}", e))?;

        let names: Vec<String> = (0..zip.len())
            .filter_map(|i| zip.by_index(i).ok().map(|f| f.name().to_string()))
            .filter(|n| !n.ends_with('/'))
            .collect();

        let total = names.len();
        for (i, entry_name) in names.iter().enumerate() {
            on_progress(JobProgress {
                etap: "Extracting files".to_string(),
                current_etaps: 1,
                total_etaps: 1,
                current_file: i,
                total_files: total,
                status: "extract".to_string(),
                filename: entry_name.clone(),
            });

            let mut zip_file = zip.by_name(entry_name).map_err(|e| e.to_string())?;
            let Some(dest) = pack_dest(&instance_dir, entry_name)? else { continue };
            if let Some(parent) = dest.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            let mut out = std::fs::File::create(&dest)
                .map_err(|e| format!("Cannot write '{}': {}", dest.display(), e))?;
            std::io::copy(&mut zip_file, &mut out)
                .map_err(|e| format!("Cannot extract '{}': {}", entry_name, e))?;
        }

        Ok::<_, String>(())
    })
    .await
    .map_err(|e| format!("Import task panicked: {}", e))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn curseforge_manifests_are_told_apart_and_limited_to_runnable_loaders() {
        assert!(is_curse_manifest(r#"{"manifestType":"minecraftModpack","name":"x"}"#));
        assert!(!is_curse_manifest(r#"{"format_version":1,"name":"x"}"#));
        assert!(!is_curse_manifest("not json"));

        let pack = |loaders: &str| -> CurseMinecraft {
            serde_json::from_str(&format!(r#"{{"version":"1.20.1","modLoaders":[{loaders}]}}"#)).unwrap()
        };
        let (loader, version) = curse_loader(&pack(r#"{"id":"fabric-0.15.11","primary":true}"#)).unwrap();
        assert_eq!((loader.to_string().as_str(), version.as_deref()), ("fabric", Some("0.15.11")));
        assert_eq!(curse_loader(&pack("")).unwrap().0.to_string(), "vanilla");
        assert!(curse_loader(&pack(r#"{"id":"forge-47.1.0","primary":true}"#)).is_err());
    }

    /// Imports a real CurseForge pack (a zip at `NIHAO_TEST_CF_PACK`, with `CURSEFORGE_API_KEY` set)
    /// into a temp folder: `cargo test -p minecraft live_curseforge -- --ignored --nocapture`.
    #[tokio::test]
    #[ignore]
    async fn live_curseforge_import() {
        let pack = PathBuf::from(std::env::var("NIHAO_TEST_CF_PACK").expect("set NIHAO_TEST_CF_PACK"));
        let dir = std::env::temp_dir().join(format!("nihao-cf-import-{}", std::process::id()));
        let preview = peek(&pack).unwrap();
        println!("{} {} {} {:?}", preview.format, preview.minecraft_version, preview.loader, preview.loader_version);

        let etaps = std::sync::Mutex::new(String::new());
        let progress: ProgressCallback = std::sync::Arc::new(move |p| {
            let mut last = etaps.lock().unwrap();
            if *last != p.etap {
                println!("[{}] step {}/{}, {} files", p.etap, p.current_etaps, p.total_etaps, p.total_files);
                *last = p.etap;
            }
        });
        let result = import_curseforge(dir.clone(), pack.clone(), false, progress.clone()).await;
        let count = |sub: &str| std::fs::read_dir(dir.join(sub)).map(|d| d.count()).unwrap_or(0);
        println!(
            "result: {} | mods {} | resourcepacks {} | shaderpacks {} | config {}",
            match &result { Ok(r) => format!("ok, {} missing: {:?}", r.missing.len(), r.missing.iter().map(|b| &b.name).collect::<Vec<_>>()), Err(e) => format!("ERR {e}") },
            count("mods"), count("resourcepacks"), count("shaderpacks"), count("config"),
        );
        let report = result.unwrap();

        // Restoring a complete instance downloads nothing; a deleted mod comes back.
        let listed = pack_paths(pack.clone()).await.unwrap();
        assert_eq!(listed.len(), report.files.len());
        let victim = report.files.iter().find(|f| f.starts_with("mods/") && !report.missing.iter().any(|m| &m.path == *f)).cloned();
        if let Some(victim) = &victim {
            std::fs::remove_file(dir.join(victim)).unwrap();
            import_curseforge(dir.clone(), pack, true, progress).await.unwrap();
            assert!(dir.join(victim).is_file(), "restore brings back {victim}");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Moves a real Modrinth pack from its previous build to the newest one the way `sync_modpack`
    /// does, then restores it: `cargo test -p minecraft live_modrinth_update -- --ignored --nocapture`.
    #[tokio::test]
    #[ignore]
    async fn live_modrinth_update() {
        const PACK: &str = "1KVo5zza"; // Fabulously Optimized
        let service = services::get("modrinth").unwrap();
        let versions = service.modpack_versions(PACK).await.unwrap();
        let (new, old) = (&versions[0], &versions[1]);
        let dir = std::env::temp_dir().join(format!("nihao-mr-update-{}", std::process::id()));
        let quiet: ProgressCallback = std::sync::Arc::new(|_| {});

        let old_zip = services::download_modpack(service, PACK, Some(&old.id)).await.unwrap();
        let new_zip = services::download_modpack(service, PACK, Some(&new.id)).await.unwrap();
        let old_paths = pack_paths(old_zip.clone()).await.unwrap();
        import_mrpack(dir.clone(), old_zip, false, quiet.clone()).await.unwrap();
        let report = import_mrpack(dir.clone(), new_zip.clone(), false, quiet.clone()).await.unwrap();
        let dropped: Vec<&String> = old_paths.iter().filter(|p| !report.files.contains(p)).collect();
        println!("{} -> {}: {} files, {} before, {} dropped: {:?}", old.version_number, new.version_number, report.files.len(), old_paths.len(), dropped.len(), dropped);
        assert_eq!(pack_paths(new_zip.clone()).await.unwrap(), report.files);

        let started = std::time::Instant::now();
        import_mrpack(dir.clone(), new_zip, true, quiet).await.unwrap();
        println!("restoring the complete instance took {:?}", started.elapsed());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn restore_keeps_edited_overrides_and_right_files() {
        use std::io::Write;
        use sha1::{Digest, Sha1};

        let base = std::env::temp_dir().join(format!("nihao-restore-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        let pack = base.join("pack.zip");
        {
            let mut zip = zip::ZipWriter::new(std::fs::File::create(&pack).unwrap());
            zip.start_file("overrides/config/a.toml", zip::write::FileOptions::default()).unwrap();
            zip.write_all(b"from the pack").unwrap();
            zip.finish().unwrap();
        }
        let instance = base.join("instance");
        std::fs::create_dir_all(instance.join("config")).unwrap();
        std::fs::write(instance.join("config/a.toml"), "edited by the player").unwrap();
        let quiet: ProgressCallback = std::sync::Arc::new(|_| {});
        let extract = |keep| extract_overrides(&mut open_zip(&pack).unwrap(), &["overrides/"], &instance, keep, &quiet).unwrap();

        extract(true);
        assert_eq!(std::fs::read_to_string(instance.join("config/a.toml")).unwrap(), "edited by the player");
        extract(false);
        assert_eq!(std::fs::read_to_string(instance.join("config/a.toml")).unwrap(), "from the pack");

        let jar = instance.join("mods/a.jar");
        std::fs::create_dir_all(jar.parent().unwrap()).unwrap();
        std::fs::write(&jar, b"jar").unwrap();
        let sha1 = format!("{:x}", Sha1::digest(b"jar"));
        assert!(is_in_place(&jar, &sha1).await);
        assert!(is_in_place(&jar, "").await);
        assert!(!is_in_place(&jar, &format!("{:x}", Sha1::digest(b"other"))).await);
        assert!(!is_in_place(&instance.join("mods/gone.jar"), &sha1).await);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn packs_cannot_overwrite_the_instance_profile() {
        let base = Path::new("inst");
        assert!(pack_dest(base, "profile.nihao").unwrap().is_none());
        assert!(pack_dest(base, "icon").unwrap().is_none());
        assert!(pack_dest(base, "mods/a.jar").unwrap().is_some());
        assert!(pack_dest(base, "../x").is_err());
    }
}
