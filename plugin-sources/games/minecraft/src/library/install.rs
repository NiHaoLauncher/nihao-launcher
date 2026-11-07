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
    CHECK, SKIP, INSTALL, EXTRACT
}
impl InstallStatus {
    pub fn to_string(&self) -> String {
        match self {
            Self::CHECK => "check".to_string(),
            Self::SKIP => "skip".to_string(),
            Self::INSTALL => "install".to_string(),
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
/// One client for every download: reuses connections instead of a new TLS handshake per file.
pub(super) static HTTP: std::sync::LazyLock<Client> = std::sync::LazyLock::new(|| {
    Client::builder()
        .user_agent(concat!("NiHao/minecraft-plugin/", env!("CARGO_PKG_VERSION"))) // Modrinth asks for an identifying one
        .connect_timeout(STALL_TIMEOUT)
        .build()
        .unwrap_or_default()
});

/// A download that makes no progress for this long fails instead of hanging the install (reqwest
/// 0.11 has no per-read timeout, and a total timeout would cut off big files like the JDK).
const STALL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

pub async fn download(url:&str, path:PathBuf) -> Result<(),String> {
    download_checked(url, path, "").await
}

/// Maven repos publish `<file>.sha1` next to every artifact: fetch it and verify the download.
pub async fn download_maven(url:&str, path:PathBuf) -> Result<(),String> {
    let sha1 = HTTP.get(format!("{url}.sha1")).send().await
        .and_then(|r| r.error_for_status())
        .map_err(|e| format!("Cannot get checksum of '{}': {}", url, e))?
        .text().await
        .map_err(|e| format!("Cannot get checksum of '{}': {}", url, e))?;
    download_checked(url, path, sha1.split_whitespace().next().unwrap_or("")).await
}

/// Streams `url` to `path` (via `path.part`, renamed on success). Fails, leaving nothing at `path`,
/// when the bytes' hash differs from `expected`: lowercase/uppercase hex, SHA-1 (40 chars) or
/// SHA-256 (64 chars). An empty `expected` skips the check (some manifests don't carry one).
pub async fn download_checked(url:&str, path:PathBuf, expected:&str) -> Result<(),String> {
    download_checked_with(url, path, expected, &[]).await
}

/// `download_checked` sending `headers` too (e.g. an API key the host requires).
pub async fn download_checked_with(url:&str, path:PathBuf, expected:&str, headers:&[(&str, String)]) -> Result<(),String> {
    use futures_util::StreamExt;
    use sha1::{Digest as _, Sha1};
    use sha2::Sha256;

    enum Hasher { Skip, Sha1(Sha1), Sha256(Sha256) }
    let mut hasher = match expected.len() {
        0 => Hasher::Skip,
        40 => Hasher::Sha1(Sha1::new()),
        64 => Hasher::Sha256(Sha256::new()),
        _ => return Err(format!("Unsupported checksum for '{}': '{}'", url, expected)),
    };

    let stalled = |what: &str| format!("Error install '{}': {} stalled for {}s", url, what, STALL_TIMEOUT.as_secs());
    let request = headers.iter().fold(HTTP.get(url), |request, (name, value)| request.header(*name, value));
    let response = tokio::time::timeout(STALL_TIMEOUT, request.send()).await
        .map_err(|_| stalled("server"))?
        .map_err(|e|format!("Error install '{}' library: {}", url, e))?
        .error_for_status()
        .map_err(|e|format!("Error install '{}' library: {}", url, e))?;

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).await.map_err(|e| format!("Cannot create '{}': {}", parent.display(), e))?;
    }
    let mut part_name = path.as_os_str().to_owned();
    part_name.push(".part");
    let part = PathBuf::from(part_name);
    let mut file = File::create(&part).await
        .map_err(|e|format!("Cannot create file(): {}", e))?;
    let mut stream = response.bytes_stream();
    while let Some(chunk) = tokio::time::timeout(STALL_TIMEOUT, stream.next()).await.map_err(|_| stalled("download"))? {
        let chunk = chunk.map_err(|e| format!("Error read: {}", e))?;
        match &mut hasher {
            Hasher::Skip => {}
            Hasher::Sha1(h) => h.update(&chunk),
            Hasher::Sha256(h) => h.update(&chunk),
        }
        file.write_all(&chunk).await
            .map_err(|e|format!("Cannot write data to file: {}", e))?;
    }
    file.flush().await.map_err(|e|format!("Cannot write data to file: {}", e))?;
    drop(file);
    let actual = match hasher {
        Hasher::Skip => expected.to_string(),
        Hasher::Sha1(h) => format!("{:x}", h.finalize()),
        Hasher::Sha256(h) => format!("{:x}", h.finalize()),
    };
    if actual != expected.to_lowercase() {
        let _ = fs::remove_file(&part).await;
        return Err(format!("Checksum mismatch for '{}'", url));
    }
    fs::rename(&part, &path).await
        .map_err(|e|format!("Cannot write '{}': {}", path.display(), e))
}

pub async fn install_java(java_manifest: MinecraftInstanceJavaVersion, launcher: &mut MinecraftInstance, tx: &mpsc::Sender<DownloadInfo>) -> Result<(), String> {
    if launcher.java.java_path == None {
        send_status_with_etaps(&tx, DownloadInfo { 
            total_etaps: 5, current_etaps: 1, total_files: 1, current_file: 0,
            etap: "Java".to_string(), status: InstallStatus::CHECK,
            filename: format!("java {}", java_manifest.majorVersion),
        }).await;

        let alive_path = launcher.path.runtime.join(java_manifest.component.clone()).join(crate::platforms::GAME_JAVA);
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
        if let Err(why) = process_library(lib_path, library.url.clone(), &library.sha1).await {
            return Err(why);
        };
    };
    Ok(())
}
pub async fn process_library(path:PathBuf, url:String, sha1:&str) -> Result<(), String> {
    fs::create_dir_all(path.parent().ok_or(format!("Invalid path"))?)
        .await
        .map_err(|e| format!("Cannot create directory '{}': {}", path.display(), e))?;
    // A library the loader's metadata gave no checksum for (Fabric's own jar) is checked against the
    // .sha1 its maven repository publishes next to it, never taken unchecked.
    let downloaded = if sha1.is_empty() { download_maven(&url, path).await } else { download_checked(&url, path, sha1).await };
    downloaded.map_err(|why| format!("Library install error: {}", why))
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
            if let Err(why) = process_library(n_path.clone(), native.url.clone(), &native.sha1).await {
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
        zip_extract::extract(Cursor::new(content), &native_path, false)
            .map_err(|e| format!("Cannot extract native '{}': {}", native.name, e))?;
    };
    Ok(())
}
pub async fn install_assets(launch_option:MinecraftInstanceOption, path:PathBuf, tx:&mpsc::Sender<DownloadInfo>) -> Result<(), String> {
    let response = HTTP.get(launch_option.asset_index.url)
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
            .map_err(|e|e.to_string())?;

        let filename = path_assets_index.join(format!("{}.json", launch_option.assets));
        let mut file = File::create(filename).await
            .map_err(|e|e.to_string())?;

        if let Err(e) = file.write_all(asset_manifest.to_string().as_bytes()).await {
            eprintln!("Error writing to file: {}", e);
        }

        // Parallel: there are thousands of tiny files, one at a time takes minutes.
        use futures_util::StreamExt;
        let results: Vec<Result<(), String>> = futures_util::stream::iter(objects.into_iter().enumerate())
            .map(|(current, (name, details))| {
                let (path, tx) = (path.clone(), tx.clone());
                async move { process_assets(name, details, path, current, count, &tx).await }
            })
            .buffer_unordered(16)
            .collect()
            .await;
        let failed = results.iter().filter(|r| r.is_err()).count();
        if let Some(Err(e)) = results.into_iter().find(|r| r.is_err()) {
            return Err(format!("{failed} asset(s) failed, first error: {e}"));
        }
        Ok(())
    }else{
        Err("Asset index has no 'objects'".to_owned())
    }
}

