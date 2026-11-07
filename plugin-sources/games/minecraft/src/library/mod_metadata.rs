//! Parses a mod jar's own metadata (name, version, icon) for the Content Manager, trying in order:
//! Fabric's `fabric.mod.json`, Forge/NeoForge's `META-INF/mods.toml`, and legacy pre-1.13
//! `mcmod.info`. A jar built for one loader may carry another's file too (e.g. a Fabric-API compat
//! jar in a NeoForge pack), so all three are tried.

use std::io::Read;
use std::path::Path;

use serde::Deserialize;
use zip::ZipArchive;

pub struct ModMetadata {
    pub name: Option<String>,
    pub version: Option<String>,
    /// Base64 data URI (same as `image_data_uri` in interface.rs), usable directly in `<img src>`.
    pub icon_data: Option<String>,
}

/// Real jars often reference their icon with different casing than the zip entry (`Icon.png` vs
/// `icon.png`), so fall back to a case-insensitive scan instead of treating it as "no icon".
fn find_entry_name(zip: &mut ZipArchive<std::fs::File>, name: &str) -> Option<String> {
    if zip.by_name(name).is_ok() {
        return Some(name.to_string());
    }
    let target = name.to_lowercase();
    (0..zip.len())
        .filter_map(|i| zip.by_index(i).ok().map(|f| f.name().to_string()))
        .find(|n| n.to_lowercase() == target)
}

/// Largest single jar entry read for metadata (JSON): a "zip bomb" entry can't fill RAM.
const MAX_ENTRY_BYTES: u64 = 8 * 1024 * 1024;
/// Largest icon taken. Every icon goes into the content list and `cache.nihao` as base64, so a
/// pack of a few hundred mods with 8 MB logos would make both enormous; a real mod icon is a few KB.
const MAX_ICON_BYTES: u64 = 256 * 1024;

fn read_zip_text(zip: &mut ZipArchive<std::fs::File>, name: &str) -> Option<String> {
    let resolved = find_entry_name(zip, name)?;
    let mut entry = zip.by_name(&resolved).ok()?;
    let mut content = String::new();
    (&mut entry).take(MAX_ENTRY_BYTES).read_to_string(&mut content).ok()?;
    Some(content)
}

fn read_zip_bytes(zip: &mut ZipArchive<std::fs::File>, name: &str) -> Option<Vec<u8>> {
    let resolved = find_entry_name(zip, name)?;
    let mut entry = zip.by_name(&resolved).ok()?;
    let mut bytes = Vec::new();
    // One byte over the limit tells "too big" from "just fits": a cut-off picture would be corrupt.
    (&mut entry).take(MAX_ICON_BYTES + 1).read_to_end(&mut bytes).ok()?;
    (bytes.len() as u64 <= MAX_ICON_BYTES).then_some(bytes)
}

pub(crate) fn to_data_uri(bytes: &[u8]) -> String {
    use base64::Engine;
    format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes))
}

#[derive(Deserialize)]
struct FabricModJson {
    name: Option<String>,
    version: Option<String>,
    #[serde(default)]
    icon: Option<serde_json::Value>,
}

/// Fabric's `icon` is a path string or (newer schema) an object mapping resolution to path; any
/// entry works.
fn fabric_icon_path(icon: &serde_json::Value) -> Option<String> {
    match icon {
        serde_json::Value::String(s) => Some(s.clone()),
        serde_json::Value::Object(map) => map.values().find_map(|v| v.as_str()).map(|s| s.to_string()),
        _ => None,
    }
}

#[derive(Deserialize)]
struct ModsToml {
    #[serde(default)]
    mods: Vec<ModsTomlEntry>,
}

#[derive(Deserialize)]
struct ModsTomlEntry {
    #[serde(rename = "displayName")]
    display_name: Option<String>,
    version: Option<String>,
    #[serde(rename = "logoFile")]
    logo_file: Option<String>,
}

#[derive(Deserialize)]
struct McModInfoEntry {
    name: Option<String>,
    version: Option<String>,
    #[serde(rename = "logoFile")]
    logo_file: Option<String>,
}

/// Reads `Implementation-Version` from `META-INF/MANIFEST.MF`, for mods.toml `version` fields left
/// as the literal `${file.jarVersion}` placeholder (ForgeGradle fills it from the jar manifest at
/// build time).
fn manifest_implementation_version(zip: &mut ZipArchive<std::fs::File>) -> Option<String> {
    let content = read_zip_text(zip, "META-INF/MANIFEST.MF")?;
    for line in content.lines() {
        if let Some(v) = line.strip_prefix("Implementation-Version:") {
            let v = v.trim();
            if !v.is_empty() {
                return Some(v.to_string());
            }
        }
    }
    None
}

