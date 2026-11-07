use reqwest::Client;
use serde::Deserialize;
use serde_json::Value;
use tokio::fs;

use crate::library::MinecraftInstance;

#[derive(Deserialize, Debug)]
pub struct Version {
    pub id: String,
    pub r#type: String,
    pub url: String,
}

#[derive(Deserialize, Debug)]
pub struct VersionManifest {
    pub versions: Vec<Version>,
}
pub async fn get_manifest_async() -> Result<VersionManifest, String> {
    let url = "https://launchermeta.mojang.com/mc/game/version_manifest.json";
    let client = Client::new();
    let response = client.get(url)
        .send()
        .await
        .map_err(|e| format!("Error getting 'version_manifest.json': {}", e))?;

    let manifest: VersionManifest = response
        .json()
        .await
        .map_err(|e| format!("Error reading JSON: {}", e))?;

    Ok(manifest)
}
pub async fn get_version_manifest_async(version: &str) -> Result<Value, String> {
    if let Ok(manifest) = get_manifest_async().await {
        if let Some(data) = manifest.versions.iter().find(|v| v.id == version) {
            let response: Value = reqwest::get(&data.url)
                .await
                .map_err(|e| format!("Error getting url with 'version_manifest.json': {}", e))?
                .json()
                .await
                .map_err(|e| format!("Error reading JSON: {}", e))?;
            return Ok(response);
        } else {
            return Err(format!("Version '{}' not found in the manifest", version));
        }
    } else {
        Err("Cannot get 'version_manifest.json'".to_owned())
    }
}
pub async fn get_local_manifest_async(launcher: &MinecraftInstance) -> Result<Value, String> {
    match launcher.get_jar_manifest_path().exists() {
        true => {
            let file_manifest = fs::read_to_string(launcher.get_jar_manifest_path()).await
                .map_err(|e|e.to_string())?;
            let result = serde_json::from_str(&file_manifest)
                .map_err(|e|e.to_string())?;
            Ok(result)
        },
        false => {
            get_version_manifest_async(&launcher.version.id).await
        },
    }
}

pub async fn get_launch_option(instance: &mut MinecraftInstance) -> Result<crate::library::version::MinecraftInstanceOption, String> {
    let manifest = get_local_manifest_async(instance).await?;
    parse_launch_option(manifest, instance)
}

