use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::{Arc, Mutex, OnceLock};

use futures_util::StreamExt;
use serde::Serialize;

use crate::library::{
    self,
    install::DownloadInfo,
    modpack_format::{diff_manifests, generate_manifest, ModpackDiff, ModpackManifest},
    profile::MinecraftProfile,
    version::MinecraftLoader,
    MinecraftInstance,
};

launcher_common::declare_service![
    get_modpacks(path: String),
    create_modpack(path: String, name: String, core: String, version: String, loader: Option<String>),
    get_versions(core: String),
    get_loader_versions(core: String, version: String),
    play_modpack(path: String, name: String, nickname: Option<String>),
    get_install_status(),
    get_launch_log(name: String),
    close_modpack(name: String),
    update_modpack_settings(path: String, name: String, max_ram: u32, min_ram: u32, use_custom_ram: bool, java_path: Option<String>, jvm_arguments: String),
    rename_modpack(path: String, name: String, display_name: String),
    delete_modpack(path: String, name: String),
    duplicate_modpack(path: String, name: String, new_name: String),
    set_modpack_icon(path: String, name: String, icon_source_path: String),
    set_modpack_banner(path: String, name: String, banner_source_path: String),
    generate_modpack_manifest(path: String, name: String, id: String, pack_name: String, build: u64, version: Option<String>),
    get_modpack_manifest(path: String, name: String),
    diff_modpack_manifest(path: String, name: String, remote: serde_json::Value),
    get_home_preview(path: String),
    open_modpack_folder(path: String, name: String),
    list_export_entries(path: String, name: String),
    export_modpack_own(path: String, name: String, include: Vec<String>, dest_path: String),
    export_modpack_mrpack(path: String, name: String, include: Vec<String>, dest_path: String),
    peek_modpack_file(source_path: String),
    import_modpack(path: String, name: String, source_path: String),
    list_content(path: String, name: String),
    start_content_scan(path: String, name: String),
    get_content_scan_status(name: String),
    toggle_content_file(path: String, name: String, category: String, filename: String),
    delete_content_file(path: String, name: String, category: String, filename: String),
    search_modrinth_content(path: String, name: String, category: String, query: String, offset: u32, limit: u32, sort: String, categories: Vec<String>, environments: Vec<String>),
    install_modrinth_content(path: String, name: String, category: String, project_id: String, title: String),
    list_modrinth_categories(category: String),
    get_modrinth_project(project_id: String)
];

/// A snapshot of one instance's install progress, polled by the launcher UI.
#[derive(Clone, Serialize)]
struct InstallProgress {
    name: String,
    etap: String,
    current_etaps: usize,
    total_etaps: usize,
    current_file: usize,
    total_files: usize,
    status: String,
    filename: String,
}

impl InstallProgress {
    fn from_info(name: &str, info: &DownloadInfo) -> Self {
        InstallProgress {
            name: name.to_string(),
            etap: info.etap.clone(),
            current_etaps: info.current_etaps,
            total_etaps: info.total_etaps,
            current_file: info.current_file,
            total_files: info.total_files,
            status: info.status.to_string(),
            filename: info.filename.clone(),
        }
    }
}

/// Tracks background installs so the launcher UI can show an ambient "installing"
/// indicator instead of blocking on `create_modpack` until the whole install finishes.
#[derive(Default)]
struct InstallState {
    active: HashMap<String, InstallProgress>,
    last_error: Option<(String, String)>,
}

fn install_state() -> &'static Mutex<InstallState> {
    static STATE: OnceLock<Mutex<InstallState>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(InstallState::default()))
}

/// A running instance's java process plus its captured stdout/stderr — the plugin call
/// boundary can't push a live log to the frontend, so the UI polls `get_launch_log` instead.
struct RunningProcess {
    child: Child,
    log: Arc<Mutex<Vec<String>>>,
}

fn running_state() -> &'static Mutex<HashMap<String, RunningProcess>> {
    static STATE: OnceLock<Mutex<HashMap<String, RunningProcess>>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(HashMap::new()))
}

const LOG_LINE_CAP: usize = 2000;

/// Reads `reader` line-by-line into `log` on a background thread until the pipe closes
/// (i.e. the process exits or is killed).
fn spawn_log_reader<R: Read + Send + 'static>(reader: R, log: Arc<Mutex<Vec<String>>>) {
    std::thread::spawn(move || {
        for line in BufReader::new(reader).lines() {
            let Ok(line) = line else { break };
            println!("[minecraft:client] {}", line);
            let mut log = log.lock().unwrap();
            log.push(line);
            let len = log.len();
            if len > LOG_LINE_CAP {
                log.drain(0..len - LOG_LINE_CAP);
            }
        }
    });
}

/// The FFI call boundary (`GameSupport::call`) is a plain synchronous function — it can't
/// `.await` — so all the (async) install/launch/manifest-fetching code in `library/` is
/// driven from here through one process-wide blocking runtime.
fn runtime() -> &'static tokio::runtime::Runtime {
    static RUNTIME: OnceLock<tokio::runtime::Runtime> = OnceLock::new();
    RUNTIME.get_or_init(|| {
        tokio::runtime::Runtime::new().expect("Failed to start Minecraft plugin runtime")
    })
}

/// `{configured game path}/instances/{name}` — the per-instance run directory (saves, mods,
/// `profile.nihao`). `versions`/`assets`/`libraries`/`runtime` stay shared at the configured
/// root across every instance of this game.
fn instance_dir(path: &str, name: &str) -> PathBuf {
    Path::new(path).join("instances").join(name)
}

fn build_instance(path: &str, name: &str, profile: &MinecraftProfile, nickname: &str) -> MinecraftInstance {
    let mut mc_path = library::path::MinecraftPath::new(PathBuf::from(path));
    mc_path.game = instance_dir(path, name);

    let mut instance = MinecraftInstance::new(mc_path, nickname);
    instance.version = library::version::MinecraftVersion {
        id: profile.version_id.clone(),
        core: profile.core.clone(),
        loader: profile.loader_version.clone(),
    };
    instance.option.max_ram = profile.max_ram;
    instance.option.min_ram = profile.min_ram;
    instance.option.jvm_arguments = profile.jvm_arguments.clone();
    instance.java.java_path = profile.java_path.clone();
    instance
}