async fn process_assets(name:String, details: Value, path: PathBuf, current_file: usize, total_files: usize, tx:&mpsc::Sender<DownloadInfo>) -> Result<(), String> {
    let a_hash = details["hash"].as_str().ok_or("Asset entry has no hash")?;
    let a_subfolder = a_hash.get(0..2).ok_or("Asset hash is too short")?;
    let a_url = format!("https://resources.download.minecraft.net/{}/{}", a_subfolder, a_hash);
    let a_file_path = format!("objects/{}/{}", a_subfolder, a_hash);

    send_status_with_etaps(&tx, DownloadInfo { 
        total_etaps: 5, current_etaps: 4, total_files, current_file,
        etap: "Assets".to_string(), status: InstallStatus::CHECK, filename: name.clone()
    }).await;
    let a_path = Path::new(&path).join(a_file_path);
    if a_path.exists() {
        send_status_with_etaps(&tx, DownloadInfo { 
            total_etaps: 5, current_etaps: 4, total_files, current_file,
            etap: "Assets".to_string(), status: InstallStatus::SKIP, filename: name.clone()
        }).await;
        return Ok(());
    }
    send_status_with_etaps(&tx, DownloadInfo { 
        total_etaps: 5, current_etaps: 4, total_files, current_file,
        etap: "Assets".to_string(), status: InstallStatus::INSTALL, filename: name
    }).await;
    fs::create_dir_all(a_path.parent().ok_or(format!("Invalid path"))?)
        .await
        .map_err(|e| format!("Cannot create directory '{}': {}", a_path.display(), e))?;
    if let Err(why) = download_checked(&a_url, a_path, a_hash).await {
        return Err(format!("Asset install error: {}", why).to_string());
    }
    Ok(())
}
pub async fn install_client(launch_option: MinecraftInstanceOption, path: PathBuf, tx: &mpsc::Sender<DownloadInfo>) -> Result<(), String> {
    process_client(launch_option.client.url.clone(), path.clone(), &launch_option.client.sha1, tx).await?;

    for client in launch_option.other_client {
        let other_client_path = path.parent().unwrap().join(client.path.clone().unwrap());
        process_client(client.url, other_client_path, &client.sha1, tx).await
            .map_err(|e| format!("Fail other client: {}", e))?;
    };
    Ok(())
}
pub async fn process_client(url: String, path: PathBuf, sha1: &str, tx: &mpsc::Sender<DownloadInfo>) -> Result<(), String> {
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
    download_checked(&url, path, sha1).await
        .map_err(|e| format!("Client install error: {}", e))?;
    Ok(())
}

