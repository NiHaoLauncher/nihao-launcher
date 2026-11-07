//! The distributable modpack manifest format: a flat list of every distributable file in a pack
//! plus its SHA-256, so the server can publish "builds" and clients can ask "what changed since
//! build N?" instead of re-downloading everything. Spec:
//! DOCUMENTATION/game-modules/minecraft/MODPACK_FORMAT.md; server API: DOCUMENTATION/server/API.md.
//! Persisted locally as the `pack` field of `MinecraftProfile` (`profile.nihao`).

use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::library::version::MinecraftLoader;

pub const MODPACK_FORMAT_VERSION: u32 = 1;

/// One published release ("build") of a modpack: the unit the server stores, diffs and serves.
/// Fields beyond the first four are `#[serde(default)]` (forward-compat, like `MinecraftProfile`).
#[derive(Serialize, Deserialize, Clone)]
pub struct ModpackManifest {
    pub format_version: u32,
    /// Stable id of the pack on the server (not the local directory name, which the player can
    /// rename).
    pub id: String,
    pub name: String,
    /// Increases monotonically per release. Compare this, not `version`, for diffs and update
    /// checks: a free-text label is easy to get wrong or reuse.
    pub build: u64,
    /// Human-readable label only (e.g. "1.4.2") — never compared programmatically.
    #[serde(default)]
    pub version: Option<String>,
    pub minecraft_version: String,
    pub loader: MinecraftLoader,
    #[serde(default)]
    pub loader_version: Option<String>,
    #[serde(default)]
    pub files: Vec<ModpackFileEntry>,
}

#[derive(Serialize, Deserialize, Clone, PartialEq)]
pub struct ModpackFileEntry {
    /// Instance-relative with forward slashes (even on Windows), so manifests are comparable
    /// byte-for-byte across platforms.
    pub path: String,
    /// Lowercase hex SHA-256 of the file's contents.
    pub sha256: String,
    pub size: u64,
    #[serde(default)]
    pub source: FileSource,
}

/// Where a file's bytes come from when it needs (re)downloading. Defaults to `Server`; `Url` points
/// straight at a CDN/mirror (e.g. Modrinth/CurseForge) so the server needn't proxy every byte.
#[derive(Serialize, Deserialize, Clone, PartialEq, Default)]
#[serde(rename_all = "lowercase", tag = "type")]
pub enum FileSource {
    #[default]
    Server,
    Url {
        url: String,
    },
}

/// Subpaths never included in a generated manifest: player/run-specific data (saves, logs,
/// screenshots) and the instance's local-only files, which a pack should not own.
const EXCLUDED_TOP_LEVEL_DIRS: &[&str] = &["saves", "logs", "crash-reports", "screenshots"];

/// Per-instance bookkeeping and per-player customisation: never pack content, whichever top-level
/// entries the player ticks (see `is_excluded`, `list_top_level_entries`, `walk_export_paths`).
pub fn is_reserved(rel_path: &Path) -> bool {
    if rel_path.extension().and_then(|e| e.to_str()) == Some("nihao") {
        return true; // profile.nihao itself — local bookkeeping, not pack content
    }
    if let Some(name) = rel_path.file_name().and_then(|n| n.to_str()) {
        if name == "icon" || name == "banner" {
            return true;
        }
    }
    false
}

fn is_excluded(rel_path: &Path) -> bool {
    if let Some(first) = rel_path.components().next() {
        let first = first.as_os_str().to_string_lossy();
        if EXCLUDED_TOP_LEVEL_DIRS.contains(&first.as_ref()) {
            return true;
        }
    }
    is_reserved(rel_path)
}

/// One row in the Share export's "what to include" checklist — `is_dir` lets the UI show a
/// folder vs. file icon.
#[derive(Serialize, Clone)]
pub struct ExportEntry {
    pub name: String,
    pub is_dir: bool,
    /// Bytes: the file's own, or everything inside a folder.
    pub size: u64,
}

/// Total size of a file or of everything under a folder; links are not followed, and what can't
/// be read counts as nothing.
fn entry_size(path: &Path) -> u64 {
    let Ok(meta) = std::fs::symlink_metadata(path) else { return 0 };
    if meta.is_symlink() {
        return 0;
    }
    if !meta.is_dir() {
        return meta.len();
    }
    std::fs::read_dir(path).into_iter().flatten().flatten().map(|e| entry_size(&e.path())).sum()
}

