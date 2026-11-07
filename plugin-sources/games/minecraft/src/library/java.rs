use std::{env, io::Cursor, path::PathBuf};
use reqwest::Client;
use serde_json::Value;
use tokio::fs;

#[derive(Clone)]
pub struct JavaOption {
    pub java_path: Option<String>,
}

/// Downloads and unpacks a JDK for `java_version` into `path`. No granular progress —
/// callers only get a start/done signal via the outer `install::install_java` wrapper.
pub async fn install_java(java_version: usize, path: PathBuf) -> Result<(), String> {
    println!("Install Java {} to: {}", java_version, path.display());

    let url = format!("https://api.adoptium.net/v3/assets/latest/{v}/hotspot?architecture={arch}&image_type=jdk&os={os}",
        v = java_version,
        arch = std::env::consts::ARCH,
        os = env::consts::OS,
    );

    let client = Client::new();
    let response = client.get(url)
        .send()
        .await
        .map_err(|e| format!("Error getting 'java:{v};arch:{arch};os:{os}': {e}",
            v=java_version, arch=std::env::consts::ARCH, os=env::consts::OS, e=e))?;

    let manifest: Value = response
        .json()
        .await
        .map_err(|e| format!("Error reading JSON: {}", e))?;

    let p_url = manifest[0]["binary"]["package"]["link"].as_str()
        .ok_or_else(|| "Not find package/link".to_string())?;
    let java_cache_path = path.parent().unwrap().join(".jre.cache");

    // Adoptium publishes the archive's SHA-256 in the same answer.
    let checksum = manifest[0]["binary"]["package"]["checksum"].as_str().unwrap_or("");
    crate::library::install::download_checked(p_url, java_cache_path.clone(), checksum).await?;

    let content = fs::read(&java_cache_path).await
        .map_err(|e| e.to_string())?;
    zip_extract::extract(Cursor::new(content), path.parent().unwrap(), false)
        .map_err(|e| e.to_string())?;

    let release_name = manifest[0]["release_name"].as_str()
        .ok_or_else(|| "Not find release_name".to_string())?;
    let install_folder = path.parent().unwrap().join(release_name);

    if install_folder.exists() {
        // A stale destination from an interrupted install would make the rename fail (Windows
        // won't rename onto an existing directory), so clear it first.
        if path.exists() {
            let _ = fs::remove_dir_all(&path).await;
        }
        rename_with_retry(&install_folder, &path).await?;
    } else {
        // Without this the install would report success with no Java on disk.
        return Err(format!("Java folder '{}' not found after unpacking", release_name));
    }
    let _ = fs::remove_file(&java_cache_path).await;
    Ok(())
}

/// Windows Defender (and similar real-time AV) briefly locks freshly-extracted `.exe`/`.dll`
/// files while scanning them, which makes an immediate `rename()` of the just-unpacked JDK
/// folder fail with "Access is denied" even though extraction itself fully succeeded. The
/// lock is transient, so retry with backoff instead of surfacing a spurious failure.
async fn rename_with_retry(from: &std::path::Path, to: &std::path::Path) -> Result<(), String> {
    const DELAYS_MS: [u64; 5] = [200, 500, 1000, 2000, 3000];

    let mut last_err = None;
    for delay in DELAYS_MS {
        match fs::rename(from, to).await {
            Ok(()) => return Ok(()),
            Err(e) => {
                last_err = Some(e);
                tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
            }
        }
    }

    fs::rename(from, to).await.map_err(|_| {
        format!(
            "Cannot move '{}' to '{}': {}",
            from.display(), to.display(),
            last_err.map(|e| e.to_string()).unwrap_or_default()
        )
    })
}
