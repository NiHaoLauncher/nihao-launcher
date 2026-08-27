//! The distributable modpack manifest format — a flat list of every distributable file in a
//! pack plus its SHA-256, so a not-yet-built server fragment can publish new "builds" of a
//! pack and the client can ask "what changed since build N?" instead of re-downloading the
//! whole pack on every update. See MODPACK_FORMAT.md at the repo root for the full spec and
//! the proposed server API this is meant to talk to.
//!
//! Persisted locally as the `pack` field on `MinecraftProfile` (`profile.nihao`) — this used
//! to be its own `modpack.nihao` file, but `profile.nihao` was already "the file that
//! describes this instance's pack" in every way that mattered, so it was folded in there
//! instead of keeping two `.nihao` files in sync per instance.

use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::library::version::MinecraftLoader;

pub const MODPACK_FORMAT_VERSION: u32 = 1;

/// One published release ("build") of a modpack — the unit the (future) server stores,
/// diffs, and serves. Every field beyond the first four is `#[serde(default)]`, mirroring
/// `MinecraftProfile`'s forward-compat convention.
#[derive(Serialize, Deserialize, Clone)]
pub struct ModpackManifest {
    pub format_version: u32,
    /// Stable id of the pack on the server (not the local instance's directory name, which
    /// the player can rename freely — see `rename_modpack` in interface.rs).
    pub id: String,
    pub name: String,
    /// Monotonically increasing per published release. This, not `version`, is what diffing
    /// and "is there an update" checks should compare — a free-text version label is easy to
    /// get wrong/skip/reuse by accident, a counter isn't.
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
    /// Instance-relative, forward-slash-separated (even on Windows) so manifests are
    /// portable/comparable byte-for-byte regardless of the platform that generated them.
    pub path: String,
    /// Lowercase hex SHA-256 of the file's contents.
    pub sha256: String,
    pub size: u64,
    #[serde(default)]
    pub source: FileSource,
}

/// Where a file's bytes come from when it needs to be (re)downloaded. Defaults to `Server`
/// (the games/minecraft server fragment serves it directly) — `Url` exists so a manifest can
/// instead point straight at a CDN/mirror (e.g. Modrinth/CurseForge) without the server having
/// to proxy every byte itself.
#[derive(Serialize, Deserialize, Clone, PartialEq, Default)]
#[serde(rename_all = "lowercase", tag = "type")]
pub enum FileSource {
    #[default]
    Server,
    Url {
        url: String,
    },
}

/// Subpaths never included in a generated manifest — player/run-specific data (saves, logs,
/// screenshots) and the instance's own local-only files, none of which a *pack* should own or
/// let a server overwrite.
const EXCLUDED_TOP_LEVEL_DIRS: &[&str] = &["saves", "logs", "crash-reports", "screenshots"];

/// Every file's own bookkeeping/per-player customization — never pack content, regardless of
/// which top-level folders/files the player chose to include (see `is_excluded` and the
/// Share export's `list_top_level_entries`/`walk_export_paths` below).
fn is_reserved(rel_path: &Path) -> bool {
    if rel_path.extension().and_then(|e| e.to_str()) == Some("nihao") {
        return true; // profile.nihao itself — local bookkeeping, not pack content
    }
    if let Some(name) = rel_path.file_name().and_then(|n| n.to_str()) {
        if name == "icon" || name == "banner" {
            return true; // per-player custom icon/banner (see interface.rs's set_modpack_icon/
                          // set_modpack_banner) — not pack content
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
}

/// The top-level folders/files directly inside an instance directory, for the Share export's
/// "what to include" checklist — everything except `is_reserved` (bookkeeping/per-player
/// files, never a choice at all). Notably does **not** hide `saves`/`logs`/`crash-reports`/
/// `screenshots` the way `is_excluded` does for `generate_manifest` — those are just unchecked
/// by default in the UI, not force-excluded, since sharing is an explicit player choice.
/// Folders sort before files, alphabetically within each group — the usual file-manager order.
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
        out.push(ExportEntry { name, is_dir });
    }
    out.sort_by(|a, b| (!a.is_dir, &a.name).cmp(&(!b.is_dir, &b.name)));
    Ok(out)
}

/// Same walk as `generate_manifest`'s, but without `is_excluded`'s top-level dir blacklist —
/// the Share export filters by the player's own checklist selection instead (see
/// `export::filter_by_top_level` in `library/export.rs`), so `saves`/`logs`/etc. need to still
/// be walkable here in case the player explicitly checked them.
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

pub(crate) fn hash_file(path: &Path) -> Result<(String, u64), String> {
    let mut file =
        std::fs::File::open(path).map_err(|e| format!("Cannot read '{}': {}", path.display(), e))?;
    let mut hasher = Sha256::new();
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
            let (sha256, size) = hash_file(&path)?;
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

/// Scans an instance directory and builds a fresh manifest for it (hashing every distributable
/// file — CPU/IO-bound, so this runs on a blocking thread). Does **not** save it; call
/// `.save()` on the result, or let the caller decide (e.g. compare against the currently saved
/// one first).
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

/// What a client needs to do to bring `local` (or a from-scratch instance, if `None`) up to
/// date with `remote`. Pure data — fetching `to_download`'s bytes and applying `to_delete` is
/// left to whatever the eventual server integration looks like.
#[derive(Serialize, Clone)]
pub struct ModpackDiff {
    /// Files that are new or whose content changed — each entry carries everything needed to
    /// fetch it (`source`) and verify it after download (`sha256`/`size`).
    pub to_download: Vec<ModpackFileEntry>,
    /// Paths present locally but no longer in `remote` — the pack dropped them, so they should
    /// be removed from the instance too (a leftover mod jar is not a harmless no-op).
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