pub fn read_mod_metadata(path: &Path) -> ModMetadata {
    let mut result = ModMetadata { name: None, version: None, icon_data: None };

    let file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return result,
    };
    let mut zip = match ZipArchive::new(file) {
        Ok(z) => z,
        Err(_) => return result,
    };

    if let Some(content) = read_zip_text(&mut zip, "fabric.mod.json") {
        if let Ok(meta) = serde_json::from_str::<FabricModJson>(&content) {
            result.name = meta.name;
            result.version = meta.version;
            if let Some(icon_path) = meta.icon.as_ref().and_then(fabric_icon_path) {
                if let Some(bytes) = read_zip_bytes(&mut zip, &icon_path) {
                    result.icon_data = Some(to_data_uri(&bytes));
                }
            }
            return result;
        }
    }

    if let Some(content) = read_zip_text(&mut zip, "META-INF/mods.toml") {
        if let Ok(parsed) = toml::from_str::<ModsToml>(&content) {
            if let Some(entry) = parsed.mods.into_iter().next() {
                result.name = entry.display_name;
                result.version = match entry.version {
                    Some(v) if v.contains("${file.jarVersion}") => {
                        manifest_implementation_version(&mut zip).or(Some(v))
                    }
                    other => other,
                };
                if let Some(logo) = entry.logo_file {
                    if let Some(bytes) = read_zip_bytes(&mut zip, &logo) {
                        result.icon_data = Some(to_data_uri(&bytes));
                    }
                }
            }
            return result;
        }
    }

    if let Some(content) = read_zip_text(&mut zip, "mcmod.info") {
        if let Ok(entries) = serde_json::from_str::<Vec<McModInfoEntry>>(&content) {
            if let Some(entry) = entries.into_iter().next() {
                result.name = entry.name;
                result.version = entry.version;
                if let Some(logo) = entry.logo_file {
                    if let Some(bytes) = read_zip_bytes(&mut zip, &logo) {
                        result.icon_data = Some(to_data_uri(&bytes));
                    }
                }
            }
        }
    }

    result
}

#[derive(Deserialize)]
struct PackMcMeta {
    pack: PackMcMetaInner,
}

#[derive(Deserialize)]
struct PackMcMetaInner {
    description: Option<serde_json::Value>,
}

/// `pack.mcmeta`'s `description` is a plain string (maybe with legacy `§` colour codes) or a text
/// component (object with `text`, or an array); flattens either to plain text.
fn description_to_text(desc: &serde_json::Value) -> Option<String> {
    fn strip_color_codes(s: &str) -> String {
        let mut out = String::with_capacity(s.len());
        let mut chars = s.chars();
        while let Some(c) = chars.next() {
            if c == '§' {
                chars.next();
            } else {
                out.push(c);
            }
        }
        out.trim().to_string()
    }

    match desc {
        serde_json::Value::String(s) => {
            let text = strip_color_codes(s);
            if text.is_empty() { None } else { Some(text) }
        }
        serde_json::Value::Object(map) => map.get("text").and_then(|v| v.as_str()).map(strip_color_codes),
        serde_json::Value::Array(arr) => {
            let joined: String = arr
                .iter()
                .filter_map(|v| v.as_str().map(String::from).or_else(|| v.get("text").and_then(|t| t.as_str()).map(String::from)))
                .collect();
            let text = strip_color_codes(&joined);
            if text.is_empty() { None } else { Some(text) }
        }
        _ => None,
    }
}

/// Resourcepack/datapack metadata: `pack.mcmeta`'s `description` (used as the display name, as the
/// format has no name field) and `pack.png`. Never a version (a Modrinth match can supply it).
/// `is_dir` picks between an unpacked directory and a zip.
pub fn read_pack_metadata(path: &Path, is_dir: bool) -> ModMetadata {
    if is_dir {
        read_pack_metadata_dir(path)
    } else {
        read_pack_metadata_zip(path)
    }
}

fn read_pack_metadata_dir(dir: &Path) -> ModMetadata {
    let mut result = ModMetadata { name: None, version: None, icon_data: None };
    if let Ok(content) = std::fs::read_to_string(dir.join("pack.mcmeta")) {
        if let Ok(meta) = serde_json::from_str::<PackMcMeta>(&content) {
            result.name = meta.pack.description.as_ref().and_then(description_to_text);
        }
    }
    let icon = dir.join("pack.png");
    if std::fs::metadata(&icon).is_ok_and(|m| m.len() <= MAX_ICON_BYTES) {
        if let Ok(bytes) = std::fs::read(&icon) {
            result.icon_data = Some(to_data_uri(&bytes));
        }
    }
    result
}

fn read_pack_metadata_zip(path: &Path) -> ModMetadata {
    let mut result = ModMetadata { name: None, version: None, icon_data: None };

    let file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return result,
    };
    let mut zip = match ZipArchive::new(file) {
        Ok(z) => z,
        Err(_) => return result,
    };

    if let Some(content) = read_zip_text(&mut zip, "pack.mcmeta") {
        if let Ok(meta) = serde_json::from_str::<PackMcMeta>(&content) {
            result.name = meta.pack.description.as_ref().and_then(description_to_text);
        }
    }
    if let Some(bytes) = read_zip_bytes(&mut zip, "pack.png") {
        result.icon_data = Some(to_data_uri(&bytes));
    }

    result
}
