use std::sync::Arc;

use futures_util::Stream;
use tokio::sync::{Mutex, mpsc};
use tokio_stream::wrappers::ReceiverStream;

use crate::library::install::DownloadInfo;


pub mod version;
pub mod java;
pub mod path;
pub mod auth;
pub mod install;
pub mod profile;
pub mod modpack_format;
pub mod export;
pub mod import;
pub mod missing_files;
pub mod mod_metadata;
pub mod content_cache;
pub mod context;
pub mod services;
pub mod online_modpacks;
pub mod session;
pub mod nihao_client;
pub mod elyby;
pub mod play_targets;

#[derive(Clone)]
pub struct MinecraftOption {
    pub min_ram: u32,
    pub max_ram: u32,
    pub jvm_arguments: String,
    pub launcher_name: String,
    pub launcher_version: String,
}
#[derive(Clone)]
pub struct MinecraftInstance {
    pub(crate) path: path::MinecraftPath,
    pub(crate) session: auth::MinecraftSession,
    pub(crate) option: MinecraftOption,
    pub(crate) java: java::JavaOption,
    pub(crate) version: version::MinecraftVersion,
    /// Join this world (folder name) or server (`host[:port]`) straight after launch.
    pub(crate) quick_play: Option<QuickPlay>,
}

/// `--quickPlay*` exists from 1.20 on, including the year-based ids (`26.1`) that replaced `1.x`;
/// ids that do not parse (snapshots) are assumed modern.
fn supports_quick_play(id: &str) -> bool {
    let mut parts = id.split('.').map(|p| p.parse::<u32>().ok());
    match (parts.next().flatten(), parts.next().flatten()) {
        (Some(1), Some(minor)) => minor >= 20,
        _ => true,
    }
}

#[cfg(test)]
mod quick_play_tests {
    use super::supports_quick_play;

    #[test]
    fn version_rule() {
        for old in ["1.8.9", "1.19.4", "1.12"] {
            assert!(!supports_quick_play(old), "{old}");
        }
        for new in ["1.20", "1.21.1", "1.21-rc1", "26.1", "26.1.2", "24w10a"] {
            assert!(supports_quick_play(new), "{new}");
        }
    }
}

#[derive(Clone)]
pub enum QuickPlay {
    World(String),
    Server(String),
}

impl MinecraftInstance {
    fn quick_play_args(&self) -> Result<Vec<String>, String> {
        let modern = supports_quick_play(&self.version.id);
        Ok(match (&self.quick_play, modern) {
            (None, _) => vec![],
            (Some(QuickPlay::World(w)), true) => vec!["--quickPlaySingleplayer".into(), w.clone()],
            (Some(QuickPlay::World(_)), false) => return Err("Joining a world directly needs Minecraft 1.20+".into()),
            (Some(QuickPlay::Server(s)), true) => vec!["--quickPlayMultiplayer".into(), s.clone()],
            (Some(QuickPlay::Server(s)), false) => match s.rsplit_once(':') {
                Some((host, port)) => vec!["--server".into(), host.into(), "--port".into(), port.into()],
                None => vec!["--server".into(), s.clone()],
            },
        })
    }

    /// `username` drives the in-game name and (via `auth::offline_uuid`) the offline-mode UUID.
    /// Falls back to "Player" for an empty or whitespace-only name, which Minecraft rejects.
    pub fn new(path: path::MinecraftPath, username: &str) -> MinecraftInstance {
        let username = if username.trim().is_empty() { "Player" } else { username.trim() };
        MinecraftInstance {
            path: path.clone(),
            session: auth::MinecraftSession::create(
                username.to_string(),
                "null".to_string(),
                auth::offline_uuid(username)
            ),
            option: MinecraftOption {
                min_ram: 512,
                max_ram: 2048,
                jvm_arguments: "".to_string(),
                launcher_name: "minecraft-launcher".to_owned(),
                launcher_version: "2".to_owned(),
            },
            java: java::JavaOption {
                java_path: None,
            },
            version: version::MinecraftVersion { 
                id: "1.19.2".to_string(), 
                core: version::MinecraftLoader::VANILLA,
                loader: None, 
            },
            quick_play: None,
        }
    }

