use std::path::{Path, PathBuf};

use tokio::fs;

#[derive(Clone)]
pub struct MinecraftPath {
    pub game: PathBuf,
    pub versions: PathBuf,
    pub assets: PathBuf,
    pub library: PathBuf,
    pub runtime: PathBuf,
    pub resource: PathBuf,
}

impl MinecraftPath {
    pub fn new(path: PathBuf) -> MinecraftPath {
        MinecraftPath {
            game: path.clone(),
            versions: Path::new(&path).join("versions"),
            assets: Path::new(&path).join("assets"),
            library: Path::new(&path).join("libraries"),
            runtime: Path::new(&path).join("runtime"),
            resource: Path::new(&path).join("resource"),
        }
    }

    pub async fn create_async(&self) -> Result<(), String> {
        fs::create_dir_all(self.game.clone())
            .await
            .map_err(|e| format!("Cannot create 'game' directory: {}", e))?;
        fs::create_dir_all(self.versions.clone())
            .await
            .map_err(|e| format!("Cannot create 'versions' directory: {}", e))?;
        fs::create_dir_all(self.assets.clone())
            .await
            .map_err(|e| format!("Cannot create 'assets' directory: {}", e))?;
        fs::create_dir_all(self.library.clone())
            .await
            .map_err(|e| format!("Cannot create 'library' directory: {}", e))?;
        fs::create_dir_all(self.runtime.clone())
            .await
            .map_err(|e| format!("Cannot create 'runtime' directory: {}", e))?;
        fs::create_dir_all(self.resource.clone())
            .await
            .map_err(|e| format!("Cannot create 'resource' directory: {}", e))?;
        Ok(())
    }
}

