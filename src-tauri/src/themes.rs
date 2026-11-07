//! Themes shipped as files: `themes/<id>/theme.json` next to the exe. A bundle is JavaScript the
//! frontend runs, so this module is strict: ids and entry names are plain names (no paths), files
//! have a size cap, and each bundle comes with its SHA-256 so the frontend can tell whether it is
//! the one the user approved.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::get_program_path;

/// A theme bundle is a built UI; nothing legitimate is anywhere near this.
const MAX_BUNDLE_BYTES: u64 = 5 * 1024 * 1024;
const MAX_MANIFEST_BYTES: u64 = 64 * 1024;
const MAX_ICON_BYTES: u64 = 256 * 1024;
/// A theme's own files (`assets/`): each, and all together. Images and fonts only.
const MAX_ASSET_BYTES: u64 = 2 * 1024 * 1024;
const MAX_ASSETS_TOTAL: u64 = 12 * 1024 * 1024;
const MAX_ASSET_COUNT: usize = 200;

/// File types a theme may ship, with their MIME type. Anything else (scripts, html, ...) is
/// ignored: assets are data, a theme's only code is its bundle.
fn mime_for(name: &str) -> Option<&'static str> {
    let ext = name.rsplit('.').next()?.to_ascii_lowercase();
    Some(match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "svg" => "image/svg+xml",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        _ => return None,
    })
}

fn data_uri(name: &str, bytes: &[u8]) -> Option<String> {
    Some(format!("data:{};base64,{}", mime_for(name)?, STANDARD.encode(bytes)))
}

#[derive(Deserialize)]
struct Manifest {
    id: String,
    name: String,
    version: String,
    #[serde(default)]
    author: Option<String>,
    /// File name of the bundle inside the theme's folder.
    #[serde(default = "default_entry")]
    entry: String,
    /// File name of the theme's preview icon (png/svg/...), shown in the theme list.
    #[serde(default)]
    icon: Option<String>,
}

fn default_entry() -> String {
    "theme.js".to_string()
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct ThemeInfo {
    pub id: String,
    pub name: String,
    pub version: String,
    pub author: Option<String>,
    /// SHA-256 (hex) of the bundle file, computed here from the bytes that would be run.
    pub hash: String,
    /// The preview icon as a data URI, if the theme has a (valid) one.
    pub icon: Option<String>,
}

#[derive(Serialize)]
pub struct ThemeBundle {
    pub info: ThemeInfo,
    pub code: String,
    /// The theme's own files from its `assets/` folder: relative name (`/`-separated) -> data URI.
    pub assets: HashMap<String, String>,
}

/// `[A-Za-z0-9_-]`, 1–64 chars: safe as a folder name, a map key and inside a URL.
fn valid_name(s: &str) -> bool {
    !s.is_empty() && s.len() <= 64 && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// A file name only — no separators, no `..` — so an entry can never point outside its folder.
fn valid_entry(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 128
        && !s.contains(['/', '\\', ':'])
        && s != "."
        && s != ".."
        && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
}

fn read_limited(path: &Path, max: u64) -> Result<Vec<u8>, String> {
    let meta = fs::metadata(path).map_err(|e| format!("{}: {e}", path.display()))?;
    if !meta.is_file() {
        return Err(format!("{} is not a file", path.display()));
    }
    if meta.len() > max {
        return Err(format!("{} is too large ({} bytes)", path.display(), meta.len()));
    }
    fs::read(path).map_err(|e| format!("{}: {e}", path.display()))
}

/// Validates one theme folder and returns its info together with the bundle bytes.
fn read_theme(dir: &Path) -> Result<(ThemeInfo, Vec<u8>), String> {
    let folder = dir
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| "bad theme folder name".to_string())?;
    let manifest: Manifest = serde_json::from_slice(&read_limited(&dir.join("theme.json"), MAX_MANIFEST_BYTES)?)
        .map_err(|e| format!("{folder}/theme.json: {e}"))?;

    if !valid_name(&manifest.id) {
        return Err(format!("{folder}: invalid theme id '{}'", manifest.id));
    }
    // The folder name is the id, so an id can't be claimed by a differently-named folder.
    if manifest.id != folder {
        return Err(format!("{folder}: theme.json id '{}' does not match the folder name", manifest.id));
    }
    if !valid_entry(&manifest.entry) {
        return Err(format!("{folder}: invalid entry '{}'", manifest.entry));
    }

    let bytes = read_limited(&dir.join(&manifest.entry), MAX_BUNDLE_BYTES)?;
    let hash = hex::encode(Sha256::digest(&bytes));

    let icon = manifest
        .icon
        .as_deref()
        .filter(|name| valid_entry(name))
        .and_then(|name| read_limited(&dir.join(name), MAX_ICON_BYTES).ok().and_then(|b| data_uri(name, &b)));
    Ok((
        ThemeInfo {
            id: manifest.id,
            name: manifest.name,
            version: manifest.version,
            author: manifest.author,
            hash,
            icon,
        },
        bytes,
    ))
}

fn scan(base: &Path) -> Vec<ThemeInfo> {
    let Ok(entries) = fs::read_dir(base) else { return Vec::new() };
    let mut found: Vec<ThemeInfo> = entries
        .flatten()
        .filter(|e| e.path().is_dir())
        .filter_map(|e| match read_theme(&e.path()) {
            Ok((info, _)) => Some(info),
            Err(err) => {
                eprintln!("[themes] skipped: {err}");
                None
            }
        })
        .collect();
    found.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    found
}

/// Reads `<theme>/assets/**` (up to two folders deep) into name -> data URI. Names are relative to
/// `assets/`; symlinks are not followed; only the file types in `mime_for`, within the size limits.
fn read_assets(dir: &Path) -> HashMap<String, String> {
    let mut out = HashMap::new();
    let mut total = 0u64;
    walk_assets(&dir.join("assets"), "", 0, &mut out, &mut total);
    out
}

fn walk_assets(dir: &Path, prefix: &str, depth: u8, out: &mut HashMap<String, String>, total: &mut u64) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        if out.len() >= MAX_ASSET_COUNT {
            return;
        }
        let Ok(ft) = entry.file_type() else { continue };
        if ft.is_symlink() {
            continue;
        }
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else { continue };
        if !valid_entry(&name) {
            continue;
        }
        let rel = if prefix.is_empty() { name.clone() } else { format!("{prefix}/{name}") };
        if ft.is_dir() {
            if depth < 2 {
                walk_assets(&entry.path(), &rel, depth + 1, out, total);
            }
        } else if ft.is_file() {
            let Ok(bytes) = read_limited(&entry.path(), MAX_ASSET_BYTES) else { continue };
            if *total + bytes.len() as u64 > MAX_ASSETS_TOTAL {
                continue;
            }
            if let Some(uri) = data_uri(&name, &bytes) {
                *total += bytes.len() as u64;
                out.insert(rel, uri);
            }
        }
    }
}