/// Base64 data-URI for an instance's custom icon/banner, if it has one — read fresh each time
/// rather than cached, since it's small and rarely changes. Neither file has an extension (see
/// `set_modpack_icon`/`set_modpack_banner`), so the declared MIME type here is just a hint —
/// browsers sniff actual image content rather than trusting it, so it displays correctly
/// regardless of format.
fn image_data_uri(dir: &Path, filename: &Option<String>) -> Option<String> {
    let filename = filename.as_ref()?;
    let bytes = std::fs::read(dir.join(filename)).ok()?;
    use base64::Engine;
    Some(format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)))
}

/// Recursively copies a directory (used by `duplicate_modpack`) — no crate for this is
/// already a dependency, so it's a small manual walk rather than pulling one in for one call site.
fn copy_dir_recursive(from: &Path, to: &Path) -> Result<(), String> {
    std::fs::create_dir_all(to).map_err(|e| e.to_string())?;
    for entry in std::fs::read_dir(from).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let src = entry.path();
        let dst = to.join(entry.file_name());
        if src.is_dir() {
            copy_dir_recursive(&src, &dst)?;
        } else {
            std::fs::copy(&src, &dst).map_err(|e| format!("Cannot copy '{}': {}", src.display(), e))?;
        }
    }
    Ok(())
}

pub fn get_modpacks(path: String) -> Result<serde_json::Value, String> {
    let root = Path::new(&path).join("instances");
    let list = runtime().block_on(library::profile::list_instances(&root));

    let result: Vec<serde_json::Value> = list
        .into_iter()
        .map(|(name, profile)| {
            let dir = root.join(&name);
            let icon_data = image_data_uri(&dir, &profile.icon);
            let banner_data = image_data_uri(&dir, &profile.banner);
            serde_json::json!({ "name": name, "profile": profile, "icon_data": icon_data, "banner_data": banner_data })
        })
        .collect();
    Ok(serde_json::Value::Array(result))
}

/// Quick summary shown in the launcher's library hover preview (`GamesLibrary` — see
/// `src/launcher.tsx`). This is an *optional* convention any game plugin can implement:
/// `call_module(gameId, "get_home_preview", { path })` returning `{ label, items }` — the
/// host renders it generically without knowing anything about the specific game. A plugin
/// that doesn't implement it just shows the tile's name on hover with nothing else.
pub fn get_home_preview(path: String) -> Result<serde_json::Value, String> {
    let root = Path::new(&path).join("instances");
    let list = runtime().block_on(library::profile::list_instances(&root));

    let items: Vec<String> = list
        .into_iter()
        .map(|(name, profile)| {
            if profile.display_name.is_empty() { name } else { profile.display_name }
        })
        .collect();

    Ok(serde_json::json!({ "label": "Modpacks", "items": items }))
}

/// Saves the profile synchronously (fast — local file I/O only), then runs the actual
/// install pipeline on a detached background thread so this call returns immediately
/// instead of blocking the whole plugin call boundary for however long downloading
/// Java/libraries/assets/the client takes. Progress isn't streamed to the frontend yet
/// (see `get_install_status`) — but the UI is no longer frozen waiting on it.
pub fn create_modpack(
    path: String,
    name: String,
    core: String,
    version: String,
    loader: Option<String>,
) -> Result<serde_json::Value, String> {
    let dir = instance_dir(&path, &name);

    // Re-using an existing name re-saves the profile and re-runs the install pipeline for
    // it, rather than erroring — the common reasons to "create" over an existing instance
    // are retrying a failed install and the "Repair / re-verify files" settings action,
    // neither of which should reset the user's own settings (RAM, java path, jvm args, icon).
    let existing = runtime().block_on(MinecraftProfile::load(&dir)).ok();
    let profile = MinecraftProfile {
        display_name: existing.as_ref().map(|p| p.display_name.clone()).unwrap_or_else(|| name.clone()),
        version_id: version,
        core: MinecraftLoader::from_str(&core),
        loader_version: loader,
        max_ram: existing.as_ref().map(|p| p.max_ram).unwrap_or(2048),
        min_ram: existing.as_ref().map(|p| p.min_ram).unwrap_or(512),
        use_custom_ram: existing.as_ref().map(|p| p.use_custom_ram).unwrap_or(false),
        java_path: existing.as_ref().and_then(|p| p.java_path.clone()),
        jvm_arguments: existing.as_ref().map(|p| p.jvm_arguments.clone()).unwrap_or_default(),
        icon: existing.as_ref().and_then(|p| p.icon.clone()),
        banner: existing.as_ref().and_then(|p| p.banner.clone()),
        pack: existing.as_ref().and_then(|p| p.pack.clone()),
    };

    runtime().block_on(profile.save(&dir))?;

    {
        let mut state = install_state().lock().unwrap();
        state.active.insert(name.clone(), InstallProgress {
            name: name.clone(),
            etap: "Queued".to_string(),
            current_etaps: 0,
            total_etaps: 5,
            current_file: 0,
            total_files: 0,
            status: "check".to_string(),
            filename: String::new(),
        });
    }

    let path_bg = path.clone();
    let name_bg = name.clone();
    let profile_bg = profile.clone();
    std::thread::spawn(move || {
        let result: Result<(), String> = runtime().block_on(async {
            // Installing never launches the game, so the session/username here is unused —
            // any placeholder works.
            let mut instance = build_instance(&path_bg, &name_bg, &profile_bg, "Player");
            let (mut stream, handle) = instance.install_stream().await?;
            while let Some(info) = stream.next().await {
                println!(
                    "[minecraft] install {} ({}/{}): {} {}",
                    info.etap, info.current_etaps, info.total_etaps, info.status.to_string(), info.filename
                );
                install_state().lock().unwrap().active.insert(
                    name_bg.clone(),
                    InstallProgress::from_info(&name_bg, &info),
                );
            }
            handle.await.map_err(|e| format!("Install task panicked: {}", e))?
        });

        let mut state = install_state().lock().unwrap();
        state.active.remove(&name_bg);
        match &result {
            Ok(()) => println!("[minecraft] Install finished for '{}'.", name_bg),
            Err(e) => {
                eprintln!("[minecraft] Install failed for '{}': {}", name_bg, e);
                state.last_error = Some((name_bg.clone(), e.clone()));
            }
        }
    });

    Ok(serde_json::json!({ "status": "installing", "name": name }))
}

