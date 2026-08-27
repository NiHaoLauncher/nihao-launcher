//! Parses a mod jar's own metadata (display name, version, icon) for the Content Manager.
//! Tries, in order:
//! - Fabric's `fabric.mod.json` (JSON at the jar root)
//! - Forge/NeoForge's `META-INF/mods.toml` (TOML)
//! - The legacy pre-Forge-1.13 `mcmod.info` (a JSON array)
//!
//! A jar built for one loader occasionally still carries another's metadata file too (e.g. a
//! Fabric-API compatibility jar bundled into a NeoForge pack), so all three are worth trying
//! rather than picking one based on the instance's own loader.

use std::io::Read;
use std::path::Path;

use serde::Deserialize;
use zip::ZipArchive;

pub struct ModMetadata {
    pub name: Option<String>,
    pub version: Option<String>,
    /// Base64 data URI — same convention as `interface.rs`'s `image_data_uri` for
    /// icon/banner, so the frontend can use it directly in an `<img src>`.
    pub icon_data: Option<String>,
}

/// Zip entry names are matched exactly by `by_name` per the zip spec, but plenty of real mod
/// jars reference their own icon with different casing than the entry actually has (e.g.
/// `Icon.png` in fabric.mod.json vs. an `icon.png` entry) — falls back to a case-insensitive
/// scan when the exact name isn't found, rather than silently treating that as "no icon".
fn find_entry_name(zip: &mut ZipArchive<std::fs::File>, name: &str) -> Option<String> {
    if zip.by_name(name).is_ok() {
        return Some(name.to_string());
    }
    let target = name.to_lowercase();
    (0..zip.len())
        .filter_map(|i| zip.by_index(i).ok().map(|f| f.name().to_string()))
        .find(|n| n.to_lowercase() == target)
}

fn read_zip_text(zip: &mut ZipArchive<std::fs::File>, name: &str) -> Option<String> {
    let resolved = find_entry_name(zip, name)?;
    let mut entry = zip.by_name(&resolved).ok()?;
    let mut content = String::new();
    entry.read_to_string(&mut content).ok()?;
    Some(content)
}

fn read_zip_bytes(zip: &mut ZipArchive<std::fs::File>, name: &str) -> Option<Vec<u8>> {
    let resolved = find_entry_name(zip, name)?;
    let mut entry = zip.by_name(&resolved).ok()?;
    let mut bytes = Vec::new();
    entry.read_to_end(&mut bytes).ok()?;
    Some(bytes)
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

/// Fabric's `icon` field is either a plain path string, or (newer schema) an object mapping
/// resolution to path (`{"16x16": "...", "32x32": "..."}`) — any one of those is fine here.
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

/// Reads `META-INF/MANIFEST.MF`'s `Implementation-Version` — for mods.toml's `version` field
/// left as the literal, unresolved `${file.jarVersion}` placeholder (ForgeGradle substitutes
/// that at build time from the jar's own manifest; a jar built without that step keeps it
/// literal, which would otherwise show up verbatim as the "version" in the UI).
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

/// `pack.mcmeta`'s `description` is either a plain string (possibly with legacy `§`-color
/// codes) or a Minecraft text component (an object with a `text` field, or an array of them,
/// per the modern format) — flattens either shape down to plain text.
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

/// Resourcepack/datapack metadata — `pack.mcmeta`'s `description` (used as the display "name",
/// there being no dedicated name field in the format) and `pack.png` (resourcepacks only in
/// practice; datapacks don't usually ship one, but nothing stops it). Never carries a version —
/// nothing in the format has one; a Modrinth match can still fill that in separately.
/// `is_dir` picks between reading a real directory (an unpacked pack) or a zip file.
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
    if let Ok(bytes) = std::fs::read(dir.join("pack.png")) {
        result.icon_data = Some(to_data_uri(&bytes));
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
