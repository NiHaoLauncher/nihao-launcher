use std::{io::Write, path::PathBuf};

use serde::{Deserialize, Serialize};
use tokio::{fs, io::AsyncWriteExt};

use crate::library::MinecraftInstance;

pub mod vanilla;
pub mod fabric;
pub mod neoforge;


#[derive(Deserialize, Serialize, PartialEq, Clone)]
pub struct MinecraftInstanceOption {
    pub arguments: Option<MinecraftArguments>,
    pub r#type: String,
    pub main_class: String,

    pub java_version: MinecraftInstanceJavaVersion,
    pub assets: String,
    pub asset_index: MinecraftInstanceDownloadCompact,
    pub libraries: Vec<MinecraftInstanceDownload>,
    pub natives: Vec<MinecraftInstanceDownload>,
    pub client: MinecraftInstanceDownloadCompact,
    pub other_client: Vec<MinecraftInstanceDownloadCompact>,
}
#[derive(Deserialize, Serialize, PartialEq, Clone)]
pub struct MinecraftArguments {
    pub game: Vec<String>,
    pub jvm: Vec<String>,
}
#[derive(Deserialize, Serialize, PartialEq, Clone)]
pub struct MinecraftInstanceDownload {
    pub name: String,
    pub path: String,
    pub sha1: String,
    pub url: String,
    pub resource: String,
}
#[derive(Deserialize, Serialize, PartialEq, Clone, Debug)]
pub struct MinecraftInstanceDownloadCompact {
    pub url: String,
    pub sha1: String,
    pub path: Option<String>,
}
#[derive(Deserialize, Serialize, PartialEq, Clone)]
pub struct MinecraftInstanceJavaVersion {
    pub component: String,
    pub majorVersion: u64,
}
pub static LAUNCH_FILE_NAME: &'static str = "launch.nihao";
impl MinecraftInstanceOption {
    /// Loaders like Fabric/NeoForge layer their own `libraries` on top of vanilla's own
    /// list, and modded loaders' lists often re-list shared dependencies (e.g. gson) that
    /// are already in vanilla's — same resolved classpath entry twice. Most loaders
    /// tolerate a duplicate `-cp` entry, but NeoForge's BootstrapLauncher builds a
    /// `UnionFileSystem` keyed by path and hard-errors ("Duplicate key ...") if the same
    /// jar shows up more than once, so this needs to run before building the classpath.
    pub fn dedupe_libraries(&mut self) {
        let mut seen = std::collections::HashSet::new();
        self.libraries.retain(|lib| seen.insert(lib.path.clone()));
    }