/// The folders/files directly inside `root` (an instance directory, or a folder of it) for the Share checklist, minus
/// `is_reserved` ones. Unlike `is_excluded` in `generate_manifest`,
/// `saves`/`logs`/`crash-reports`/`screenshots` are not hidden, only unchecked by default (sharing
/// is the player's explicit choice). Folders first, then files, alphabetical; each with its size.
pub fn list_top_level_entries(root: &Path) -> Result<Vec<ExportEntry>, String> {
    let mut out = Vec::new();
    if !root.exists() {
        return Ok(out);
    }
    for entry in std::fs::read_dir(root).map_err(|e| format!("Cannot read '{}': {}", root.display(), e))? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().to_string();
        if is_reserved(Path::new(&name)) {
            continue;
        }
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        let size = entry_size(&entry.path());
        out.push(ExportEntry { name, is_dir, size });
    }
    out.sort_by(|a, b| (!a.is_dir, &a.name).cmp(&(!b.is_dir, &b.name)));
    Ok(out)
}

/// Same walk as `generate_manifest`'s but without `is_excluded`'s top-level blacklist: the Share
/// export filters by the player's checklist (`export::filter_by_top_level`), so `saves`/`logs`/etc.
/// must stay walkable.
pub fn walk_export_paths(root: &Path) -> Result<Vec<PathBuf>, String> {
    let mut out = Vec::new();
    if root.exists() {
        walk_export_paths_only(root, root, &mut out)?;
    }
    out.sort();
    Ok(out)
}

fn walk_export_paths_only(root: &Path, dir: &Path, out: &mut Vec<PathBuf>) -> Result<(), String> {
    let entries = std::fs::read_dir(dir).map_err(|e| format!("Cannot read '{}': {}", dir.display(), e))?;
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        let rel = path
            .strip_prefix(root)
            .expect("walked path must be under root");
        if is_reserved(rel) {
            continue;
        }
        if path.is_dir() {
            walk_export_paths_only(root, &path, out)?;
        } else {
            out.push(rel.to_path_buf());
        }
    }
    Ok(())
}

/// Lowercase hex digest of a file's contents with its size, for the algorithm `D` (`Sha1`: what the
/// online services identify files by; `Sha256`: this format's hash). One loop for every use.
pub(crate) fn hash_file<D: Digest>(path: &Path) -> Result<(String, u64), String> {
    let mut file =
        std::fs::File::open(path).map_err(|e| format!("Cannot read '{}': {}", path.display(), e))?;
    let mut hasher = D::new();
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
    Ok((hasher.finalize().iter().map(|b| format!("{b:02x}")).collect(), size))
}

pub(crate) fn hash_file_sha1(path: &Path) -> Result<(String, u64), String> {
    hash_file::<sha1::Sha1>(path)
}

fn walk_files(root: &Path, dir: &Path, out: &mut Vec<ModpackFileEntry>) -> Result<(), String> {
    let entries = std::fs::read_dir(dir).map_err(|e| format!("Cannot read '{}': {}", dir.display(), e))?;
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        let rel = path
            .strip_prefix(root)
            .expect("walked path must be under root");
        if is_excluded(rel) {
            continue;
        }

        if path.is_dir() {
            walk_files(root, &path, out)?;
        } else {
            let (sha256, size) = hash_file::<Sha256>(&path)?;
            out.push(ModpackFileEntry {
                path: rel.to_string_lossy().replace('\\', "/"),
                sha256,
                size,
                source: FileSource::Server,
            });
        }
    }
    Ok(())
}

/// Scans an instance directory and builds a fresh manifest, hashing every distributable file on a
/// blocking thread. Does not save it; call `.save()` or compare first.
pub async fn generate_manifest(
    instance_dir: PathBuf,
    id: String,
    name: String,
    build: u64,
    version: Option<String>,
    minecraft_version: String,
    loader: MinecraftLoader,
    loader_version: Option<String>,
) -> Result<ModpackManifest, String> {
    tokio::task::spawn_blocking(move || {
        let mut files = Vec::new();
        if instance_dir.exists() {
            walk_files(&instance_dir, &instance_dir, &mut files)?;
        }
        files.sort_by(|a, b| a.path.cmp(&b.path));

        Ok(ModpackManifest {
            format_version: MODPACK_FORMAT_VERSION,
            id,
            name,
            build,
            version,
            minecraft_version,
            loader,
            loader_version,
            files,
        })
    })
    .await
    .map_err(|e| format!("Manifest generation task panicked: {}", e))?
}

/// What a client must do to bring `local` (or a from-scratch instance, if `None`) up to date with
/// `remote`. Pure data.
#[derive(Serialize, Clone)]
pub struct ModpackDiff {
    /// Files that are new or whose content changed — each entry carries everything needed to
    /// fetch it (`source`) and verify it after download (`sha256`/`size`).
    pub to_download: Vec<ModpackFileEntry>,
    /// Paths present locally but no longer in `remote`; they should be removed too (a leftover mod
    /// jar isn't harmless).
    pub to_delete: Vec<String>,
}

