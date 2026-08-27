use std::{io::Cursor, path::{Path, PathBuf}};

use reqwest::Client;
use serde_json::Value;
use tokio::{fs::{self, File}, io::AsyncWriteExt, sync::mpsc};

use crate::library::{MinecraftInstance, java, version::{MinecraftInstanceJavaVersion, MinecraftInstanceOption}};

#[derive(Debug, Clone)]
pub struct DownloadInfo {
    pub total_etaps: usize,
    pub current_etaps: usize,
    pub etap: String,
    pub total_files: usize,
    pub current_file: usize,
    pub status: InstallStatus,
    pub filename: String,
}

#[derive(Debug, Clone)]
pub enum InstallStatus {
    CHECK, SKIP, INSTALL, WRITE, DELETE, EXTRACT
}
impl InstallStatus {
    pub fn to_string(&self) -> String {
        match self {
            Self::CHECK => "check".to_string(),
            Self::SKIP => "skip".to_string(),
            Self::INSTALL => "install".to_string(),
            Self::WRITE => "write".to_string(),
            Self::DELETE => "delete".to_string(),
            Self::EXTRACT => "extract".to_string(),
        }
    }
}

pub(super) async fn send_status_with_etaps(tx: &mpsc::Sender<DownloadInfo>, value: DownloadInfo) {
    if tx
        .send(value.clone())
        .await
        .is_err()
    {
        eprintln!("Receiver dropped: {:?}", value);
    }
}
pub async fn download(url:&str, path:PathBuf) -> Result<(),String> {
    let response = reqwest::get(url).await
        .map_err(|e|format!("Error install '{}' library: {}", url, e))?;
    let content = response
        .bytes()
        .await
        .map_err(|e| format!("Error read: {}", e))?;

    let mut file = File::create(path).await
        .map_err(|e|format!("Cannot create file(): {}", e))?;
    file.write_all(&content).await
        .map_err(|e|format!("Cannot write data to file: {}", e))?;
    Ok(())
}

pub async fn install_java(java_manifest: MinecraftInstanceJavaVersion, launcher: &mut MinecraftInstance, tx: &mpsc::Sender<DownloadInfo>) -> Result<(), String> {
    if launcher.java.java_path == None {
        send_status_with_etaps(&tx, DownloadInfo { 
            total_etaps: 5, current_etaps: 1, total_files: 1, current_file: 0,
            etap: "Java".to_string(), status: InstallStatus::CHECK,
            filename: format!("java {}", java_manifest.majorVersion),
        }).await;
        //send_status_with_etaps(&tx, 0, 1, 5, 1,
        //    &format!("java {}", java_manifest.majorVersion), MinecraftInstallStatus::CHECK
        //).await;

        let alive_path = launcher.path.runtime.join(java_manifest.component.clone()).join("bin/javaw.exe");
        if alive_path.exists() {
            println!("Skip...");
            send_status_with_etaps(&tx, DownloadInfo { 
                total_etaps: 5, current_etaps: 1, total_files: 1, current_file: 0,
                etap: "Java".to_string(), status: InstallStatus::SKIP, filename: java_manifest.majorVersion.to_string()
            }).await;
            return Ok(());
        }

        send_status_with_etaps(&tx, DownloadInfo {
            total_etaps: 5, current_etaps: 1, total_files: 1, current_file: 0,
            etap: "Java".to_string(), status: InstallStatus::INSTALL,
            filename: format!("java {}", java_manifest.majorVersion),
        }).await;

        java::install_java(
            java_manifest.majorVersion.try_into().unwrap(),
            launcher.path.runtime.join(java_manifest.component)
        ).await?;

        send_status_with_etaps(&tx, DownloadInfo {
            total_etaps: 5, current_etaps: 1, total_files: 1, current_file: 1,
            etap: "Java".to_string(), status: InstallStatus::EXTRACT, filename: "java".to_string(),
        }).await;
    }else if !Path::new(&launcher.java.java_path.clone().unwrap()).exists() {
        return Err(format!("Java is not find! ```{}```",&launcher.java.java_path.clone().unwrap()))
    }
    Ok(())
}