/// Polled by the launcher UI to show an ambient "installing" indicator with detail.
pub fn get_install_status() -> Result<serde_json::Value, String> {
    let state = install_state().lock().unwrap();
    Ok(serde_json::json!({
        "installing": state.active.values().cloned().collect::<Vec<_>>(),
        "lastError": state.last_error.as_ref().map(|(name, error)| serde_json::json!({ "name": name, "error": error })),
    }))
}

pub fn get_versions(core: String) -> Result<serde_json::Value, String> {
    runtime().block_on(async {
        let loader = MinecraftLoader::from_str(&core);
        let versions: Vec<String> = match loader {
            MinecraftLoader::FABRIC => library::version::fabric::get_manifest_async()
                .await?
                .into_iter()
                .filter(|v| v.stable)
                .map(|v| v.version)
                .collect(),
            MinecraftLoader::NEOFORGE => library::version::neoforge::get_supported_mc_versions_async().await?,
            _ => library::version::vanilla::get_manifest_async()
                .await?
                .versions
                .into_iter()
                .filter(|v| v.r#type == "release")
                .map(|v| v.id)
                .collect(),
        };
        Ok(serde_json::json!(versions))
    })
}

/// Loader (build) versions compatible with a given Minecraft game version — powers the
/// "Loader version" select that only appears for loaders that need one (Fabric, NeoForge).
pub fn get_loader_versions(core: String, version: String) -> Result<serde_json::Value, String> {
    runtime().block_on(async {
        let loader = MinecraftLoader::from_str(&core);
        let versions: Vec<String> = match loader {
            MinecraftLoader::NEOFORGE => library::version::neoforge::get_versions_for_mc(&version).await?,
            _ => library::version::fabric::get_version_loaders_async(version)
                .await?
                .into_iter()
                .filter(|l| l.loader.stable)
                .map(|l| l.loader.version)
                .collect(),
        };
        Ok(serde_json::json!(versions))
    })
}

/// Reads the general "RAM Allocation" Game setting straight from `{path}/game.nihao` — used at
/// launch when the instance itself has "Use custom RAM" turned off. Read here on the Rust side
/// rather than trusting a value the frontend computes and passes in: that used to be how this
/// worked (a `ram_override` param), and it was a real bug — if the frontend's own copy of the
/// general RAM setting (loaded async, from the same file) hadn't finished loading yet by the
/// time Play was clicked, the override silently came through as `None` and the launch fell
/// back to `profile.max_ram` — a stale value left over from whenever "use custom RAM" was last
/// turned on, not the general setting the player actually configured. Reading the file directly
/// here has no such race.
fn general_ram_setting(path: &str) -> Option<u32> {
    let content = std::fs::read_to_string(Path::new(path).join("game.nihao")).ok()?;
    let json: serde_json::Value = serde_json::from_str(&content).ok()?;
    json.get("ram")?.as_u64().map(|v| v as u32)
}

/// `nickname` comes from the plugin's "Nickname" setting (`get_config`'s `settingsFields`,
/// persisted at `{gamePath}/game.nihao` on the launcher side) — falls back to "Player" if
/// unset, same as `MinecraftInstance::new` does for an empty one.
pub fn play_modpack(path: String, name: String, nickname: Option<String>) -> Result<serde_json::Value, String> {
    let mut child = runtime().block_on(async {
        let dir = instance_dir(&path, &name);
        let profile = MinecraftProfile::load(&dir)
            .await
            .map_err(|e| format!("Instance '{}' not found: {}", name, e))?;

        let mut instance = build_instance(&path, &name, &profile, nickname.as_deref().unwrap_or("Player"));
        if !profile.use_custom_ram {
            if let Some(ram) = general_ram_setting(&path) {
                instance.option.max_ram = ram;
            }
        }
        instance.build().await
    })?;

    let log = Arc::new(Mutex::new(Vec::new()));
    if let Some(stdout) = child.stdout.take() {
        spawn_log_reader(stdout, log.clone());
    }
    if let Some(stderr) = child.stderr.take() {
        spawn_log_reader(stderr, log.clone());
    }

    running_state().lock().unwrap().insert(name.clone(), RunningProcess { child, log });

    Ok(serde_json::json!({ "status": "ok" }))
}

/// Polled by the Play page while an instance is running — reports whether the process is
/// still alive plus its captured stdout/stderr, and drops it from `running_state` once it
/// has exited on its own (so `running` correctly flips back to false without a Close click).
///
/// The log is read out *before* any removal happens below — otherwise the exact poll that
/// notices the process died (e.g. a launch crash) would also wipe the log it needs to show.
pub fn get_launch_log(name: String) -> Result<serde_json::Value, String> {
    let mut state = running_state().lock().unwrap();

    let log = state
        .get(&name)
        .map(|p| p.log.lock().unwrap().clone())
        .unwrap_or_default();

    let mut running = state.contains_key(&name);
    if let Some(process) = state.get_mut(&name) {
        if matches!(process.child.try_wait(), Ok(Some(_))) {
            state.remove(&name);
            running = false;
        }
    }

    Ok(serde_json::json!({ "running": running, "log": log }))
}

/// Updates an existing instance's "Install" settings (RAM, java path, extra JVM args).
/// Takes effect on the next launch without needing a reinstall — `build()` reads these
/// fresh every time from the profile via `build_instance`, none of it is baked into the
/// cached `launch.nihao`.
pub fn update_modpack_settings(
    path: String,
    name: String,
    max_ram: u32,
    min_ram: u32,
    use_custom_ram: bool,
    java_path: Option<String>,
    jvm_arguments: String,
) -> Result<serde_json::Value, String> {
    let dir = instance_dir(&path, &name);
    runtime().block_on(async {
        let mut profile = MinecraftProfile::load(&dir)
            .await
            .map_err(|e| format!("Instance '{}' not found: {}", name, e))?;
        profile.max_ram = max_ram;
        profile.min_ram = min_ram;
        profile.use_custom_ram = use_custom_ram;
        profile.java_path = java_path;
        profile.jvm_arguments = jvm_arguments;
        profile.save(&dir).await?;
        Ok(serde_json::json!({ "status": "ok" }))
    })
}

/// Renames an instance's *display* name only — the internal id (its directory name, used
/// as the key for `running_state`/`install_state`/`instance_dir`) never changes, which keeps
/// this safe to call while an install or the game itself is running.
pub fn rename_modpack(path: String, name: String, display_name: String) -> Result<serde_json::Value, String> {
    let dir = instance_dir(&path, &name);
    runtime().block_on(async {
        let mut profile = MinecraftProfile::load(&dir)
            .await
            .map_err(|e| format!("Instance '{}' not found: {}", name, e))?;
        profile.display_name = display_name;
        profile.save(&dir).await?;
        Ok(serde_json::json!({ "status": "ok" }))
    })
}

/// Opens an instance's directory in the OS file explorer — same plain `Command`-based
/// approach the old (pre-rewrite) client used, no Tauri shell API needed (this plugin has no
/// `tauri` dependency at all; it's a bare Rust dylib loaded via `libloading`).
pub fn open_modpack_folder(path: String, name: String) -> Result<serde_json::Value, String> {
    let dir = instance_dir(&path, &name);
    std::fs::create_dir_all(&dir).map_err(|e| format!("Cannot create instance folder: {}", e))?;

    let mut command = if cfg!(target_os = "windows") {
        Command::new("explorer")
    } else if cfg!(target_os = "macos") {
        Command::new("open")
    } else {
        Command::new("xdg-open")
    };
    command
        .arg(&dir)
        .spawn()
        .map_err(|e| format!("Cannot open folder: {}", e))?;

    Ok(serde_json::json!({ "status": "ok" }))
}

/// The top-level folders/files in an instance, for the Share modal's "what to include"
/// checklist. See `library::modpack_format::list_top_level_entries`.
pub fn list_export_entries(path: String, name: String) -> Result<Vec<library::modpack_format::ExportEntry>, String> {
    let dir = instance_dir(&path, &name);
    library::modpack_format::list_top_level_entries(&dir)
}

/// One file/folder in a content-manager listing — a resourcepack/datapack can be either a
/// `.zip` or an unpacked folder, hence `is_dir`; a mod jar or shaderpack zip never is.
/// `display_name`/`version`/`icon_data` come from `library::content_cache::resolve_content` —
/// `None` for anything neither the file itself nor Modrinth could identify. `enabled` is
/// `false` only for a mod renamed to `*.jar.disabled` (see `toggle_content_file`) — always
/// `true` for the other three categories, which have no such convention.
#[derive(Serialize, Clone)]
pub struct ContentEntry {
    pub name: String,
    pub size: u64,
    pub is_dir: bool,
    pub enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon_data: Option<String>,
    /// Only set when this entry's metadata came from a Modrinth lookup (see
    /// `ResolvedContent::project_id`) — used by the frontend to show "Installed" instead of
    /// "Install" on a Browse content search hit that matches.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
}

#[derive(Serialize)]
pub struct ContentLists {
    pub mods: Vec<ContentEntry>,
    pub resourcepacks: Vec<ContentEntry>,
    pub shaderpacks: Vec<ContentEntry>,
    pub datapacks: Vec<ContentEntry>,
}

/// Lists `{instance_dir}/{category}` and resolves each entry's display name/version/icon via
/// `library::content_cache::resolve_content` — cached against `cache.nihao`, with a Modrinth
/// lookup fallback for whatever the file itself doesn't provide, so this only does real work
/// for files that are new or changed since the last call. For `category == "mods"`, the
/// `.disabled` suffix (see `toggle_content_file`) doesn't stop a file from still being a valid
/// jar to read.
async fn list_content_entries(
    category: &str,
    instance_dir: &Path,
    on_progress: &(dyn Fn(usize, usize) + Send + Sync),
) -> Vec<ContentEntry> {
    let dir = instance_dir.join(category);
    let mut raw: Vec<(String, bool, u64, std::fs::Metadata)> = Vec::new();
    if dir.exists() {
        if let Ok(read_dir) = std::fs::read_dir(&dir) {
            for entry in read_dir.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
                if let Ok(meta) = entry.metadata() {
                    let size = if is_dir { 0 } else { meta.len() };
                    raw.push((name, is_dir, size, meta));
                }
            }
        }
    }

    let lookup_files: Vec<(String, bool, std::fs::Metadata)> = raw
        .iter()
        .filter(|(name, is_dir, _, _)| {
            if category != "mods" {
                return true;
            }
            if *is_dir {
                return false;
            }
            let lower = name.to_lowercase();
            lower.ends_with(".jar") || lower.ends_with(".jar.disabled")
        })
        .map(|(name, is_dir, _, meta)| (name.clone(), *is_dir, meta.clone()))
        .collect();

    let resolved = library::content_cache::resolve_content(category, instance_dir, &lookup_files, on_progress).await;

    let mut out: Vec<ContentEntry> = raw
        .into_iter()
        .map(|(name, is_dir, size, _)| {
            let info = resolved.get(&name);
            ContentEntry {
                enabled: category != "mods" || !name.to_lowercase().ends_with(".disabled"),
                display_name: info.and_then(|r| r.display_name.clone()),
                version: info.and_then(|r| r.version.clone()),
                icon_data: info.and_then(|r| r.icon_data.clone()),
                project_id: info.and_then(|r| r.project_id.clone()),
                name,
                size,
                is_dir,
            }
        })
        .collect();
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    out
}