    /// Returns a live progress stream plus the join handle of the install task. The stream alone
    /// can't signal failure (it just ends when `tx` drops), so await the handle after draining it.
    pub async fn install_stream(&mut self) -> Result<(impl Stream<Item = DownloadInfo>, tokio::task::JoinHandle<Result<(), String>>), String> {
        let (tx, rx) = mpsc::channel(10);

        tokio::fs::create_dir_all(self.path.game.clone())
            .await
            .map_err(|e| format!("Cannot create directory: {}", e))?;
        self.path.create_async().await
            .map_err(|e|format!("Error generated path: {}",e))?;

        let self_clone = Arc::new(Mutex::new(self.clone()));
        let handle = tokio::spawn({
            let self_clone = Arc::clone(&self_clone);
            async move {
                let mut _self = self_clone.lock().await;

                let launch_option = _self.generate_launch_option().await.map_err(|e|e.to_string())?;

                if let Err(why) = launch_option.clone().save_to_version_async(_self.get_jar_path().parent().unwrap().to_path_buf()).await {
                    eprintln!("Cannot save launch option: {}", why);
                    return Err(format!("Cannot save launch option: {}", why));
                };

                if let Err(why) = install::install_java(launch_option.java_version.clone(), &mut _self, &tx).await {
                    eprintln!("Fail install java: {}",why);
                    return Err(format!("Fail install java: {}",why));
                };
                if let Err(why) = install::install_libraries(launch_option.clone(), _self.path.library.clone(), &tx).await {
                    eprintln!("Fail install library: {}",why);
                    return Err(format!("Fail install library: {}",why));
                };
                if let Err(why) = install::install_natives(launch_option.clone(), _self.get_natives_path(), _self.path.library.clone(), &tx).await {
                    eprintln!("Fail install natives: {}",why);
                    return Err(format!("Fail install natives: {}",why));
                };
                if let Err(why) = install::install_assets(launch_option.clone(), _self.path.assets.clone(), &tx).await {
                    eprintln!("Fail install assets: {}",why);
                    return Err(format!("Fail install assets: {}",why));
                };
                if let Err(why) = install::install_client(launch_option.clone(), _self.get_jar_path(), &tx).await {
                    eprintln!("Fail install client: {}",why);
                    return Err(format!("Fail install client: {}",why));
                };

                if _self.version.core == version::MinecraftLoader::NEOFORGE {
                    if let Err(why) = install::run_neoforge_processors(&_self, &tx).await {
                        eprintln!("Fail NeoForge processors: {}", why);
                        return Err(format!("Fail NeoForge processors: {}", why));
                    };
                }

                Ok(())
            }
        });

        Ok((ReceiverStream::new(rx), handle))
    }

    /// Path to the game .jar. The directory is loader-prefixed (`self.version.filename()`, e.g.
    /// `neoforge-1.21.1`), but the JAR must stay named after the plain version id: NeoForge's
    /// BootstrapLauncher resolves classpath jars as JPMS automatic modules, and a jar named
    /// `neoforge-1.21.1.jar` derives module name "neoforge", colliding with the real
    /// `neoforge-<loader-version>-universal.jar` and crashing with `ResolutionException`.
    pub fn get_jar_path(&self) -> std::path::PathBuf {
        let filename = self.version.filename();
        self.path.versions
            .join(&filename)
            .join(format!("{}.jar", self.version.id))
    }

    /// Шлях до JSON маніфесту версії
    pub fn get_jar_manifest_path(&self) -> std::path::PathBuf {
        let filename = self.version.filename();
        self.path.versions
            .join(&filename)
            .join(format!("{}.json", filename))
    }

    /// Шлях до папки з нативними бібліотеками
    pub fn get_natives_path(&self) -> std::path::PathBuf {
        let filename = self.version.filename();
        self.path.versions
            .join(&filename)
            .join("natives")
    }

    /// Завантажує або будує конфігурацію для запуску (launch option) — кешовану, якщо є,
    /// інакше генерує заново і зберігає результат, щоб наступний виклик уже читав кеш.
    pub async fn get_launch_option(&mut self) -> Result<version::MinecraftInstanceOption, String> {
        let version_dir = self.path.versions.join(self.version.filename());

        if let Ok(option) = version::MinecraftInstanceOption::load_is_version_async(version_dir.clone()).await {
            return Ok(option);
        }

        let option = self.generate_launch_option().await?;
        let _ = option.clone().save_to_version_async(version_dir).await;
        Ok(option)
    }

    /// Always recomputes the launch option from the network, ignoring the cached `launch.nihao`:
    /// (re)installing is when a stale config (old loader bugfix, changed version/loader) should be
    /// refreshed.
    pub async fn generate_launch_option(&mut self) -> Result<version::MinecraftInstanceOption, String> {
        let mut option = match self.version.core {
            version::MinecraftLoader::FABRIC => {
                version::fabric::get_launch_option(self).await
            }
            version::MinecraftLoader::NEOFORGE => {
                version::neoforge::get_launch_option(self).await
            }
            _ => {
                version::vanilla::get_launch_option(self).await
            }
        }?;
        option.dedupe_libraries();
        Ok(option)
    }