pub async fn install_libraries(launch_option:MinecraftInstanceOption, path:PathBuf, tx:&mpsc::Sender<DownloadInfo>) -> Result<(), String> {
    let total_files = launch_option.libraries.len();
    for (current_file, library) in launch_option.libraries.iter().enumerate() {
        send_status_with_etaps(&tx, DownloadInfo { 
            total_etaps: 5, current_etaps: 2, total_files, current_file,
            etap: "Library".to_string(), status: InstallStatus::CHECK, filename: library.name.clone()
        }).await;

        let lib_path = path.join(library.path.clone());

        if lib_path.exists() {
            send_status_with_etaps(&tx, DownloadInfo { 
                total_etaps: 5, current_etaps: 2, total_files, current_file,
                etap: "Library".to_string(), status: InstallStatus::SKIP, filename: library.name.clone()
            }).await;
            continue; 
        }
        send_status_with_etaps(&tx, DownloadInfo { 
            total_etaps: 5, current_etaps: 2, total_files, current_file,
            etap: "Library".to_string(), status: InstallStatus::INSTALL, filename: library.name.clone()
        }).await;
        if let Err(why) = process_library(lib_path, library.url.clone()).await {
            return Err(why);
        };
    };
    Ok(())
}
pub async fn process_library(path:PathBuf, url:String) -> Result<(), String> {
    fs::create_dir_all(path.parent().ok_or(format!("Invalid path"))?)
        .await
        .map_err(|e| format!("Cannot create directory '{}': {}", path.display(), e))?;
    if let Err(why) = download(&url, path).await {
        return Err(format!("Library install error: {}", why).to_string());
    };
    Ok(())
}

pub async fn install_natives(launch_option:MinecraftInstanceOption, native_path:PathBuf, lib_path:PathBuf, tx:&mpsc::Sender<DownloadInfo>) -> Result<(), String> {
    let total_files = launch_option.natives.len();
    for (current_file,native) in launch_option.natives.iter().enumerate() {
        let n_path = lib_path.join(native.path.clone());

        send_status_with_etaps(&tx, DownloadInfo { 
            total_etaps: 5, current_etaps: 3, total_files, current_file,
            etap: "Native".to_string(), status: InstallStatus::CHECK, filename: native.name.clone()
        }).await;
        if !n_path.exists() {
            send_status_with_etaps(&tx, DownloadInfo { 
                total_etaps: 5, current_etaps: 3, total_files, current_file,
                etap: "Native".to_string(), status: InstallStatus::INSTALL, filename: native.name.clone()
            }).await;
            if let Err(why) = process_library(n_path.clone(), native.url.clone()).await {
                return Err(why);
            };
        }else{
            send_status_with_etaps(&tx, DownloadInfo { 
                total_etaps: 5, current_etaps: 3, total_files, current_file,
                etap: "Native".to_string(), status: InstallStatus::SKIP, filename: native.name.clone()
            }).await;
        };

        send_status_with_etaps(&tx, DownloadInfo { 
            total_etaps: 5, current_etaps: 3, total_files, current_file,
            etap: "Native".to_string(), status: InstallStatus::EXTRACT, filename: native.name.clone()
        }).await;
        let content = fs::read(n_path).await
            .map_err(|e|e.to_string())?;
        let _ = zip_extract::extract(Cursor::new(content), &native_path, false);
    };
    Ok(())
}
pub async fn install_assets(launch_option:MinecraftInstanceOption, path:PathBuf, tx:&mpsc::Sender<DownloadInfo>) -> Result<(), String> {
    let client = Client::new();
    let response = client.get(launch_option.asset_index.url)
        .send()
        .await
        .map_err(|e| format!("Error getting 'asset_index': {}", e))?;
    let asset_manifest: Value = response
        .json()
        .await
        .map_err(|e| format!("Error reading JSON: {}", e))?;

    if let Some(objects) = asset_manifest["objects"].as_object() {
        let objects = objects.clone();
        let count = objects.len();
        
        let path_assets_index = path.join("indexes");
        fs::create_dir_all(path_assets_index.clone())
            .await
            .map_err(|e|e.to_string()).unwrap();

        let filename = path_assets_index.join(format!("{}.json", launch_option.assets));
        let mut file = File::create(filename).await
            .map_err(|e|e.to_string())?;

        if let Err(e) = file.write_all(asset_manifest.to_string().as_bytes()).await {
            eprintln!("Error writing to file: {}", e);
        }

        for (current, (name, details)) in objects.iter().enumerate() {
            if let Err(e) = process_assets(name.to_string(), details.clone(), path.clone(), current, count, &tx).await {
                eprintln!("Error processing assets: {}", e);
            }
        }
        Ok(())
    }else{
        Err("why".to_owned())
    }
}