fn parse_launch_option(manifest: Value, instance: &MinecraftInstance) -> Result<crate::library::version::MinecraftInstanceOption, String> {
    use crate::library::version::*;

    let main_class = manifest["mainClass"].as_str().ok_or("Missing mainClass")?.to_string();
    let assets     = manifest["assets"].as_str().unwrap_or("legacy").to_string();
    let r#type     = manifest["type"].as_str().unwrap_or("release").to_string();

    let java_version_component = manifest["javaVersion"]["component"].as_str().unwrap_or("jre-legacy").to_string();
    let java_major             = manifest["javaVersion"]["majorVersion"].as_u64().unwrap_or(8);

    let asset_index_url  = manifest["assetIndex"]["url"].as_str().unwrap_or("").to_string();
    let asset_index_sha1 = manifest["assetIndex"]["sha1"].as_str().unwrap_or("").to_string();
    let client_url       = manifest["downloads"]["client"]["url"].as_str().unwrap_or("").to_string();
    let client_sha1      = manifest["downloads"]["client"]["sha1"].as_str().unwrap_or("").to_string();
    let jar_path         = instance.get_jar_path().display().to_string();

    let mut libraries: Vec<MinecraftInstanceDownload> = Vec::new();
    let mut natives:   Vec<MinecraftInstanceDownload> = Vec::new();

    if let Some(libs) = manifest["libraries"].as_array() {
        for lib in libs {
            let name = lib["name"].as_str().unwrap_or("").to_string();

            if let Some(artifact) = lib["downloads"]["artifact"].as_object() {
                libraries.push(MinecraftInstanceDownload {
                    name: name.clone(),
                    path:     artifact.get("path").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                    sha1:     artifact.get("sha1").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                    url:      artifact.get("url").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                    resource: "library".to_string(),
                });
            }

            if let Some(native) = lib["downloads"]["classifiers"][crate::platforms::NATIVES_CLASSIFIER].as_object() {
                natives.push(MinecraftInstanceDownload {
                    name:     name.clone(),
                    path:     native.get("path").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                    sha1:     native.get("sha1").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                    url:      native.get("url").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                    resource: "native".to_string(),
                });
            }
        }
    }

    let arguments = if let Some(args) = manifest["arguments"].as_object() {
        let game: Vec<String> = args.get("game")
            .and_then(|v| v.as_array())
            .map(|arr| arr.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect())
            .unwrap_or_default();
        let jvm: Vec<String> = args.get("jvm")
            .and_then(|v| v.as_array())
            .map(|arr| arr.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect())
            .unwrap_or_default();
        Some(MinecraftArguments { game, jvm })
    } else if let Some(legacy) = manifest["minecraftArguments"].as_str() {
        let game = legacy.split_whitespace().map(|s| s.to_string()).collect();
        Some(MinecraftArguments { game, jvm: Vec::new() })
    } else {
        None
    };

    Ok(MinecraftInstanceOption {
        arguments,
        r#type,
        main_class,
        java_version: MinecraftInstanceJavaVersion { component: java_version_component, majorVersion: java_major },
        assets,
        asset_index: MinecraftInstanceDownloadCompact { url: asset_index_url, sha1: asset_index_sha1, path: None },
        libraries,
        natives,
        client: MinecraftInstanceDownloadCompact { url: client_url, sha1: client_sha1, path: Some(jar_path) },
        other_client: Vec::new(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::library::path::MinecraftPath;

    /// The parts of a Mojang version json that `parse_launch_option` reads.
    fn manifest() -> Value {
        serde_json::json!({
            "id": "1.21.1",
            "mainClass": "net.minecraft.client.main.Main",
            "type": "release",
            "assets": "17",
            "assetIndex": { "url": "https://x/17.json", "sha1": "aa" },
            "javaVersion": { "component": "java-runtime-delta", "majorVersion": 21 },
            "downloads": { "client": { "url": "https://x/client.jar", "sha1": "bb" } },
            "arguments": { "game": ["--username", "${auth_player_name}", { "rules": [], "value": "--demo" }], "jvm": ["-Xss1M"] },
            "libraries": [
                { "name": "com.google.code.gson:gson:2.10", "downloads": { "artifact": { "path": "com/google/code/gson/gson-2.10.jar", "sha1": "cc", "url": "https://x/gson.jar" } } },
                { "name": "org.lwjgl:lwjgl:3.3", "downloads": {
                    "artifact": { "path": "org/lwjgl/lwjgl-3.3.jar", "sha1": "dd", "url": "https://x/lwjgl.jar" },
                    "classifiers": {
                        "natives-windows": { "path": "org/lwjgl/lwjgl-3.3-natives-windows.jar", "sha1": "ee", "url": "https://x/w.jar" },
                        "natives-linux": { "path": "org/lwjgl/lwjgl-3.3-natives-linux.jar", "sha1": "ff", "url": "https://x/l.jar" }
                    } } }
            ]
        })
    }

    fn instance() -> MinecraftInstance {
        MinecraftInstance::new(MinecraftPath::new(std::env::temp_dir().join("nihao-vanilla-test")), "Player")
    }

    #[test]
    fn the_launch_option_takes_the_game_the_java_and_the_libraries_from_the_version_json() {
        let option = parse_launch_option(manifest(), &instance()).unwrap();
        assert_eq!(option.main_class, "net.minecraft.client.main.Main");
        assert_eq!((option.java_version.component.as_str(), option.java_version.majorVersion), ("java-runtime-delta", 21));
        assert_eq!((option.client.url.as_str(), option.client.sha1.as_str()), ("https://x/client.jar", "bb"));
        assert_eq!((option.asset_index.url.as_str(), option.assets.as_str()), ("https://x/17.json", "17"));
        assert_eq!(option.libraries.iter().map(|l| l.path.as_str()).collect::<Vec<_>>(), ["com/google/code/gson/gson-2.10.jar", "org/lwjgl/lwjgl-3.3.jar"]);
        // Only this OS's natives.
        assert_eq!(option.natives.len(), 1);
        assert!(option.natives[0].path.ends_with(&format!("{}.jar", crate::platforms::NATIVES_CLASSIFIER)));
        // Plain string arguments only: the ones with rules (a demo flag, an OS check) are left out.
        let arguments = option.arguments.unwrap();
        assert_eq!(arguments.game, ["--username", "${auth_player_name}"]);
        assert_eq!(arguments.jvm, ["-Xss1M"]);
    }

    #[test]
    fn a_version_json_without_a_main_class_is_an_error() {
        let mut broken = manifest();
        broken.as_object_mut().unwrap().remove("mainClass");
        assert!(parse_launch_option(broken, &instance()).is_err());
    }

    #[test]
    fn old_versions_carry_their_arguments_as_one_string() {
        let mut old = manifest();
        let object = old.as_object_mut().unwrap();
        object.remove("arguments");
        object.insert("minecraftArguments".into(), "--username ${auth_player_name} --version ${version_name}".into());
        let arguments = parse_launch_option(old, &instance()).unwrap().arguments.unwrap();
        assert_eq!(arguments.game, ["--username", "${auth_player_name}", "--version", "${version_name}"]);
        assert!(arguments.jvm.is_empty());
    }
}