/// The "Content manager" action's data — every mod/resourcepack/shaderpack/datapack currently
/// in the instance, for browsing (no add/remove yet beyond `toggle_content_file`/
/// `delete_content_file` — see `search_modrinth_content`/`install_modrinth_content` for adding
/// new ones). A missing folder (e.g. no shaderpacks installed) just yields an empty list rather
/// than an error. Blocks until every category is fully resolved — fine once `cache.nihao` is
/// warm, but the *first* scan of a freshly-imported modpack (parsing/hashing/Modrinth-looking-up
/// a hundred-plus mods) can take several seconds; see `start_content_scan` for a version of this
/// same work that reports progress instead of just leaving the caller waiting.
pub fn list_content(path: String, name: String) -> Result<ContentLists, String> {
    let dir = instance_dir(&path, &name);
    runtime().block_on(async {
        let noop = |_: usize, _: usize| {};
        Ok(ContentLists {
            mods: list_content_entries("mods", &dir, &noop).await,
            resourcepacks: list_content_entries("resourcepacks", &dir, &noop).await,
            shaderpacks: list_content_entries("shaderpacks", &dir, &noop).await,
            datapacks: list_content_entries("datapacks", &dir, &noop).await,
        })
    })
}

/// One category's progress within a `start_content_scan` run.
#[derive(Clone, Serialize)]
struct ContentScanProgress {
    category: String,
    current: usize,
    total: usize,
}

