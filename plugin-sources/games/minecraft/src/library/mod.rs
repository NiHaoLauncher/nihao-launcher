use std::sync::Arc;

use futures_util::Stream;
use tokio::sync::{Mutex, mpsc};
use tokio_stream::wrappers::ReceiverStream;

use crate::library::install::DownloadInfo;

pub mod core;

pub mod version;
pub mod java;
pub mod path;
pub mod auth;
pub mod install;
pub mod profile;
pub mod modpack_format;
pub mod export;
pub mod import;
pub mod mod_metadata;
pub mod content_cache;
pub mod modrinth_browse;

#[derive(Clone)]
pub struct MinecraftOption {
    pub min_ram: u32,
    pub max_ram: u32,
    pub jvm_arguments: String,
    pub launcher_name: String,
    pub launcher_version: String,
    pub server_ip: String,
    pub server_port: u32,
    pub fullscreen: bool,
}
#[derive(Clone)]
pub struct MinecraftInstance {
    pub(crate) path: path::MinecraftPath,
    pub(crate) session: auth::MinecraftSession,
    pub(crate) option: MinecraftOption,
    pub(crate) java: java::JavaOption,
    pub(crate) version: version::MinecraftVersion,
}
impl MinecraftInstance {
    /// `username` drives both the in-game display name and (via `auth::offline_uuid`) the
    /// offline-mode UUID — see that function's doc comment for why it's derived rather than
    /// fixed. Falls back to "Player" if given an empty/whitespace-only username, since Minecraft
    /// itself rejects a blank name at launch.
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
                server_ip: "null".to_string(),
                server_port: 0,
                fullscreen: false,
            },
            java: java::JavaOption {
                java_path: None,
                //java_path: Some(path.runtime.join("jre-legacy/bin/javaw.exe").display().to_string()),
            },
            version: version::MinecraftVersion { 
                id: "1.19.2".to_string(), 
                core: version::MinecraftLoader::VANILLA,
                loader: None, 
            },
        }
    }

    /// Returns a live progress stream plus the join handle for the spawned install task —
    /// the stream alone can't signal failure (it just ends when `tx` drops), so callers
    /// that need to know whether the install actually succeeded should await the handle
    /// after draining the stream.
    pub async fn install_stream(&mut self) -> Result<(impl Stream<Item = DownloadInfo>, tokio::task::JoinHandle<Result<(), String>>), String> {
        let (tx, rx) = mpsc::channel(10);

        tokio::fs::create_dir_all(self.path.game.clone())
            .await
            .map_err(|e| format!("Cannot create directory: {}", e))?;
        self.path.create_async().await
            .map_err(|e|format!("Error generated path: {}",e))?;

        //// Processing Game ////
        let self_clone = Arc::new(Mutex::new(self.clone()));
        let handle = tokio::spawn({
            let self_clone = Arc::clone(&self_clone);
            async move {
                let mut _self = self_clone.lock().await;

                let launch_option = _self.generate_launch_option().await.map_err(|e|e.to_string())?;

                //// Save option ////
                if let Err(why) = launch_option.clone().save_to_version_async(_self.get_jar_path().parent().unwrap().to_path_buf()).await {
                    eprintln!("Cannot save launch option: {}", why);
                    return Err(format!("Cannot save launch option: {}", why));
                };

                //// Install java ////
                if let Err(why) = install::install_java(launch_option.java_version.clone(), &mut _self, &tx).await {
                    eprintln!("Fail install java: {}",why);
                    return Err(format!("Fail install java: {}",why));
                };
                //// Install libraries ////
                if let Err(why) = install::install_libraries(launch_option.clone(), _self.path.library.clone(), &tx).await {
                    eprintln!("Fail install library: {}",why);
                    return Err(format!("Fail install library: {}",why));
                };
                //// Install natives ////
                if let Err(why) = install::install_natives(launch_option.clone(), _self.get_natives_path(), _self.path.library.clone(), &tx).await {
                    eprintln!("Fail install natives: {}",why);
                    return Err(format!("Fail install natives: {}",why));
                };
                //// Install assets ////
                if let Err(why) = install::install_assets(launch_option.clone(), _self.path.assets.clone(), &tx).await {
                    eprintln!("Fail install assets: {}",why);
                    return Err(format!("Fail install assets: {}",why));
                };
                //// Install client ////
                if let Err(why) = install::install_client(launch_option.clone(), _self.get_jar_path(), &tx).await {
                    eprintln!("Fail install client: {}",why);
                    return Err(format!("Fail install client: {}",why));
                };

                //// NeoForge: patch the just-downloaded vanilla client jar ////
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

    /// Шлях до .jar файлу гри.
    ///
    /// The directory is loader-prefixed (`self.version.filename()`, e.g. `neoforge-1.21.1`)
    /// so vanilla/fabric/neoforge installs of the same MC version don't collide on disk —
    /// but the JAR ITSELF must stay named after the plain version id. NeoForge's
    /// BootstrapLauncher resolves classpath jars as JPMS automatic modules, and Java derives
    /// an automatic module's name by stripping everything from the first `-<digit>` onward
    /// as a "version" — so a jar literally named `neoforge-1.21.1.jar` derives module name
    /// "neoforge", colliding with the real `neoforge-<loader-version>-universal.jar` (also
    /// named module "neoforge") and crashing with
    /// `ResolutionException: Module ... reads more than one module named neoforge`.
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

        // Спробуємо завантажити збережену конфігурацію
        if let Ok(option) = version::MinecraftInstanceOption::load_is_version_async(version_dir.clone()).await {
            return Ok(option);
        }

        let option = self.generate_launch_option().await?;
        let _ = option.clone().save_to_version_async(version_dir).await;
        Ok(option)
    }

    /// Always (re)computes the launch option from the network, ignoring any cached
    /// `launch.nihao` — used by the install pipeline, since (re)installing is exactly the
    /// moment a stale cached config (e.g. from before a loader-generation bugfix, or a
    /// version/loader change on retry) should be refreshed rather than silently reused.
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

    /// Запускає гру (після встановлення). Повертає щойно заспавнений процес зі
    /// stdout/stderr, підключеними через пайпи — виклик не чекає завершення гри.
    ///
    /// Falls back to (re)generating the launch option if it's missing (e.g. cache cleared,
    /// or never installed) instead of hard-failing — see `get_launch_option`.
    pub async fn build(&mut self) -> Result<std::process::Child, String> {
        let launch_option = self.get_launch_option().await?;

        // NeoForge's "early display" GL loading-screen window is a known crash source on
        // some GPU/driver combos (NPE deep in DisplayWindow.updateModuleReads) — this
        // launcher already shows install/launch progress itself, so it's pure downside.
        // Officially documented workaround: config/fml.toml -> earlyWindowControl=false.
        // https://neoforged.net/meta/displayerrors/
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
                .join("bin/javaw.exe")
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
        // Explicit heap flags — neither Mojang's nor a loader's own `arguments.jvm` template
        // ever contains a `-Xmx`/`-Xms` entry (memory sizing has always been the launcher's own
        // job, not something substituted into the manifest's args), so these have to be added
        // directly rather than via `resolve_argument`'s `${Xmx}`/`${Xms}` substitution, which
        // was matching a token that never actually appears anywhere — meaning RAM settings were
        // silently never reaching the JVM at all, which just fell back to its own ergonomic
        // default (roughly a quarter of physical RAM) regardless of what was configured here.
        cmd.arg(format!("-Xms{}m", self.option.min_ram));
        cmd.arg(format!("-Xmx{}m", self.option.max_ram));
        // User-supplied extra JVM args from the instance's "Install" settings (raw
        // space-separated string) — appended after the loader's own, so they can add to or
        // override earlier flags (later `-D`/`-X` wins for the JVM).
        if !self.option.jvm_arguments.trim().is_empty() {
            cmd.args(self.option.jvm_arguments.split_whitespace());
        }
        cmd.arg(format!("-Djava.library.path={}", self.get_natives_path().display()));
        cmd.arg("-cp").arg(&classpath);
        cmd.arg(&launch_option.main_class);
        cmd.args(&game_args);
        cmd.stdout(std::process::Stdio::piped());
        cmd.stderr(std::process::Stdio::piped());

        println!("Launching: {:?}", cmd);
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
            // NeoForge's (and modern Forge's) `-p` module-path JVM arg is built entirely
            // out of these two — left unresolved, the JVM gets a literal "${library_directory}/..."
            // path, silently fails to load `cpw.mods.securejarhandler` as a module, and
            // BootstrapLauncher crashes trying to use reflection that module was supposed
            // to open up.
            .replace("${library_directory}", &self.path.library.display().to_string())
            .replace("${classpath_separator}", if cfg!(windows) { ";" } else { ":" })
            .to_string()
    }
}