    /// Launches the game after installation and returns the spawned process with piped
    /// stdout/stderr (does not wait for it to exit). Regenerates the launch option if it is missing
    /// (see `get_launch_option`).
    pub async fn build(&mut self) -> Result<std::process::Child, String> {
        let launch_option = self.get_launch_option().await?;

        // NeoForge's early-display GL window is a known crash source on some GPU/driver combos
        // (NPE in DisplayWindow.updateModuleReads) and the launcher shows progress itself, so
        // disable it: config/fml.toml -> earlyWindowControl=false
        // (https://neoforged.net/meta/displayerrors/).
        if self.version.core == version::MinecraftLoader::NEOFORGE {
            let fml_config_path = self.path.game.join("config").join("fml.toml");
            if !fml_config_path.exists() {
                if let Some(parent) = fml_config_path.parent() {
                    let _ = tokio::fs::create_dir_all(parent).await;
                }
                let _ = tokio::fs::write(&fml_config_path, "earlyWindowControl=false\n").await;
            }
        }

        let java_path = match &self.java.java_path {
            Some(p) => p.clone(),
            None => self.path.runtime
                .join(&launch_option.java_version.component)
                .join(crate::platforms::GAME_JAVA)
                .display()
                .to_string(),
        };

        let libraries_arg = launch_option.ligraries_to_args(self.path.library.clone());
        let clients_arg = launch_option.clients_to_args(self.clone());

        let classpath = format!("{}{}", libraries_arg, clients_arg);

        let game_args: Vec<String> = launch_option.arguments
            .as_ref()
            .map(|a| a.game.clone())
            .unwrap_or_default()
            .iter()
            .map(|arg| self.resolve_argument(arg, &launch_option))
            .collect();

        let jvm_args: Vec<String> = launch_option.arguments
            .as_ref()
            .map(|a| a.jvm.clone())
            .unwrap_or_default()
            .iter()
            .map(|arg| self.resolve_argument(arg, &launch_option))
            .collect();

        let mut cmd = std::process::Command::new(&java_path);
        cmd.current_dir(&self.path.game);
        cmd.args(&jvm_args);
        // Explicit heap flags: neither Mojang's nor a loader's `arguments.jvm` ever contains
        // `-Xmx`/`-Xms`, so `resolve_argument`'s `${Xmx}`/`${Xms}` substitution matched nothing
        // and RAM settings never reached the JVM (it used its default of ~1/4 of physical RAM).
        cmd.arg(format!("-Xms{}m", self.option.min_ram));
        cmd.arg(format!("-Xmx{}m", self.option.max_ram));
        // Extra JVM args from the instance's "Install" settings, appended after the loader's own
        // so later `-D`/`-X` flags win.
        if !self.option.jvm_arguments.trim().is_empty() {
            cmd.args(self.option.jvm_arguments.split_whitespace());
        }
        cmd.arg(format!("-Djava.library.path={}", self.get_natives_path().display()));
        cmd.arg(format!("-Dnihao.session={}", self.session.session_type.property()));
        // An environment variable, not a `-D` flag: JVM flags are printed in crash reports (which
        // players share), the environment is not.
        if let Some(token) = &self.session.nihao_token {
            cmd.env("NIHAO_TOKEN", token);
        }
        cmd.arg("-cp").arg(&classpath);
        cmd.arg(&launch_option.main_class);
        cmd.args(&game_args);
        cmd.args(self.quick_play_args()?);
        cmd.stdout(std::process::Stdio::piped());
        cmd.stderr(std::process::Stdio::piped());

        // The token must not end up in the launcher's log.
        let shown = format!("{:?}", cmd);
        println!("Launching: {}", self.session.nihao_token.as_deref().map_or(shown.clone(), |t| shown.replace(t, "<token>")));
        cmd.spawn().map_err(|e| format!("Failed to launch: {}", e))
    }

    /// Підставляє змінні в аргументи запуску
    fn resolve_argument(&self, arg: &str, launch_option: &version::MinecraftInstanceOption) -> String {
        arg
            .replace("${auth_player_name}", &self.session.username)
            .replace("${version_name}", &self.version.id)
            .replace("${game_directory}", &self.path.game.display().to_string())
            .replace("${assets_root}", &self.path.assets.display().to_string())
            .replace("${assets_index_name}", &launch_option.assets)
            .replace("${auth_uuid}", &self.session.uuid)
            .replace("${auth_access_token}", self.session.access_token.as_deref().unwrap_or(""))
            .replace("${user_type}", "mojang")
            .replace("${version_type}", &launch_option.r#type)
            .replace("${launcher_name}", &self.option.launcher_name)
            .replace("${launcher_version}", &self.option.launcher_version)
            .replace("${natives_directory}", &self.get_natives_path().display().to_string())
            .replace("${classpath}", "")
            // NeoForge's (and modern Forge's) `-p` module-path arg is built from these two; left
            // unresolved, the JVM gets a literal "${library_directory}/..." path, fails to load
            // `cpw.mods.securejarhandler` and BootstrapLauncher crashes.
            .replace("${library_directory}", &self.path.library.display().to_string())
            .replace("${classpath_separator}", crate::platforms::CLASSPATH_SEPARATOR)
            .to_string()
    }
}