/// Tracks `start_content_scan` background runs so `get_content_scan_status` can report progress
/// (while running), the finished list (once), or the failure (once) — separate from
/// `install_state()` since this powers the Content manager panel's own loading state rather
/// than the bottom `.progress` bar.
#[derive(Default)]
struct ContentScanState {
    progress: HashMap<String, ContentScanProgress>,
    results: HashMap<String, ContentLists>,
    errors: HashMap<String, String>,
}

fn content_scan_state() -> &'static Mutex<ContentScanState> {
    static STATE: OnceLock<Mutex<ContentScanState>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(ContentScanState::default()))
}

/// Same data as `list_content`, but run in the background with progress reported through
/// `get_content_scan_status` — the Content manager panel polls that instead of just showing an
/// indefinite "Loading..." for however long the first scan of a freshly-imported modpack takes.
/// `name` is the state key — a second scan for the same instance while one's already running
/// just restarts it (matches `reload()`'s "always show the latest state" behavior elsewhere in
/// this panel).
pub fn start_content_scan(path: String, name: String) -> Result<serde_json::Value, String> {
    let dir = instance_dir(&path, &name);
    {
        let mut state = content_scan_state().lock().unwrap();
        state.results.remove(&name);
        state.errors.remove(&name);
        state.progress.insert(name.clone(), ContentScanProgress { category: String::new(), current: 0, total: 0 });
    }

    let name_bg = name.clone();
    std::thread::spawn(move || {
        let lists = runtime().block_on(async {
            let mut lists = ContentLists { mods: Vec::new(), resourcepacks: Vec::new(), shaderpacks: Vec::new(), datapacks: Vec::new() };
            for category in ["mods", "resourcepacks", "shaderpacks", "datapacks"] {
                let category_owned = category.to_string();
                let name_progress = name_bg.clone();
                let on_progress = move |current: usize, total: usize| {
                    content_scan_state().lock().unwrap().progress.insert(
                        name_progress.clone(),
                        ContentScanProgress { category: category_owned.clone(), current, total },
                    );
                };
                let entries = list_content_entries(category, &dir, &on_progress).await;
                match category {
                    "mods" => lists.mods = entries,
                    "resourcepacks" => lists.resourcepacks = entries,
                    "shaderpacks" => lists.shaderpacks = entries,
                    _ => lists.datapacks = entries,
                }
            }
            lists
        });

        let mut state = content_scan_state().lock().unwrap();
        state.progress.remove(&name_bg);
        state.results.insert(name_bg, lists);
    });

    Ok(serde_json::json!({ "status": "scanning" }))
}

/// Polled by the Content manager panel while `start_content_scan` runs. `results`/`errors` are
/// each taken (removed) on read — the panel stops polling once it sees `"done"`/`"error"`, so
/// there's nothing else that would need them a second time, and clearing them keeps this from
/// silently replaying a stale result for a *later* scan that hasn't finished yet.
pub fn get_content_scan_status(name: String) -> Result<serde_json::Value, String> {
    let mut state = content_scan_state().lock().unwrap();
    if let Some(lists) = state.results.remove(&name) {
        return Ok(serde_json::json!({ "status": "done", "lists": lists }));
    }
    if let Some(error) = state.errors.remove(&name) {
        return Ok(serde_json::json!({ "status": "error", "error": error }));
    }
    if let Some(p) = state.progress.get(&name) {
        return Ok(serde_json::json!({ "status": "scanning", "category": p.category, "current": p.current, "total": p.total }));
    }
    Ok(serde_json::json!({ "status": "idle" }))
}

fn content_category_dir(instance_dir: &Path, category: &str) -> Result<PathBuf, String> {
    match category {
        "mods" | "resourcepacks" | "shaderpacks" | "datapacks" => Ok(instance_dir.join(category)),
        other => Err(format!("Unknown content category '{}'", other)),
    }
}

/// Enables/disables a mod by renaming it to/from `*.jar.disabled` — every loader (Fabric,
/// Forge, NeoForge) only loads files literally ending in `.jar` from `mods/`, so this suffix
/// disables a mod for all of them uniformly without needing loader-specific handling, and is
/// the same convention other launchers (Prism, MultiMC) already use.
pub fn toggle_content_file(path: String, name: String, category: String, filename: String) -> Result<serde_json::Value, String> {
    let dir = content_category_dir(&instance_dir(&path, &name), &category)?;
    let src = dir.join(&filename);
    let new_name = match filename.strip_suffix(".disabled") {
        Some(stripped) => stripped.to_string(),
        None => format!("{}.disabled", filename),
    };
    std::fs::rename(&src, dir.join(&new_name))
        .map_err(|e| format!("Cannot toggle '{}': {}", filename, e))?;
    Ok(serde_json::json!({ "status": "ok", "name": new_name }))
}

/// Deletes one file/folder from `mods`/`resourcepacks`/`shaderpacks`/`datapacks`.
pub fn delete_content_file(path: String, name: String, category: String, filename: String) -> Result<serde_json::Value, String> {
    let dir = content_category_dir(&instance_dir(&path, &name), &category)?;
    let target = dir.join(&filename);
    if target.is_dir() {
        std::fs::remove_dir_all(&target).map_err(|e| format!("Cannot delete '{}': {}", filename, e))?;
    } else {
        std::fs::remove_file(&target).map_err(|e| format!("Cannot delete '{}': {}", filename, e))?;
    }
    Ok(serde_json::json!({ "status": "ok" }))
}

/// "Browse content" — searches Modrinth for `query`, scoped to `category`'s project type and
/// (best-effort) the instance's own game version/loader, so results are actually installable
/// rather than a generic, mostly-incompatible list. See `library::modrinth_browse::search`.
pub fn search_modrinth_content(
    path: String,
    name: String,
    category: String,
    query: String,
    offset: u32,
    limit: u32,
    sort: String,
    categories: Vec<String>,
    environments: Vec<String>,
) -> Result<library::modrinth_browse::BrowseSearchResult, String> {
    let dir = instance_dir(&path, &name);
    let profile = runtime()
        .block_on(MinecraftProfile::load(&dir))
        .map_err(|e| format!("Instance '{}' not found: {}", name, e))?;
    runtime().block_on(library::modrinth_browse::search(
        &category,
        query,
        &profile.version_id,
        &profile.core.to_string(),
        offset,
        limit,
        &sort,
        &categories,
        &environments,
    ))
}