async fn process_assets(name:String, details: Value, path: PathBuf, current_file: usize, total_files: usize, tx:&mpsc::Sender<DownloadInfo>) -> Result<(), String> {
    let a_hash = details["hash"].as_str().unwrap();
    let a_subfolder = &a_hash[0..2];
    let a_url = format!("https://resources.download.minecraft.net/{}/{}", a_subfolder, a_hash);
    let a_file_path = format!("objects/{}/{}", a_subfolder, a_hash);

    send_status_with_etaps(&tx, DownloadInfo { 
        total_etaps: 5, current_etaps: 4, total_files, current_file,
        etap: "Assets".to_string(), status: InstallStatus::CHECK, filename: name.clone()
    }).await;
    //// File is alive? ////
    let a_path = Path::new(&path).join(a_file_path);
    if a_path.exists() {
        send_status_with_etaps(&tx, DownloadInfo { 
            total_etaps: 5, current_etaps: 4, total_files, current_file,
            etap: "Assets".to_string(), status: InstallStatus::SKIP, filename: name.clone()
        }).await;
        return Ok(());
    }
    //// Create dir and download file ////
    send_status_with_etaps(&tx, DownloadInfo { 
        total_etaps: 5, current_etaps: 4, total_files, current_file,
        etap: "Assets".to_string(), status: InstallStatus::INSTALL, filename: name
    }).await;
    fs::create_dir_all(a_path.parent().ok_or(format!("Invalid path"))?)
        .await
        .map_err(|e| format!("Cannot create directory '{}': {}", a_path.display(), e))?;
    if let Err(why) = download(&a_url, a_path).await {
        return Err(format!("Asset install error: {}", why).to_string());
    }
    Ok(())
}
pub async fn install_client(launch_option: MinecraftInstanceOption, path: PathBuf, tx: &mpsc::Sender<DownloadInfo>) -> Result<(), String> {
    process_client(launch_option.client.url.clone(), path.clone(), tx).await?;

    //// Other Clients ////
    for client in launch_option.other_client {
        let other_client_path = path.parent().unwrap().join(client.path.clone().unwrap());
        process_client(client.url, other_client_path, tx).await
            .map_err(|e| format!("Fail other client: {}", e))?;
    };
    Ok(())
}
pub async fn process_client(url: String, path: PathBuf, tx: &mpsc::Sender<DownloadInfo>) -> Result<(), String> {
    let filename = path.file_name().and_then(|n| n.to_str()).unwrap_or("client.jar").to_string();
    send_status_with_etaps(tx, DownloadInfo {
        total_etaps: 5, current_etaps: 5, total_files: 1, current_file: 0,
        etap: "Client".to_string(), status: InstallStatus::CHECK, filename: filename.clone(),
    }).await;
    if path.exists() {
        send_status_with_etaps(tx, DownloadInfo {
            total_etaps: 5, current_etaps: 5, total_files: 1, current_file: 1,
            etap: "Client".to_string(), status: InstallStatus::SKIP, filename: filename.clone(),
        }).await;
        return Ok(());
    }
    send_status_with_etaps(tx, DownloadInfo {
        total_etaps: 5, current_etaps: 5, total_files: 1, current_file: 0,
        etap: "Client".to_string(), status: InstallStatus::INSTALL, filename: filename.clone(),
    }).await;
    fs::create_dir_all(path.parent().ok_or("Invalid path".to_string())?)
        .await
        .map_err(|e| format!("Cannot create directory: {}", e))?;
    download(&url, path).await
        .map_err(|e| format!("Client install error: {}", e))?;
    Ok(())
}

