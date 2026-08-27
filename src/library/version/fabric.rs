use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;


#[derive(Deserialize, Serialize, Clone)]
pub struct FabricVersion {
    pub maven: Option<String>,
    pub version: String,
    pub stable: bool,
}
#[derive(Deserialize, Serialize, Clone)]
pub struct FabricLoader {
    pub build: u64,
    pub maven: String,
    pub version: String,
    pub stable: bool,
}
#[derive(Deserialize, Serialize, Clone)]
pub struct FabricVersionLoader {
    pub loader: FabricLoader,
    pub intermediary: FabricVersion,
    pub launcherMeta: FabricLauncherMeta
}
#[derive(Deserialize, Serialize, Clone)]
pub struct FabricLauncherMeta {
    pub version: u64,
    pub min_java_version: Option<u64>,
    pub libraries: Value,
    pub mainClass: Value,
}
#[derive(Deserialize, Clone)]
pub struct FabricLocalManifest {
    pub mainClass: String,
    pub libraries: Value,
}

pub async fn get_manifest_async() -> Result<Vec<FabricVersion>, String> {
    let url = "https://meta.fabricmc.net/v2/versions/game";
    let client = Client::new();
    let response = client.get(url)
        .send()
        .await
        .map_err(|e| format!("Error getting 'version_manifest.json': {}", e))?;

    let manifest: Vec<FabricVersion> = response
        .json()
        .await
        .map_err(|e| format!("Error reading JSON: {}", e))?;

    Ok(manifest)
}
pub async fn get_loaders_async() -> Result<Vec<FabricLoader>, String> {
    let url = "https://meta.fabricmc.net/v2/versions/loader";
    let client = Client::new();
    let response = client.get(url)
        .send()
        .await
        .map_err(|e| format!("Error getting 'version_manifest.json': {}", e))?;

    let manifest: Vec<FabricLoader> = response
        .json()
        .await
        .map_err(|e| format!("Error reading JSON: {}", e))?;

    Ok(manifest)
}
pub async fn get_loader_with_id_async(id:String, loader:String) -> Result<FabricVersionLoader, String> {
    let url = format!("https://meta.fabricmc.net/v2/versions/loader/{}/{}",id.replace(" ", "%"),loader);
    let client = Client::new(); 
    let response = client.get(url)
        .send()
        .await
        .map_err(|e| format!("Error getting 'version_manifest.json': {}", e.to_string()))?;

    let manifest: FabricVersionLoader = response
        .json()
        .await
        .map_err(|e| format!("Error reading JSON: {}", e.to_string()))?;

    Ok(manifest)
}
pub async fn get_version_loaders_async(id:String) -> Result<Vec<FabricVersionLoader>, String> {
    let url = format!("https://meta.fabricmc.net/v2/versions/loader/{}",id.replace(" ", "%"));
    let client = Client::new(); 
    let response = client.get(url)
        .send()
        .await
        .map_err(|e| format!("Error getting 'version_manifest.json': {}", e.to_string()))?;

    let manifest: Vec<FabricVersionLoader> = response
        .json()
        .await
        .map_err(|e| format!("Error reading JSON: {}", e.to_string()))?;

    Ok(manifest)
}

/// Converts a Maven coordinate (`group:artifact:version`) into a downloadable library
/// entry, resolving `path`/`url` the same way for the loader jar and its dependencies.
fn maven_coord_to_library(name: &str, base_url: &str, resource: &str) -> Option<crate::library::version::MinecraftInstanceDownload> {
    let parts: Vec<&str> = name.splitn(3, ':').collect();
    if parts.len() != 3 {
        return None;
    }
    let path = format!("{}/{}/{}/{}-{}.jar",
        parts[0].replace('.', "/"), parts[1], parts[2], parts[1], parts[2]);
    Some(crate::library::version::MinecraftInstanceDownload {
        name: name.to_string(),
        url: format!("{}{}", base_url, path),
        path,
        sha1: String::new(),
        resource: resource.to_string(),
    })
}

pub async fn get_launch_option(instance: &mut crate::library::MinecraftInstance) -> Result<crate::library::version::MinecraftInstanceOption, String> {
    // Для Fabric — беремо базову vanilla опцію, і потім мержимо бібліотеки Fabric
    let mut option = crate::library::version::vanilla::get_launch_option(instance).await?;

    // Завантажуємо Fabric loader для отримання його бібліотек та mainClass
    let loader_version = instance.version.loader.clone().unwrap_or_else(|| "0.15.0".to_string());
    let fabric_meta = get_loader_with_id_async(instance.version.id.clone(), loader_version).await
        .map_err(|e| format!("Cannot load Fabric meta: {}", e))?;

    // Перевизначаємо mainClass на Fabric — API повертає його як об'єкт {"client": ..., "server": ...},
    // а не рядок, тому пряме .as_str() тут завжди дає None (і mainClass мовчки лишався vanilla-івським).
    if let Some(main_class) = fabric_meta.launcherMeta.mainClass["client"].as_str() {
        option.main_class = main_class.to_string();
    }

    // The loader's own jar isn't listed among its "common" dependencies below — but that's
    // exactly where the Knot launch classes (mainClass, above) live, so without adding it
    // explicitly the JVM fails with "Could not find or load main class ...KnotClient".
    if let Some(lib) = maven_coord_to_library(&fabric_meta.loader.maven, "https://maven.fabricmc.net/", "fabric-loader") {
        option.libraries.push(lib);
    }

    // Додаємо бібліотеки Fabric
    if let Some(libs) = fabric_meta.launcherMeta.libraries["common"].as_array() {
        for lib in libs {
            let name = lib["name"].as_str().unwrap_or("");
            let url = lib["url"].as_str().unwrap_or("https://maven.fabricmc.net/");
            if let Some(lib) = maven_coord_to_library(name, url, "fabric-library") {
                option.libraries.push(lib);
            }
        }
    }

    Ok(option)
}