pub fn diff_manifests(local: Option<&ModpackManifest>, remote: &ModpackManifest) -> ModpackDiff {
    let local_by_path: HashMap<&str, &ModpackFileEntry> = local
        .map(|m| m.files.iter().map(|f| (f.path.as_str(), f)).collect())
        .unwrap_or_default();

    let to_download = remote
        .files
        .iter()
        .filter(|remote_file| {
            match local_by_path.get(remote_file.path.as_str()) {
                Some(local_file) => local_file.sha256 != remote_file.sha256,
                None => true,
            }
        })
        .cloned()
        .collect();

    let remote_paths: HashSet<&str> = remote.files.iter().map(|f| f.path.as_str()).collect();
    let to_delete = local
        .map(|m| {
            m.files
                .iter()
                .filter(|f| !remote_paths.contains(f.path.as_str()))
                .map(|f| f.path.clone())
                .collect()
        })
        .unwrap_or_default();

    ModpackDiff { to_download, to_delete }
}

/// `base.join(rel)` for a path that came from outside (a manifest, a zip entry): rejects `..`,
/// absolute paths and drive prefixes so it can never leave `base`.
pub fn safe_join(base: &Path, rel: &str) -> Result<PathBuf, String> {
    let rel_path = Path::new(rel);
    if rel.is_empty() || rel_path.components().any(|c| !matches!(c, Component::Normal(_))) {
        return Err(format!("Unsafe path in archive/manifest: '{}'", rel));
    }
    Ok(base.join(rel_path))
}

#[cfg(test)]
mod safe_join_tests {
    use super::*;

    #[test]
    fn rejects_escapes_and_accepts_nested() {
        let base = Path::new("inst");
        for bad in ["../evil.txt", "a/../../b", "/etc/passwd", "C:\\x", "", "./a"] {
            assert!(safe_join(base, bad).is_err(), "{bad}");
        }
        assert_eq!(safe_join(base, "mods/a.jar").unwrap(), base.join("mods").join("a.jar"));
    }
}

#[cfg(test)]
mod diff_tests {
    use super::*;

    fn file(path: &str, sha256: &str) -> ModpackFileEntry {
        ModpackFileEntry { path: path.into(), sha256: sha256.into(), size: 1, source: FileSource::Server }
    }

    fn manifest(build: u64, files: Vec<ModpackFileEntry>) -> ModpackManifest {
        ModpackManifest {
            format_version: MODPACK_FORMAT_VERSION,
            id: "p".into(),
            name: "P".into(),
            build,
            version: None,
            minecraft_version: "1.21.1".into(),
            loader: MinecraftLoader::FABRIC,
            loader_version: None,
            files,
        }
    }

    #[test]
    fn an_update_downloads_what_is_new_or_changed_and_deletes_what_is_gone() {
        let local = manifest(1, vec![file("mods/a.jar", "1"), file("mods/b.jar", "2"), file("config/c.toml", "3")]);
        let remote = manifest(2, vec![file("mods/a.jar", "1"), file("mods/b.jar", "22"), file("mods/new.jar", "4")]);
        let diff = diff_manifests(Some(&local), &remote);
        assert_eq!(diff.to_download.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(), ["mods/b.jar", "mods/new.jar"]);
        assert_eq!(diff.to_delete, ["config/c.toml"]);
    }

    #[test]
    fn a_first_install_downloads_everything_and_deletes_nothing() {
        let remote = manifest(1, vec![file("mods/a.jar", "1"), file("mods/b.jar", "2")]);
        let diff = diff_manifests(None, &remote);
        assert_eq!(diff.to_download.len(), 2);
        assert!(diff.to_delete.is_empty());
        assert!(diff_manifests(Some(&remote), &remote).to_download.is_empty());
    }
}

#[cfg(test)]
mod export_entry_tests {
    use super::*;

    #[test]
    fn the_checklist_shows_how_big_each_entry_is() {
        let dir = std::env::temp_dir().join(format!("nihao-export-size-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("mods/sub")).unwrap();
        std::fs::write(dir.join("mods/a.jar"), [0u8; 100]).unwrap();
        std::fs::write(dir.join("mods/sub/b.jar"), [0u8; 50]).unwrap();
        std::fs::write(dir.join("options.txt"), [0u8; 7]).unwrap();
        let entries = list_top_level_entries(&dir).unwrap();
        let size = |name: &str| entries.iter().find(|e| e.name == name).unwrap().size;
        assert_eq!((size("mods"), size("options.txt")), (150, 7));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