/// The filter categories Browse content's filters panel offers for `category` — see
/// `library::modrinth_browse::categories`. Doesn't need the instance's profile (unlike search/
/// install) since Modrinth's category taxonomy isn't game-version/loader-specific.
pub fn list_modrinth_categories(category: String) -> Result<Vec<String>, String> {
    runtime().block_on(library::modrinth_browse::categories(&category))
}

/// The "open a mod" detail view's data — see `library::modrinth_browse::project_detail`.
pub fn get_modrinth_project(project_id: String) -> Result<library::modrinth_browse::ProjectDetail, String> {
    runtime().block_on(library::modrinth_browse::project_detail(&project_id))
}

/// The `active`/`last_error` key a Modrinth content install is tracked under — distinct from a
/// plain instance name so it reads clearly in the bottom `.progress` bar alongside real
/// installs/exports, same idea as `export_job_label`.
fn modrinth_install_job_label(title: &str) -> String {
    format!("{} (Modrinth)", title)
}

/// Downloads a "Browse content" search result's best-matching file straight into the instance —
/// see `library::modrinth_browse::install`. Runs in the background (like `export_modpack_own`)
/// and reports progress through the same `install_state()` the bottom `.progress` bar polls —
/// the frontend watches `get_install_status`/`modrinth_install_job_label(title)` disappearing to
/// know it's done, then re-lists the category, which picks the new file up through the normal
/// `content_cache` path (so it gets a real, cached name/icon rather than this command needing to
/// invent one). `title` is the frontend's own display name for the mod/pack being installed —
/// purely cosmetic (the bottom bar's label), Modrinth itself is only ever looked up by
/// `project_id`.
pub fn install_modrinth_content(path: String, name: String, category: String, project_id: String, title: String) -> Result<serde_json::Value, String> {
    let dir = instance_dir(&path, &name);
    let profile = runtime()
        .block_on(MinecraftProfile::load(&dir))
        .map_err(|e| format!("Instance '{}' not found: {}", name, e))?;

    let label = modrinth_install_job_label(&title);
    {
        let mut state = install_state().lock().unwrap();
        state.active.insert(label.clone(), InstallProgress {
            name: label.clone(),
            etap: "Queued".to_string(),
            current_etaps: 0,
            total_etaps: 3,
            current_file: 0,
            total_files: 0,
            status: "check".to_string(),
            filename: String::new(),
        });
    }

    let label_bg = label.clone();
    std::thread::spawn(move || {
        let result = runtime().block_on(library::modrinth_browse::install(
            &category,
            &dir,
            &project_id,
            &profile.version_id,
            &profile.core.to_string(),
            &job_progress_callback(label_bg.clone()),
        ));

        let mut state = install_state().lock().unwrap();
        state.active.remove(&label_bg);
        if let Err(e) = &result {
            eprintln!("[minecraft] Modrinth install failed for '{}': {}", label_bg, e);
            state.last_error = Some((label_bg.clone(), e.clone()));
        }
    });

    Ok(serde_json::json!({ "status": "installing" }))
}

/// The `active`/`last_error` key an export job is tracked under — distinct from a plain
/// instance name (which `create_modpack` uses) so an export running alongside an actual
/// install of the same instance doesn't clobber its entry, and so it reads clearly in the
/// bottom `.progress` bar (`InstallProgress.name` is shown verbatim there).
fn export_job_label(name: &str) -> String {
    format!("{} (export)", name)
}

/// Turns `library::export`/`library::import`'s format-agnostic progress ticks into
/// `install_state()` updates — the same shared state `get_install_status`/the bottom
/// `.progress` bar already poll for real installs, so an export or import just shows up there
/// too with no frontend changes needed.
fn job_progress_callback(label: String) -> library::export::ProgressCallback {
    std::sync::Arc::new(move |p: library::export::ExportProgress| {
        install_state().lock().unwrap().active.insert(
            label.clone(),
            InstallProgress {
                name: label.clone(),
                etap: p.etap,
                current_etaps: p.current_etaps,
                total_etaps: p.total_etaps,
                current_file: p.current_file,
                total_files: p.total_files,
                status: p.status,
                filename: p.filename,
            },
        );
    })
}

/// Exports an instance as a self-contained archive in this project's own format (manifest +
/// every file's bytes, bundled) — the "Share" action's first option. `include` is the set of
/// top-level folder/file names the player checked in the Share modal (from
/// `list_export_entries`). Runs in the background (like `create_modpack`) and reports progress
/// through the same `install_state()` the bottom `.progress` bar polls — the frontend watches
/// `get_install_status`/`export_job_label(name)` disappearing to know it's done. See
/// `library::export::export_own_format` and MODPACK_FORMAT.md.
pub fn export_modpack_own(path: String, name: String, include: Vec<String>, dest_path: String) -> Result<serde_json::Value, String> {
    let dir = instance_dir(&path, &name);
    let profile = runtime()
        .block_on(MinecraftProfile::load(&dir))
        .map_err(|e| format!("Instance '{}' not found: {}", name, e))?;

    let (id, pack_name, build, version) = match &profile.pack {
        Some(pack) => (pack.id.clone(), pack.name.clone(), pack.build, pack.version.clone()),
        None => (name.clone(), profile.display_name.clone(), 1, None),
    };

    let label = export_job_label(&name);
    {
        let mut state = install_state().lock().unwrap();
        state.active.insert(label.clone(), InstallProgress {
            name: label.clone(),
            etap: "Queued".to_string(),
            current_etaps: 0,
            total_etaps: 2,
            current_file: 0,
            total_files: 0,
            status: "check".to_string(),
            filename: String::new(),
        });
    }

    let label_bg = label.clone();
    let name_bg = name.clone();
    std::thread::spawn(move || {
        let result = runtime().block_on(library::export::export_own_format(
            dir,
            id,
            pack_name,
            build,
            version,
            profile.version_id.clone(),
            profile.core.clone(),
            profile.loader_version.clone(),
            include.into_iter().collect(),
            PathBuf::from(dest_path),
            job_progress_callback(label_bg.clone()),
        ));

        let mut state = install_state().lock().unwrap();
        state.active.remove(&label_bg);
        if let Err(e) = &result {
            eprintln!("[minecraft] Export failed for '{}': {}", name_bg, e);
            state.last_error = Some((label_bg.clone(), e.clone()));
        }
    });

    Ok(serde_json::json!({ "status": "exporting" }))
}