    pub fn ligraries_to_args(&self, path:PathBuf) -> String {
        let mut result = "".to_string();
        for lib_option in self.libraries.clone() {
            result.push_str(&format!("{};", path.join(lib_option.path).display()));
        };
        result
    }
    pub fn clients_to_args(&self, instance:MinecraftInstance) -> String {
        let mut result = "".to_string();
        let binding = instance.get_jar_path();
        let path_parent = binding.parent().unwrap();
        for other_client in self.other_client.clone() {
            if other_client.path == None {
                eprintln!("Other client is none! {:?}", other_client);
                continue;
            };
            result.push_str(&format!("{};", path_parent.join(other_client.path.unwrap()).display()));
        };
        // NeoForge doesn't need the raw vanilla jar on `-cp` at all: FML's own
        // NeoForgeClientLaunchHandler assembles its "minecraft" module internally out of
        // maven-located libraries (srg/extra/neoforge-client, all produced by
        // `install::run_neoforge_processors`), resolved via `-DlibraryDirectory` + the
        // `--fml.*` args — not from anything on the classpath. Putting the untouched vanilla
        // jar on `-cp` too would just duplicate `net.minecraft.*` packages for no benefit.
        if instance.version.core != MinecraftLoader::NEOFORGE {
            result.push_str(&instance.get_jar_path().display().to_string());
        }
        result
    }
    pub async fn load_is_version_async(path:PathBuf) -> Result<MinecraftInstanceOption, String> {
        if !path.is_dir() { return Err("Path in not dir!".to_string()); }
        let file_path = path.join(LAUNCH_FILE_NAME);
        if file_path.exists() {
            MinecraftInstanceOption::load_is_file_async(file_path).await
        }else{
            return Err(format!("Not find '{}'!",LAUNCH_FILE_NAME));
        }
    }
    pub fn load_is_version(path:PathBuf) -> Result<MinecraftInstanceOption, String> {
        if !path.is_dir() { return Err("Path in not dir!".to_string()); }
        let file_path = path.join(LAUNCH_FILE_NAME);
        if file_path.exists() {
            MinecraftInstanceOption::load_is_file(file_path)
        }else{
            return Err(format!("Not find '{}'!",LAUNCH_FILE_NAME));
        }
    }
    pub async fn load_is_file_async(path:PathBuf) -> Result<MinecraftInstanceOption, String> {
        if path.is_file() {
            let content = tokio::fs::read_to_string(path).await
                .map_err(|e|e.to_string())?;
            let result: MinecraftInstanceOption = serde_json::from_str(&content)
                .map_err(|e|e.to_string())?;
            Ok(result)
        }else{
            Err("Path in not file!".to_string())
        }
    }
    pub fn load_is_file(path:PathBuf) -> Result<MinecraftInstanceOption, String> {
        if path.is_file() {
            let content = std::fs::read_to_string(path)
                .map_err(|e|e.to_string())?;
            let result: MinecraftInstanceOption = serde_json::from_str(&content)
                .map_err(|e|e.to_string())?;
            Ok(result)
        }else{
            Err("Path in not file!".to_string())
        }
    }
    pub fn save_to_version(&self, path:PathBuf) -> Result<(), String> {
        let content = serde_json::to_string(&self.clone())
            .map_err(|e|e.to_string())?;
        let mut file = std::fs::File::create(path.join(LAUNCH_FILE_NAME))
            .map_err(|e|e.to_string())?;
        file.write_all(&content.as_bytes())
            .map_err(|e|e.to_string())?;
        Ok(())
    }
    pub async fn save_to_version_async(&self, path:PathBuf) -> Result<(), String> {
        fs::create_dir_all(path.clone())
            .await
            .map_err(|e|e.to_string()).unwrap();

        let content = serde_json::to_string(&self.clone())
            .map_err(|e|e.to_string())?;
        println!("{}", path.display());
        let mut file = tokio::fs::File::create(path.join(LAUNCH_FILE_NAME)).await
            .map_err(|e|e.to_string())?;
        file.write_all(&content.as_bytes()).await
            .map_err(|e|e.to_string())?;
        Ok(())
    }
}




#[derive(Deserialize, Serialize, Clone, PartialEq)]
pub enum MinecraftLoader {
    VANILLA, FABRIC, FORGE, NEOFORGE
}
impl MinecraftLoader {
    pub fn to_string(&self) -> String {
        match self {
            MinecraftLoader::VANILLA => "vanilla".to_owned(),
            MinecraftLoader::FABRIC => "fabric".to_owned(),
            MinecraftLoader::FORGE => "forge".to_owned(),
            MinecraftLoader::NEOFORGE => "neoforge".to_owned(),
        }
    }
    pub fn from_str(content: &str) -> MinecraftLoader {
        match content {
            "fabric" => MinecraftLoader::FABRIC,
            "forge" => MinecraftLoader::FORGE,
            "neoforge" => MinecraftLoader::NEOFORGE,
            _ => MinecraftLoader::VANILLA
        }
    }
}
#[derive(Deserialize, Serialize, Clone, PartialEq)]
pub struct MinecraftVersion {
    pub id: String,
    pub core: MinecraftLoader,
    pub loader: Option<String>,
}
impl MinecraftVersion {
    pub fn filename(&self) -> String {
        match self.core {
            MinecraftLoader::FABRIC => format!("fabric-{}",self.id),
            MinecraftLoader::NEOFORGE => format!("neoforge-{}",self.id),
            _ => self.id.clone()
        }
    }
    pub fn display(&self) -> String {
        if self.core != MinecraftLoader::VANILLA {
            return format!("{}/{}",self.core.to_string(), self.id);
        }
        format!("{}/{}-{}",self.core.to_string(), self.id, self.loader.clone().unwrap_or("default".to_string()))
    }
}