/// Runs NeoForge's install processors (currently the binary patch that turns the vanilla client jar
/// into the NeoForge-patched one). Only for `MinecraftLoader::NEOFORGE`, and only after
/// `install_client`, whose vanilla jar is the processor's input. Re-reads `install_profile.json`
/// from where `version::neoforge` cached it during `get_launch_option` instead of threading it
/// through the pipeline.
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
            let sha1 = lib["downloads"]["artifact"]["sha1"].as_str().unwrap_or("");
            process_library(lib_path, url.to_string(), sha1).await?;
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
        // `installertools:2.1.2` needs gson/asm/guava from `processor.classpath` on `-cp`, or it
        // dies with NoClassDefFoundError), so build the real classpath instead of assuming `-jar
        // <tool>` suffices.
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
        let classpath_sep = crate::platforms::CLASSPATH_SEPARATOR;
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

/// Finds a library by maven coordinate in `install_profile.json`'s `libraries` and resolves it to
/// where it was downloaded, reusing the JSON-provided path so it can't mismatch what
/// `run_neoforge_processors` wrote.
fn resolve_library_path(profile: &Value, library_dir: &Path, coord: &str) -> Option<PathBuf> {
    profile["libraries"].as_array()?.iter()
        .find(|lib| lib["name"].as_str() == Some(coord))
        .and_then(|lib| lib["downloads"]["artifact"]["path"].as_str())
        .map(|p| library_dir.join(p))
}