/// Exports an instance as a standard Modrinth `.mrpack` — the "Share" action's second option.
/// `include` is the set of top-level folder/file names the player checked in the Share modal
/// (from `list_export_entries`). Same background-job/progress-polling shape as
/// `export_modpack_own` above. See `library::export::export_mrpack` and MODPACK_FORMAT.md.
pub fn export_modpack_mrpack(path: String, name: String, include: Vec<String>, dest_path: String) -> Result<serde_json::Value, String> {
    let dir = instance_dir(&path, &name);
    let profile = runtime()
        .block_on(MinecraftProfile::load(&dir))
        .map_err(|e| format!("Instance '{}' not found: {}", name, e))?;

    let version_label = profile
        .pack
        .as_ref()
        .and_then(|p| p.version.clone())
        .unwrap_or_else(|| "1.0.0".to_string());

    let label = export_job_label(&name);
    {
        let mut state = install_state().lock().unwrap();
        state.active.insert(label.clone(), InstallProgress {
            name: label.clone(),
            etap: "Queued".to_string(),
            current_etaps: 0,
            total_etaps: 3,
            current_file: 0,
            total_files: 0,
            status: "check".to_string(),
            filename: String::new(),
        });
    }

    let label_bg = label.clone();
    let name_bg = name.clone();
    std::thread::spawn(move || {
        let result = runtime().block_on(library::export::export_mrpack(
            dir,
            profile.display_name.clone(),
            version_label,
            profile.version_id.clone(),
            profile.core.clone(),
            profile.loader_version.clone(),
            include.into_iter().collect(),
            PathBuf::from(dest_path),
            job_progress_callback(label_bg.clone()),
        ));

        let mut state = install_state().lock().unwrap();
        state.active.remove(&label_bg);
        if let Err(e) = &result {
            eprintln!("[minecraft] Export failed for '{}': {}", name_bg, e);
            state.last_error = Some((label_bg.clone(), e.clone()));
        }
    });

    Ok(serde_json::json!({ "status": "exporting" }))
}

/// Parses a `.nihaopack`/`.mrpack` file's metadata (name/game version/loader) without
/// extracting or downloading anything — fast enough to run as soon as the player picks a file
/// in the "Install modpack" screen, to populate/preview the instance name before they commit.
pub fn peek_modpack_file(source_path: String) -> Result<library::import::ImportPreview, String> {
    library::import::peek(Path::new(&source_path))
}

/// Imports a `.nihaopack`/`.mrpack` file as a new instance — the "Install modpack" action's
/// counterpart to Share. `source_path` is a file picked via a native open dialog (like Share's
/// save dialog); `name` is the instance name to create (from `peek_modpack_file`'s preview,
/// editable by the player). Same background-job/progress-polling shape as `create_modpack`,
/// which this reuses directly for the second half: neither pack format bundles the actual
/// Minecraft client/libraries/assets, only mods/configs/resourcepacks, so after unzipping/
/// downloading the pack's own content this runs the exact same install pipeline
/// `create_modpack` does to fetch the rest. See `library::import` and MODPACK_FORMAT.md.
pub fn import_modpack(path: String, name: String, source_path: String) -> Result<serde_json::Value, String> {
    let dir = instance_dir(&path, &name);
    let preview = library::import::peek(Path::new(&source_path))?;

    let profile = MinecraftProfile {
        display_name: name.clone(),
        version_id: preview.minecraft_version.clone(),
        core: MinecraftLoader::from_str(&preview.loader),
        loader_version: preview.loader_version.clone(),
        max_ram: 2048,
        min_ram: 512,
        use_custom_ram: false,
        java_path: None,
        jvm_arguments: String::new(),
        icon: None,
        banner: None,
        pack: None,
    };
    runtime().block_on(profile.save(&dir))?;

    let label = name.clone();
    {
        let mut state = install_state().lock().unwrap();
        state.active.insert(label.clone(), InstallProgress {
            name: label.clone(),
            etap: "Queued".to_string(),
            current_etaps: 0,
            total_etaps: 1,
            current_file: 0,
            total_files: 0,
            status: "check".to_string(),
            filename: String::new(),
        });
    }

    let dir_bg = dir.clone();
    let path_bg = path.clone();
    let name_bg = name.clone();
    let label_bg = label.clone();
    let source_bg = PathBuf::from(source_path);
    let format = preview.format.clone();
    std::thread::spawn(move || {
        let result: Result<(), String> = runtime().block_on(async {
            if format == "own" {
                let manifest = library::import::import_own_format(
                    dir_bg.clone(),
                    source_bg,
                    job_progress_callback(label_bg.clone()),
                )
                .await?;

                // Now that we have the real manifest (not just peek()'s summary), track it as
                // this instance's pack — same as generate_modpack_manifest/an own-format
                // export round-tripping back in.
                let mut profile = MinecraftProfile::load(&dir_bg).await?;
                profile.pack = Some(manifest);
                profile.save(&dir_bg).await?;
            } else {
                library::import::import_mrpack(
                    dir_bg.clone(),
                    source_bg,
                    job_progress_callback(label_bg.clone()),
                )
                .await?;
            }

            // The pack file only ever supplied mods/configs/resourcepacks — still need the
            // actual client/libraries/assets/Java, exactly like a from-scratch create_modpack.
            let profile = MinecraftProfile::load(&dir_bg).await?;
            let mut instance = build_instance(&path_bg, &name_bg, &profile, "Player");
            let (mut stream, handle) = instance.install_stream().await?;
            while let Some(info) = stream.next().await {
                install_state().lock().unwrap().active.insert(
                    label_bg.clone(),
                    InstallProgress::from_info(&label_bg, &info),
                );
            }
            handle.await.map_err(|e| format!("Install task panicked: {}", e))?
        });

        let mut state = install_state().lock().unwrap();
        state.active.remove(&label_bg);
        match &result {
            Ok(()) => println!("[minecraft] Import finished for '{}'.", name_bg),
            Err(e) => {
                eprintln!("[minecraft] Import failed for '{}': {}", name_bg, e);
                state.last_error = Some((label_bg.clone(), e.clone()));
            }
        }
    });

    Ok(serde_json::json!({ "status": "installing", "name": name }))
}

