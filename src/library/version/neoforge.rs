use std::path::PathBuf;

use reqwest::Client;
use serde_json::Value;

use crate::library::MinecraftInstance;
use crate::library::version::{MinecraftArguments, MinecraftInstanceDownload};


pub struct NeoForgePaths {
    /// The raw downloaded `neoforge-{version}-installer.jar`.
    pub installer_jar: PathBuf,
    /// Where that jar's contents (`install_profile.json`, `version.json`, `data/*`) are
    /// extracted to — cached per-version so re-installing doesn't re-download/re-extract.
    pub install_dir: PathBuf,
}

pub fn paths_for(instance: &MinecraftInstance, version: &str) -> NeoForgePaths {
    let base = instance.path.library.join("net/neoforged/neoforge").join(version);
    NeoForgePaths {
        installer_jar: base.join("installer.jar"),
        install_dir: base.join("installer_extracted"),
    }
}

async fn ensure_installer_extracted(paths: &NeoForgePaths, version: &str) -> Result<(), String> {
    if paths.install_dir.join("install_profile.json").exists() {
        return Ok(());
    }

    tokio::fs::create_dir_all(&paths.install_dir)
        .await
        .map_err(|e| e.to_string())?;

    let installer_url = format!(
        "https://maven.neoforged.net/releases/net/neoforged/neoforge/{v}/neoforge-{v}-installer.jar",
        v = version
    );
    crate::library::install::download(&installer_url, paths.installer_jar.clone()).await?;

    let content = tokio::fs::read(&paths.installer_jar)
        .await
        .map_err(|e| e.to_string())?;
    zip_extract::extract(std::io::Cursor::new(content), &paths.install_dir, false)
        .map_err(|e| e.to_string())?;

    Ok(())
}

/// Raw NeoForge version strings (e.g. `26.2.0.64`, `21.1.248`), in the order Maven lists
/// them (oldest first).
pub async fn get_manifest_async() -> Result<Vec<String>, String> {
    let url = "https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml";
    let client = Client::new();
    let text = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("Error getting NeoForge maven-metadata.xml: {}", e))?
        .text()
        .await
        .map_err(|e| format!("Error reading maven-metadata.xml: {}", e))?;

    let mut versions = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("<version>") {
            if let Some(version) = rest.strip_suffix("</version>") {
                versions.push(version.to_string());
            }
        }
    }
    Ok(versions)
}

/// NeoForge's version scheme drops Minecraft's leading `"1."` (e.g. MC `1.21.1` -> NeoForge
/// versions starting `21.1.`), except for the newer no-`"1."` MC versions where it matches
/// as-is (e.g. MC `26.2` -> NeoForge versions starting `26.2.`).
fn neoforge_prefix_for_mc(mc_id: &str) -> &str {
    mc_id.strip_prefix("1.").unwrap_or(mc_id)
}

/// Real Minecraft release ids that NeoForge actually has builds for — powers the "Game
/// version" select when NeoForge is the chosen loader.
pub async fn get_supported_mc_versions_async() -> Result<Vec<String>, String> {
    let raw_versions = get_manifest_async().await?;
    let vanilla_manifest = crate::library::version::vanilla::get_manifest_async().await?;

    let matched: Vec<String> = vanilla_manifest
        .versions
        .into_iter()
        .filter(|v| v.r#type == "release")
        .filter(|v| {
            let prefix = neoforge_prefix_for_mc(&v.id);
            raw_versions.iter().any(|nf| nf.starts_with(&format!("{}.", prefix)))
        })
        .map(|v| v.id)
        .collect();

    Ok(matched)
}

/// NeoForge build versions for one chosen Minecraft version, newest first — powers the
/// "Loader version" select, same UX as Fabric's.
pub async fn get_versions_for_mc(mc_id: &str) -> Result<Vec<String>, String> {
    let raw_versions = get_manifest_async().await?;
    let prefix = neoforge_prefix_for_mc(mc_id);

    let mut matched: Vec<String> = raw_versions
        .into_iter()
        .filter(|v| v.starts_with(&format!("{}.", prefix)))
        .collect();
    matched.reverse(); // maven-metadata lists oldest first
    Ok(matched)
}

pub async fn get_launch_option(instance: &mut MinecraftInstance) -> Result<crate::library::version::MinecraftInstanceOption, String> {
    // Vanilla base, same pattern as Fabric — NeoForge's version.json only layers overrides
    // (mainClass/arguments/libraries) on top, it doesn't redefine assets/java_version/etc.
    let mut option = crate::library::version::vanilla::get_launch_option(instance).await?;

    let neoforge_version = instance
        .version
        .loader
        .clone()
        .ok_or_else(|| "No NeoForge loader version selected".to_string())?;

    let paths = paths_for(instance, &neoforge_version);
    ensure_installer_extracted(&paths, &neoforge_version).await?;

    let version_json: Value = serde_json::from_str(
        &tokio::fs::read_to_string(paths.install_dir.join("version.json"))
            .await
            .map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;

    if let Some(main_class) = version_json["mainClass"].as_str() {
        option.main_class = main_class.to_string();
    }

    let arguments = option
        .arguments
        .get_or_insert_with(|| MinecraftArguments { game: Vec::new(), jvm: Vec::new() });
    if let Some(game_args) = version_json["arguments"]["game"].as_array() {
        arguments.game.extend(game_args.iter().filter_map(|v| v.as_str()).map(str::to_string));
    }
    if let Some(jvm_args) = version_json["arguments"]["jvm"].as_array() {
        arguments.jvm.extend(jvm_args.iter().filter_map(|v| v.as_str()).map(str::to_string));
    }

    if let Some(libs) = version_json["libraries"].as_array() {
        for lib in libs {
            let name = lib["name"].as_str().unwrap_or("");
            let path = lib["downloads"]["artifact"]["path"].as_str().unwrap_or("");
            let url = lib["downloads"]["artifact"]["url"].as_str().unwrap_or("");
            let sha1 = lib["downloads"]["artifact"]["sha1"].as_str().unwrap_or("");
            if path.is_empty() || url.is_empty() {
                continue;
            }
            option.libraries.push(MinecraftInstanceDownload {
                name: name.to_string(),
                url: url.to_string(),
                path: path.to_string(),
                sha1: sha1.to_string(),
                resource: "neoforge-library".to_string(),
            });
        }
    }

    // Unlike Fabric, NeoForge's patched client content is *not* placed on `-cp` at all.
    // FML's own `NeoForgeClientLaunchHandler` assembles its "minecraft" module internally
    // by resolving `net.minecraft:client::srg`, `::extra`, and `net.neoforged:neoforge:*:client`
    // via `LibraryFinder` (driven by `-DlibraryDirectory` + the `--fml.*` args this launcher
    // already passes) — all three are produced, at exactly those maven-layout paths, by
    // `install::run_neoforge_processors`. `option.other_client` stays empty here.

    Ok(option)
}