/// Runs NeoForge's install processors (currently: applying the binary patch that turns the
/// vanilla client jar into the NeoForge-patched one) — only called when
/// `instance.version.core == MinecraftLoader::NEOFORGE`, and only *after* `install_client`
/// has run, since the processor's input is the vanilla jar it just downloaded.
///
/// Re-reads `install_profile.json` from the location `version::neoforge` already cached it
/// to (extracted from the installer jar during `get_launch_option`) instead of threading
/// that data through the install pipeline — keeps every step self-contained, same as the
/// rest of this file.
pub async fn run_neoforge_processors(
    instance: &MinecraftInstance,
    tx: &mpsc::Sender<DownloadInfo>,
) -> Result<(), String> {
    let neoforge_version = instance
        .version
        .loader
        .clone()
        .ok_or_else(|| "No NeoForge loader version selected".to_string())?;
    let paths = crate::library::version::neoforge::paths_for(instance, &neoforge_version);

    let profile: Value = serde_json::from_str(
        &fs::read_to_string(paths.install_dir.join("install_profile.json"))
            .await
            .map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;

    send_status_with_etaps(tx, DownloadInfo {
        total_etaps: 5, current_etaps: 5, total_files: 1, current_file: 0,
        etap: "Client".to_string(), status: InstallStatus::INSTALL,
        filename: "NeoForge patch".to_string(),
    }).await;

    // The processor tools' own dependencies — not part of the game's classpath, just what
    // the tools themselves need to run.
    if let Some(libs) = profile["libraries"].as_array() {
        for lib in libs {
            let path = lib["downloads"]["artifact"]["path"].as_str().unwrap_or("");
            let url = lib["downloads"]["artifact"]["url"].as_str().unwrap_or("");
            if path.is_empty() || url.is_empty() {
                continue;
            }
            let lib_path = instance.path.library.join(path);
            if lib_path.exists() {
                continue;
            }
            process_library(lib_path, url.to_string()).await?;
        }
    }

    let java_path = neoforge_processor_java_path(instance).await?;

    let no_processors = Vec::new();
    let processors = profile["processors"].as_array().unwrap_or(&no_processors);
    for processor in processors {
        // No "sides" field at all means it runs for both; if present, it must include "client".
        if let Some(sides) = processor["sides"].as_array() {
            let runs_on_client = sides.iter().any(|s| s.as_str() == Some("client"));
            if !runs_on_client {
                continue;
            }
        }

        let jar_coord = processor["jar"].as_str().unwrap_or("");
        let Some(tool_jar) = resolve_library_path(&profile, &instance.path.library, jar_coord) else {
            return Err(format!("NeoForge processor tool not found in libraries: {}", jar_coord));
        };

        // Not every processor tool is a self-contained fatjar (older NeoForge's
        // `installertools:2.1.2` isn't — it needs gson/asm/guava/etc. from
        // `processor.classpath` explicitly on `-cp`, or it dies with a bare
        // NoClassDefFoundError trying to load its own main class). Build the real
        // classpath from `classpath` instead of assuming `-jar <tool>` is enough.
        let classpath_coords: Vec<&str> = processor["classpath"]
            .as_array()
            .map(|arr| arr.iter().filter_map(|v| v.as_str()).collect())
            .unwrap_or_default();
        let mut classpath_entries = Vec::new();
        for coord in &classpath_coords {
            let Some(p) = resolve_library_path(&profile, &instance.path.library, coord) else {
                return Err(format!("NeoForge processor dependency not found in libraries: {}", coord));
            };
            classpath_entries.push(p);
        }
        if !classpath_entries.contains(&tool_jar) {
            classpath_entries.push(tool_jar.clone());
        }
        let classpath_sep = if cfg!(windows) { ";" } else { ":" };
        let classpath_str = classpath_entries
            .iter()
            .map(|p| p.display().to_string())
            .collect::<Vec<_>>()
            .join(classpath_sep);

        let main_class = read_manifest_main_class(&tool_jar).await?;

        let args: Vec<String> = processor["args"]
            .as_array()
            .map(|arr| arr.iter().filter_map(|v| v.as_str()).map(str::to_string).collect())
            .unwrap_or_default();
        let resolved_args: Vec<String> = args
            .iter()
            .map(|arg| resolve_neoforge_arg(arg, instance, &paths, &profile))
            .collect();

        println!("[minecraft] Running NeoForge processor: {} {:?}", main_class, resolved_args);

        let output = tokio::process::Command::new(&java_path)
            .arg("-cp")
            .arg(&classpath_str)
            .arg(&main_class)
            .args(&resolved_args)
            .output()
            .await
            .map_err(|e| format!("Failed to run NeoForge processor: {}", e))?;

        if !output.status.success() {
            return Err(format!(
                "NeoForge processor failed ({}):\n{}",
                main_class,
                String::from_utf8_lossy(&output.stderr)
            ));
        }
    }

    send_status_with_etaps(tx, DownloadInfo {
        total_etaps: 5, current_etaps: 5, total_files: 1, current_file: 1,
        etap: "Client".to_string(), status: InstallStatus::EXTRACT,
        filename: "NeoForge patch".to_string(),
    }).await;

    Ok(())
}

/// Finds a library entry by its maven coordinate (`processor.jar`/`.classpath` reference it
/// against `install_profile.json`'s own `libraries` list) and resolves it to where it was
/// downloaded — reusing the JSON-provided path instead of re-deriving one, so it can't
/// mismatch whatever `run_neoforge_processors`'s download loop actually wrote to disk.
fn resolve_library_path(profile: &Value, library_dir: &Path, coord: &str) -> Option<PathBuf> {
    profile["libraries"].as_array()?.iter()
        .find(|lib| lib["name"].as_str() == Some(coord))
        .and_then(|lib| lib["downloads"]["artifact"]["path"].as_str())
        .map(|p| library_dir.join(p))
}

/// Reads `Main-Class` out of a jar's `META-INF/MANIFEST.MF`. Needed because running a
/// processor via an explicit `-cp <full classpath>` (required when the tool isn't a
/// self-contained fatjar — see the classpath handling above) means Java no longer gets the
/// main class for free from `-jar`'s own manifest lookup, and different processor tools
/// (installertools, jarsplitter, AutoRenamingTool, binarypatcher) have different main
/// classes, so it can't be hardcoded.
async fn read_manifest_main_class(jar_path: &Path) -> Result<String, String> {
    let extract_dir = jar_path.with_file_name(format!(
        "{}_manifest",
        jar_path.file_stem().and_then(|s| s.to_str()).unwrap_or("tool")
    ));
    let manifest_path = extract_dir.join("META-INF/MANIFEST.MF");
    if !manifest_path.exists() {
        let content = fs::read(jar_path).await.map_err(|e| e.to_string())?;
        zip_extract::extract(Cursor::new(content), &extract_dir, false)
            .map_err(|e| format!("Cannot extract {}: {}", jar_path.display(), e))?;
    }
    let text = fs::read_to_string(&manifest_path)
        .await
        .map_err(|e| format!("Cannot read manifest of {}: {}", jar_path.display(), e))?;
    for line in text.lines() {
        if let Some(rest) = line.strip_prefix("Main-Class:") {
            return Ok(rest.trim().to_string());
        }
    }
    Err(format!("No Main-Class in manifest of {}", jar_path.display()))
}

fn resolve_neoforge_arg(
    arg: &str,
    instance: &MinecraftInstance,
    paths: &crate::library::version::neoforge::NeoForgePaths,
    profile: &Value,
) -> String {
    match arg {
        "{INSTALLER}" => paths.installer_jar.display().to_string(),
        "{ROOT}" => instance.path.game.display().to_string(),
        "{MINECRAFT_JAR}" => instance.get_jar_path().display().to_string(),
        "{MINECRAFT_VERSION}" => instance.version.id.clone(),
        // This pipeline only ever runs the client-relevant processors (see the `sides`
        // filter in `run_neoforge_processors`), so this is always "client".
        "{SIDE}" => "client".to_string(),
        // No special case for `{PATCHED}` — it resolves through the generic `data.KEY.client`
        // path below, straight to a real maven-layout path under the library dir (e.g.
        // `net/neoforged/neoforge/{version}/neoforge-{version}-client.jar`). That's not an
        // arbitrary choice: FML's own `NeoForgeClientLaunchHandler.getAdditionalMinecraftJarContent()`
        // independently resolves this exact coordinate via `LibraryFinder.findPathForMaven`
        // (driven by the `-DlibraryDirectory` system property this launcher already sets) to
        // assemble its "minecraft" module — together with `net.minecraft:client::srg` and
        // `::extra` (produced earlier in this same pipeline by jarsplitter/AutoRenamingTool).
        // FML finds and combines all three itself; none of them need to be added to `-cp`.
        _ => {
            // A generic `{KEY}` resolves against install_profile.json's own `data.KEY.client`.
            if let Some(key) = arg.strip_prefix('{').and_then(|s| s.strip_suffix('}')) {
                if let Some(value) = profile["data"][key]["client"].as_str() {
                    return resolve_neoforge_data_value(value, instance, paths);
                }
            }
            // Processor args can also embed a `[maven:coord@ext]` reference directly
            // (not only indirectly via a `{KEY}` -> data.KEY.client lookup) — e.g. MCP_DATA's
            // `--input [net.neoforged:neoform:...@zip]`. Left unresolved, the literal
            // bracketed string gets passed straight to the tool as a bogus file path.
            if arg.starts_with('[') && arg.ends_with(']') {
                return resolve_neoforge_data_value(arg, instance, paths);
            }
            arg.to_string()
        }
    }
}

/// `install_profile.json`'s `data` entries come in three shapes: `[maven:coordinate]`
/// (`group:artifact:version[:classifier][@extension]` — resolved under the shared library
/// dir), `/path/inside/installer.jar` (already extracted alongside `install_profile.json`
/// itself), or a quoted literal string. These are all *intermediate* artifacts produced and
/// consumed between processor steps (the final patched-client output is handled separately,
/// by key, in `resolve_neoforge_arg` above) — as long as a coordinate resolves to the same
/// path every time it's referenced, the exact layout doesn't need to match any real maven
/// repo convention.
fn resolve_neoforge_data_value(
    value: &str,
    instance: &MinecraftInstance,
    paths: &crate::library::version::neoforge::NeoForgePaths,
) -> String {
    if let Some(coord) = value.strip_prefix('[').and_then(|v| v.strip_suffix(']')) {
        let (coord, extension) = match coord.split_once('@') {
            Some((c, ext)) => (c, ext),
            None => (coord, "jar"),
        };
        let parts: Vec<&str> = coord.split(':').collect();
        if parts.len() >= 3 {
            let (group, artifact, version) = (parts[0], parts[1], parts[2]);
            let classifier = parts.get(3);
            let filename = match classifier {
                Some(c) => format!("{}-{}-{}.{}", artifact, version, c, extension),
                None => format!("{}-{}.{}", artifact, version, extension),
            };
            return instance
                .path
                .library
                .join(group.replace('.', "/"))
                .join(artifact)
                .join(version)
                .join(filename)
                .display()
                .to_string();
        }
        return coord.to_string();
    }

    if let Some(rel) = value.strip_prefix('/') {
        return paths.install_dir.join(rel).display().to_string();
    }

    value.trim_matches('\'').to_string()
}

async fn neoforge_processor_java_path(instance: &MinecraftInstance) -> Result<String, String> {
    if let Some(p) = &instance.java.java_path {
        return Ok(p.clone());
    }
    // The install pipeline always saves `launch.nihao` right after generating it and before
    // any install::install_* step runs (see `MinecraftInstance::install_stream`), so by the
    // time this runs (after install_client) it's guaranteed to already be on disk.
    let version_dir = instance.path.versions.join(instance.version.filename());
    let launch_option = MinecraftInstanceOption::load_is_version_async(version_dir)
        .await
        .map_err(|e| format!("Cannot resolve Java runtime for NeoForge processors: {}", e))?;
    Ok(instance
        .path
        .runtime
        .join(&launch_option.java_version.component)
        .join("bin/java.exe")
        .display()
        .to_string())
}