/// Deletes an instance permanently. Kills the game first if it's currently running for this
/// instance — Windows refuses to delete files a running process still has open.
pub fn delete_modpack(path: String, name: String) -> Result<serde_json::Value, String> {
    if let Some(mut process) = running_state().lock().unwrap().remove(&name) {
        let _ = process.child.kill();
        let _ = process.child.wait();
    }
    let dir = instance_dir(&path, &name);
    runtime().block_on(tokio::fs::remove_dir_all(&dir))
        .map_err(|e| format!("Cannot delete instance '{}': {}", name, e))?;
    Ok(serde_json::json!({ "status": "ok" }))
}

/// Copies an instance (saves, mods, config, profile — everything) to a new instance
/// directory under a new internal name. Refuses to overwrite an existing instance.
pub fn duplicate_modpack(path: String, name: String, new_name: String) -> Result<serde_json::Value, String> {
    let src_dir = instance_dir(&path, &name);
    let dst_dir = instance_dir(&path, &new_name);
    if dst_dir.exists() {
        return Err(format!("An instance named '{}' already exists", new_name));
    }
    copy_dir_recursive(&src_dir, &dst_dir)?;

    runtime().block_on(async {
        let mut profile = MinecraftProfile::load(&dst_dir)
            .await
            .map_err(|e| format!("Duplicated instance has no valid profile: {}", e))?;
        profile.display_name = new_name.clone();
        profile.save(&dst_dir).await
    })?;

    Ok(serde_json::json!({ "status": "ok", "name": new_name }))
}

const ICON_FILE_NAME: &str = "icon";
const BANNER_FILE_NAME: &str = "banner";

/// Copies a user-picked image file into the instance directory as its icon, always as a
/// plain `icon` file (no extension) — the source's actual bytes are kept as-is, just renamed,
/// so whatever format it was in still displays fine (browsers sniff image content, not the
/// filename).
pub fn set_modpack_icon(path: String, name: String, icon_source_path: String) -> Result<serde_json::Value, String> {
    let dir = instance_dir(&path, &name);
    let src = Path::new(&icon_source_path);

    runtime().block_on(async {
        let mut profile = MinecraftProfile::load(&dir)
            .await
            .map_err(|e| format!("Instance '{}' not found: {}", name, e))?;

        tokio::fs::copy(&src, dir.join(ICON_FILE_NAME))
            .await
            .map_err(|e| format!("Cannot copy icon file: {}", e))?;

        profile.icon = Some(ICON_FILE_NAME.to_string());
        profile.save(&dir).await?;
        Ok(serde_json::json!({ "status": "ok", "icon_data": image_data_uri(&dir, &Some(ICON_FILE_NAME.to_string())) }))
    })
}

/// Same as `set_modpack_icon`, but for the banner shown on the instance's tile in the modpack
/// list and as the launch page's backdrop (see `InstancesGrid`/`MinecraftLaunch` in the UI).
pub fn set_modpack_banner(path: String, name: String, banner_source_path: String) -> Result<serde_json::Value, String> {
    let dir = instance_dir(&path, &name);
    let src = Path::new(&banner_source_path);

    runtime().block_on(async {
        let mut profile = MinecraftProfile::load(&dir)
            .await
            .map_err(|e| format!("Instance '{}' not found: {}", name, e))?;

        tokio::fs::copy(&src, dir.join(BANNER_FILE_NAME))
            .await
            .map_err(|e| format!("Cannot copy banner file: {}", e))?;

        profile.banner = Some(BANNER_FILE_NAME.to_string());
        profile.save(&dir).await?;
        Ok(serde_json::json!({ "status": "ok", "banner_data": image_data_uri(&dir, &Some(BANNER_FILE_NAME.to_string())) }))
    })
}

/// Kills a running instance's java process (the "Close" button).
pub fn close_modpack(name: String) -> Result<serde_json::Value, String> {
    if let Some(mut process) = running_state().lock().unwrap().remove(&name) {
        let _ = process.child.kill();
        let _ = process.child.wait();
    }
    Ok(serde_json::json!({ "status": "ok" }))
}

/// Scans an instance and writes/overwrites its tracked pack manifest (the `pack` field on
/// `profile.nihao`, see `library::profile::MinecraftProfile`) — the "publish this as a
/// distributable pack" action (a player packaging their own instance to share/host) as well
/// as the refresh step after applying a diff, so the saved manifest always matches what's
/// actually on disk. See MODPACK_FORMAT.md for the format and `library::modpack_format`.
pub fn generate_modpack_manifest(
    path: String,
    name: String,
    id: String,
    pack_name: String,
    build: u64,
    version: Option<String>,
) -> Result<ModpackManifest, String> {
    let dir = instance_dir(&path, &name);
    runtime().block_on(async {
        let mut profile = MinecraftProfile::load(&dir)
            .await
            .map_err(|e| format!("Instance '{}' not found: {}", name, e))?;

        let manifest = generate_manifest(
            dir.clone(),
            id,
            pack_name,
            build,
            version,
            profile.version_id.clone(),
            profile.core.clone(),
            profile.loader_version.clone(),
        )
        .await?;

        profile.pack = Some(manifest.clone());
        profile.save(&dir).await?;
        Ok(manifest)
    })
}

/// The instance's currently tracked pack manifest, if it has one — `None` for a from-scratch
/// instance that was never generated/imported as a tracked pack.
pub fn get_modpack_manifest(path: String, name: String) -> Result<Option<ModpackManifest>, String> {
    let dir = instance_dir(&path, &name);
    let profile = runtime()
        .block_on(MinecraftProfile::load(&dir))
        .map_err(|e| format!("Instance '{}' not found: {}", name, e))?;
    Ok(profile.pack)
}

/// Compares the instance's tracked manifest (if any) against a `remote` manifest — fetched by
/// the frontend from the (future) server, hence passed in as raw JSON rather than fetched
/// here — and reports which files need downloading or deleting to match it.
pub fn diff_modpack_manifest(
    path: String,
    name: String,
    remote: serde_json::Value,
) -> Result<ModpackDiff, String> {
    let remote: ModpackManifest =
        serde_json::from_value(remote).map_err(|e| format!("Invalid remote manifest: {}", e))?;
    let dir = instance_dir(&path, &name);
    let profile = runtime()
        .block_on(MinecraftProfile::load(&dir))
        .map_err(|e| format!("Instance '{}' not found: {}", name, e))?;
    Ok(diff_manifests(profile.pack.as_ref(), &remote))
}