fn load(base: &Path, id: &str) -> Result<ThemeBundle, String> {
    if !valid_name(id) {
        return Err(format!("invalid theme id '{id}'"));
    }
    let dir = base.join(id);
    let (info, bytes) = read_theme(&dir)?;
    let code = String::from_utf8(bytes).map_err(|_| format!("{id}: bundle is not valid UTF-8"))?;
    Ok(ThemeBundle { info, code, assets: read_assets(&dir) })
}

/// SHA-256 of the bundle a theme folder would run right now, `None` if there is no valid theme `id`.
pub fn current_hash(id: &str) -> Option<String> {
    if !valid_name(id) {
        return None;
    }
    read_theme(&themes_dir().ok()?.join(id)).ok().map(|(info, _)| info.hash)
}

pub fn themes_dir() -> Result<PathBuf, String> {
    Ok(get_program_path()?.join("themes"))
}

/// Every valid theme in `themes/` (the built-in "console" isn't a folder and isn't listed here).
#[tauri::command]
pub fn list_themes() -> Result<Vec<ThemeInfo>, String> {
    let dir = themes_dir()?;
    let _ = fs::create_dir_all(&dir);
    Ok(scan(&dir))
}

/// The bundle of one theme, ready to run. The hash in `info` is of exactly these bytes.
#[tauri::command]
pub fn get_theme_bundle(id: String) -> Result<ThemeBundle, String> {
    load(&themes_dir()?, &id)
}

/// Opens the `themes/` folder in the system file manager.
#[tauri::command]
pub fn open_themes_dir() -> Result<(), String> {
    let dir = themes_dir()?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    crate::platforms::open_folder(&dir)
}