/// Reads `Main-Class` from a jar's `META-INF/MANIFEST.MF`. Needed because a processor runs via
/// explicit `-cp` (when it isn't a fatjar), so Java no longer gets the main class from `-jar`, and
/// the tools (installertools, jarsplitter, AutoRenamingTool, binarypatcher) differ.
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
        // No special case for `{PATCHED}`: it resolves through the generic `data.KEY.client` path
        // to a maven-layout path under the library dir (e.g.
        // `net/neoforged/neoforge/{version}/neoforge-{version}-client.jar`). FML's
        // `NeoForgeClientLaunchHandler` independently resolves that same coordinate via
        // `LibraryFinder.findPathForMaven` (driven by `-DlibraryDirectory`) and combines it with
        // `net.minecraft:client::srg`/`::extra` itself; none of them go on `-cp`.
        _ => {
            // A generic `{KEY}` resolves against install_profile.json's own `data.KEY.client`.
            if let Some(key) = arg.strip_prefix('{').and_then(|s| s.strip_suffix('}')) {
                if let Some(value) = profile["data"][key]["client"].as_str() {
                    return resolve_neoforge_data_value(value, instance, paths);
                }
            }
            // Processor args can embed a `[maven:coord@ext]` reference directly (e.g. MCP_DATA's
            // `--input [net.neoforged:neoform:...@zip]`); unresolved, the literal string would be
            // passed to the tool as a bogus path.
            if arg.starts_with('[') && arg.ends_with(']') {
                return resolve_neoforge_data_value(arg, instance, paths);
            }
            arg.to_string()
        }
    }
}

/// `install_profile.json` `data` entries are `[maven:coordinate]`
/// (`group:artifact:version[:classifier][@extension]`, resolved under the shared library dir),
/// `/path/inside/installer.jar` (already extracted next to `install_profile.json`) or a quoted
/// literal. They are intermediate artifacts between processor steps (the final patched client is
/// handled by key in `resolve_neoforge_arg`), so the layout only needs to be stable per coordinate.
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
    // `launch.nihao` is always saved right after generation and before any `install::install_*`
    // step (see `install_stream`), so it is on disk by the time this runs.
    let version_dir = instance.path.versions.join(instance.version.filename());
    let launch_option = MinecraftInstanceOption::load_is_version_async(version_dir)
        .await
        .map_err(|e| format!("Cannot resolve Java runtime for NeoForge processors: {}", e))?;
    Ok(instance
        .path
        .runtime
        .join(&launch_option.java_version.component)
        .join(crate::platforms::TOOL_JAVA)
        .display()
        .to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::AsyncReadExt;
    use tokio::net::TcpListener;

    async fn serve_once(status: &'static str, body: &'static str) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/f", listener.local_addr().unwrap());
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut buf = [0u8; 1024];
            let _ = socket.read(&mut buf).await;
            let reply = format!("HTTP/1.1 {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", status, body.len(), body);
            let _ = socket.write_all(reply.as_bytes()).await;
        });
        url
    }

    const HELLO_SHA1: &str = "aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d";
    const HELLO_SHA256: &str = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";

    #[tokio::test]
    async fn download_keeps_only_verified_files() {
        let dir = std::env::temp_dir().join(format!("nihao-dl-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();

        let bad_hash = dir.join("bad_hash");
        assert!(download_checked(&serve_once("200 OK", "hello").await, bad_hash.clone(), "00").await.is_err());
        assert!(!bad_hash.exists() && !dir.join("bad_hash.part").exists());

        let not_found = dir.join("not_found");
        assert!(download_checked(&serve_once("404 Not Found", "nope").await, not_found.clone(), "").await.is_err());
        assert!(!not_found.exists());

        let good = dir.join("good");
        download_checked(&serve_once("200 OK", "hello").await, good.clone(), HELLO_SHA1).await.unwrap();
        assert_eq!(std::fs::read_to_string(&good).unwrap(), "hello");

        let sha256 = dir.join("sha256");
        download_checked(&serve_once("200 OK", "hello").await, sha256.clone(), HELLO_SHA256).await.unwrap();
        let wrong_sha256 = dir.join("wrong_sha256");
        assert!(download_checked(&serve_once("200 OK", "hello").await, wrong_sha256.clone(), &"0".repeat(64)).await.is_err());
        assert!(!wrong_sha256.exists());

        // Its folder doesn't exist yet (NeoForge's installer goes into one that is new per version).
        let nested = dir.join("not/yet/there/file");
        download_checked(&serve_once("200 OK", "hello").await, nested.clone(), HELLO_SHA1).await.unwrap();
        assert_eq!(std::fs::read_to_string(&nested).unwrap(), "hello");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