/// Safe mode starts the launcher with the built-in theme no matter what is saved: `--safe-mode`
/// on the command line, or `NIHAO_SAFE_MODE=1` — the way out if a theme ever makes the launcher
/// hard to use.
#[tauri::command]
pub fn is_safe_mode() -> bool {
    std::env::args().any(|a| a == "--safe-mode")
        || std::env::var("NIHAO_SAFE_MODE").map(|v| v == "1").unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_base(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("nihao-themes-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_theme(base: &Path, folder: &str, manifest: &str, bundle: Option<(&str, &[u8])>) {
        let dir = base.join(folder);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("theme.json"), manifest).unwrap();
        if let Some((name, bytes)) = bundle {
            fs::write(dir.join(name), bytes).unwrap();
        }
    }

    #[test]
    fn lists_a_valid_theme_with_a_stable_hash() {
        let base = temp_base("valid");
        write_theme(
            &base,
            "ocean",
            r#"{"id":"ocean","name":"Ocean","version":"1.2.0","author":"me"}"#,
            Some(("theme.js", b"var NihaoThemeEntry = {};")),
        );
        let found = scan(&base);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].id, "ocean");
        assert_eq!(found[0].author.as_deref(), Some("me"));
        assert_eq!(found[0].hash, hex::encode(Sha256::digest(b"var NihaoThemeEntry = {};")));
        let bundle = load(&base, "ocean").unwrap();
        assert_eq!(bundle.code, "var NihaoThemeEntry = {};");
        assert_eq!(bundle.info, found[0]);
    }

    #[test]
    fn icon_and_assets_are_served_as_data_uris_within_limits() {
        let base = temp_base("assets");
        write_theme(
            &base,
            "art",
            r#"{"id":"art","name":"Art","version":"1","icon":"icon.svg"}"#,
            Some(("theme.js", b"x")),
        );
        let dir = base.join("art");
        fs::write(dir.join("icon.svg"), b"<svg/>").unwrap();
        fs::create_dir_all(dir.join("assets").join("bg")).unwrap();
        fs::write(dir.join("assets").join("logo.png"), b"png").unwrap();
        fs::write(dir.join("assets").join("bg").join("tile.webp"), b"webp").unwrap();
        fs::write(dir.join("assets").join("evil.js"), b"alert(1)").unwrap();
        fs::write(dir.join("assets").join("page.html"), b"<h1>").unwrap();
        fs::File::create(dir.join("assets").join("huge.png")).unwrap().set_len(MAX_ASSET_BYTES + 1).unwrap();

        let info = &scan(&base)[0];
        assert!(info.icon.as_deref().unwrap().starts_with("data:image/svg+xml;base64,"));
        let bundle = load(&base, "art").unwrap();
        let mut names: Vec<_> = bundle.assets.keys().cloned().collect();
        names.sort();
        assert_eq!(names, vec!["bg/tile.webp", "logo.png"], "only allowed types within limits");
        assert!(bundle.assets["logo.png"].starts_with("data:image/png;base64,"));
    }

    #[test]
    fn a_bad_icon_just_means_no_icon() {
        let base = temp_base("badicon");
        for icon in ["../x.png", "icon.exe", "missing.png"] {
            write_theme(
                &base,
                "t",
                &format!(r#"{{"id":"t","name":"T","version":"1","icon":"{icon}"}}"#),
                Some(("theme.js", b"x")),
            );
            let found = scan(&base);
            assert_eq!(found.len(), 1, "theme still listed with icon {icon:?}");
            assert!(found[0].icon.is_none());
        }
    }

    #[test]
    fn changing_the_bundle_changes_the_hash() {
        let base = temp_base("hash");
        write_theme(&base, "t", r#"{"id":"t","name":"T","version":"1"}"#, Some(("theme.js", b"a")));
        let first = scan(&base)[0].hash.clone();
        fs::write(base.join("t").join("theme.js"), b"b").unwrap();
        assert_ne!(first, scan(&base)[0].hash);
    }

    #[test]
    fn rejects_entries_that_escape_the_folder() {
        let base = temp_base("escape");
        for entry in ["../secret.js", "..", "a/b.js", "a\\b.js", "C:evil.js", ""] {
            write_theme(
                &base,
                "evil",
                &format!(r#"{{"id":"evil","name":"E","version":"1","entry":{}}}"#, serde_json::to_string(entry).unwrap()),
                None,
            );
            assert!(scan(&base).is_empty(), "entry {entry:?} must be rejected");
            assert!(load(&base, "evil").is_err());
        }
    }

    #[test]
    fn rejects_bad_ids_and_mismatched_folders() {
        let base = temp_base("ids");
        write_theme(&base, "ok", r#"{"id":"other","name":"N","version":"1"}"#, Some(("theme.js", b"x")));
        write_theme(&base, "bad id", r#"{"id":"bad id","name":"N","version":"1"}"#, Some(("theme.js", b"x")));
        assert!(scan(&base).is_empty());
        assert!(load(&base, "../ok").is_err());
        assert!(load(&base, "").is_err());
    }

    #[test]
    fn rejects_oversized_bundles_and_survives_broken_neighbours() {
        let base = temp_base("big");
        write_theme(&base, "huge", r#"{"id":"huge","name":"H","version":"1"}"#, None);
        let f = fs::File::create(base.join("huge").join("theme.js")).unwrap();
        f.set_len(MAX_BUNDLE_BYTES + 1).unwrap();
        write_theme(&base, "broken", "{ not json", Some(("theme.js", b"x")));
        write_theme(&base, "fine", r#"{"id":"fine","name":"F","version":"1"}"#, Some(("theme.js", b"x")));
        let found = scan(&base);
        assert_eq!(found.len(), 1, "only the valid theme is listed");
        assert_eq!(found[0].id, "fine");
    }
}
