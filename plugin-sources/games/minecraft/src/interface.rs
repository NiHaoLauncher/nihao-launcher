use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::Child;
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
    get_modpacks(),
    create_modpack(name: String, core: String, version: String, loader: Option<String>, nihao_client: Option<bool>),
    get_nihao_client(core: String, version: String),
    get_nihao_client_status(name: String),
    install_nihao_client(name: String),
    get_versions(core: String),
    get_loader_versions(core: String, version: String),
    play_modpack(name: String, nickname: Option<String>, profile_id: Option<String>, world: Option<String>, server: Option<String>),
    list_play_targets(name: String),
    ping_server(address: String),
    list_screenshots(),
    get_screenshot(instance: String, file: String),
    delete_screenshot(instance: String, file: String),
    save_screenshot_as(instance: String, file: String, dest_path: String),
    save_remote_image(service: String, url: String, dest_path: String),
    get_install_status(),
    get_launch_log(name: String),
    close_modpack(name: String),
    update_modpack_settings(name: String, max_ram: u32, min_ram: u32, use_custom_ram: bool, java_path: Option<String>, jvm_arguments: String),
    rename_modpack(name: String, display_name: String),
    refresh_modpack_source(name: String),
    delete_modpack(name: String),
    duplicate_modpack(name: String, new_name: String),
    set_modpack_icon(name: String, icon_source_path: String),
    set_modpack_banner(name: String, banner_source_path: String),
    generate_modpack_manifest(name: String, id: String, pack_name: String, build: u64, version: Option<String>),
    get_modpack_manifest(name: String),
    diff_modpack_manifest(name: String, remote: serde_json::Value),
    get_home_preview(),
    get_news(),
    get_install_icon(name: String),
    open_modpack_folder(name: String),
    reveal_in_folder(path: String),
    check_missing_files(name: String),
    delete_downloaded_files(name: String, files: Vec<library::missing_files::DownloadedCopy>),
    list_export_entries(name: String, path: Option<String>),
    export_modpack_own(name: String, include: Vec<String>, dest_path: String, mode: Option<String>),
    export_modpack_mrpack(name: String, include: Vec<String>, dest_path: String),
    peek_modpack_file(source_path: String),
    import_modpack(name: String, source_path: String, minecraft_version: Option<String>, loader: Option<String>, loader_version: Option<String>, icon_url: Option<String>, banner_url: Option<String>, source: Option<library::profile::ModpackSource>),
    sync_modpack(name: String, version_id: Option<String>, version_number: Option<String>),
    list_content_services(),
    search_modpacks(service: String, query: String, offset: u32, limit: u32, sort: String, minecraft_version: String, categories: Vec<String>, environments: Vec<String>, loaders: Vec<String>),
    list_modpack_versions(service: String, project_id: String),
    download_modpack(service: String, project_id: String, version_id: Option<String>),
    list_content(name: String),
    start_content_scan(name: String),
    get_content_scan_status(name: String),
    toggle_content_file(name: String, category: String, filename: String),
    delete_content_file(name: String, category: String, filename: String),
    search_content(service: String, name: String, category: String, query: String, offset: u32, limit: u32, sort: String, categories: Vec<String>, environments: Vec<String>),
    install_content(service: String, name: String, category: String, project_id: String, title: String),
    list_content_categories(service: String, category: String),
    get_content_project(service: String, project_id: String),
    get_profiles(),
    save_profiles(profiles: Vec<library::session::OfflineProfile>, default_profile_id: Option<String>),
    login_elyby(login: String, password: String),
    get_skin(nickname: String),
    get_cape(nickname: String),
    read_skin_file(path: String),
    list_online_modpacks(images: Option<bool>),
    install_online_modpack(name: String, id: String),
    register_online_modpack(name: String, visibility: String),
    publish_modpack_build(name: String, id: String, include: Vec<String>, version: Option<String>),
    get_modpack_publish_info(id: String),
    update_modpack_publish(id: String, name: Option<String>, visibility: Option<String>),
    invite_to_modpack_publish(id: String, login: String),
    get_modpack_permissions(),
    uninstall_paths(),
    unlink_modpack_publish(name: String),
    detach_modpack(name: String),
    delete_online_modpack(name: String, id: String)
];

/// A snapshot of one instance's install progress, polled by the launcher UI (the bottom
/// `.progress` bar and `InstallIndicator`'s mini spinners).
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
    /// Coarse job category the frontend keys an icon/label off, independent of free-text
    /// `etap`/`status`: `"download"`, `"upload"` (publishing a build), `"repair"` (re-verifying an
    /// installed instance), `"update"` (moving a service's pack to another build), `"deleting"`
    /// (reserved), or `"unknown"` (e.g. exporting to a local file).
    #[serde(rename = "type")]
    job_type: String,
}

impl InstallProgress {
    fn from_info(name: &str, info: &DownloadInfo, job_type: &str) -> Self {
        InstallProgress {
            name: name.to_string(),
            etap: info.etap.clone(),
            current_etaps: info.current_etaps,
            total_etaps: info.total_etaps,
            current_file: info.current_file,
            total_files: info.total_files,
            status: info.status.to_string(),
            filename: info.filename.clone(),
            job_type: job_type.to_string(),
        }
    }
}

/// Tracks background installs so the launcher UI can show an ambient "installing" indicator instead
/// of blocking `create_modpack`.
#[derive(Default)]
struct InstallState {
    active: HashMap<String, InstallProgress>,
    last_error: Option<(String, String)>,
}

fn install_state() -> &'static Mutex<InstallState> {
    static STATE: OnceLock<Mutex<InstallState>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(InstallState::default()))
}

/// Runs the install pipeline (Java, libraries, assets, client, loader) for the instance `name`,
/// whose profile is already saved, reporting each step under `label` as a `job_type` job.
async fn run_install(path: &str, name: &str, label: &str, job_type: &str) -> Result<(), String> {
    let profile = MinecraftProfile::load(&instance_dir(path, name)).await?;
    // Installing never launches the game, so the session/username here is unused — any
    // placeholder works.
    let mut instance = build_instance(path, name, &profile, "Player");
    let (mut stream, handle) = instance.install_stream().await?;
    while let Some(info) = stream.next().await {
        install_state().lock().unwrap_or_else(|e| e.into_inner()).active.insert(
            label.to_string(),
            InstallProgress::from_info(label, &info, job_type),
        );
    }
    handle.await.map_err(|e| format!("Install task panicked: {}", e))?
}

fn busy(label: &str) -> String {
    format!("'{label}' is busy with another job")
}

/// Fails if the background job `label` is running. Checked first by everything that would change an
/// instance's files or profile (install, import, delete, play): two jobs on the same instance write
/// the same `.part` files and the same `profile.nihao`.
fn ensure_idle(label: &str) -> Result<(), String> {
    if install_state().lock().unwrap_or_else(|e| e.into_inner()).active.contains_key(label) {
        return Err(busy(label));
    }
    Ok(())
}

/// Registers the background job `label` as "Queued" (the bottom bar and `InstallIndicator` show it
/// from here until `finish_job`). One job per label at a time.
fn begin_job(label: &str, total_etaps: usize, job_type: &str) -> Result<(), String> {
    let mut state = install_state().lock().unwrap_or_else(|e| e.into_inner());
    if state.active.contains_key(label) {
        return Err(busy(label));
    }
    state.active.insert(label.to_string(), InstallProgress {
        name: label.to_string(),
        etap: "Queued".to_string(),
        current_etaps: 0,
        total_etaps,
        current_file: 0,
        total_files: 0,
        status: "check".to_string(),
        filename: String::new(),
        job_type: job_type.to_string(),
    });
    Ok(())
}

/// Ends the background job `label`: drops it from the active list and keeps a failure for the UI
/// to report. A success also clears an earlier failure of the same instance — it isn't this job's.
fn finish_job(label: &str, what: &str, result: &Result<(), String>) {
    let mut state = install_state().lock().unwrap_or_else(|e| e.into_inner());
    state.active.remove(label);
    match result {
        Ok(()) => {
            println!("[minecraft] {} finished for '{}'.", what, label);
            if state.last_error.as_ref().is_some_and(|(n, _)| n == label) {
                state.last_error = None;
            }
        }
        Err(e) => {
            eprintln!("[minecraft] {} failed for '{}': {}", what, label, e);
            state.last_error = Some((label.to_string(), e.clone()));
        }
    }
}

/// A running instance's java process plus its captured stdout/stderr — the plugin call
/// boundary can't push a live log to the frontend, so the UI polls `get_launch_log` instead.
struct RunningProcess {
    child: Child,
    log: Arc<Mutex<Vec<String>>>,
    location: Arc<Mutex<Location>>,
}

/// Where the player is, from the client log (same lines on Fabric/NeoForge). Leaving a server logs
/// nothing we know of, so a server stays current until the next world or menu line.
#[derive(Clone, Default, PartialEq, Debug)]
enum Location {
    #[default]
    Menu,
    World(String),
    Server(String),
}

/// The save folder whose `session.lock` was written last: the world the integrated server just
/// opened, since it takes that lock on load. `None` if there are no saves.
fn newest_save(saves: &Path) -> Option<String> {
    std::fs::read_dir(saves)
        .ok()?
        .flatten()
        .filter_map(|e| Some((std::fs::metadata(e.path().join("session.lock")).ok()?.modified().ok()?, e.file_name().to_string_lossy().into_owned())))
        .max()
        .map(|(_, name)| name)
}

/// Updates `location` from one log line: `Starting integrated minecraft server` = a singleplayer
/// world is opening (its name is not in the log, see `newest_save`; `Preparing level "<world>"` names
/// it where the game prints that), `Connecting to <host>, <port>` = joining a server, `Stopping server`/`Stopping singleplayer
/// server` = back to the menu.
fn track_location(line: &str, location: &mut Location) {
    if line.contains("Starting integrated minecraft server") {
        *location = Location::World(String::new());
    } else if let Some(rest) = line.split("Preparing level \"").nth(1) {
        if let Some(world) = rest.strip_suffix('"') {
            *location = Location::World(world.to_string());
        }
    } else if let Some(rest) = line.split("Connecting to ").nth(1) {
        // Mods log their own "Connecting to ..." lines (Discord, voice chat); the game's is `host, port`.
        if let Some((host, port)) = rest.split_once(", ") {
            if !host.contains(' ') && !port.is_empty() && port.bytes().all(|b| b.is_ascii_digit()) {
                *location = Location::Server(if port == "25565" { host.to_string() } else { format!("{host}:{port}") });
            }
        }
    } else if line.contains("]: Stopping server") || line.contains("Stopping singleplayer server") {
        *location = Location::Menu;
    }
}

fn running_state() -> &'static Mutex<HashMap<String, RunningProcess>> {
    static STATE: OnceLock<Mutex<HashMap<String, RunningProcess>>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(HashMap::new()))
}

const LOG_LINE_CAP: usize = 2000;

/// Reads `reader` line-by-line into `log` on a background thread until the pipe closes
/// (i.e. the process exits or is killed).
fn spawn_log_reader<R: Read + Send + 'static>(reader: R, log: Arc<Mutex<Vec<String>>>, location: Arc<Mutex<Location>>) {
    std::thread::spawn(move || {
        // Raw bytes, not `lines()`: a line that isn't valid UTF-8 (a legacy code page) would end
        // the loop, nobody would drain the pipe any more, and the game would block on its next write.
        let mut reader = BufReader::new(reader);
        let mut buf = Vec::new();
        loop {
            buf.clear();
            match reader.read_until(b'\n', &mut buf) {
                Ok(0) | Err(_) => break,
                Ok(_) => {}
            }
            let line = String::from_utf8_lossy(&buf).trim_end().to_string();
            println!("[minecraft:client] {}", line);
            track_location(&line, &mut location.lock().unwrap_or_else(|e| e.into_inner()));
            let mut log = log.lock().unwrap_or_else(|e| e.into_inner());
            log.push(line);
            let len = log.len();
            if len > LOG_LINE_CAP {
                log.drain(0..len - LOG_LINE_CAP);
            }
        }
    });
}

/// The FFI boundary (`GameSupport::call`) is synchronous, so all async install/launch/manifest code
/// in `library/` is driven through this one process-wide blocking runtime.
pub(crate) fn runtime() -> &'static tokio::runtime::Runtime {
    static RUNTIME: OnceLock<tokio::runtime::Runtime> = OnceLock::new();
    RUNTIME.get_or_init(|| {
        tokio::runtime::Runtime::new().expect("Failed to start Minecraft plugin runtime")
    })
}

/// `{configured game path}/instances/{name}`: the per-instance run directory (saves, mods,
/// `profile.nihao`). `versions`/`assets`/`libraries`/`runtime` stay shared at the root.
fn instance_dir(path: &str, name: &str) -> PathBuf {
    // shortcut: a name with path parts ("../x") is cut down to its last part instead of rejected,
    // so it can't leave `instances/`; give names a real validation if collisions ever matter.
    let name = Path::new(name).file_name().unwrap_or_else(|| std::ffi::OsStr::new("_"));
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

/// The largest icon or banner an instance keeps (see `image_data_uri`).
const MAX_IMAGE_BYTES: u64 = 4 * 1024 * 1024;

fn check_image_size(source: &Path) -> Result<(), String> {
    let size = std::fs::metadata(source).map_err(|e| format!("Cannot read the image: {e}"))?.len();
    if size > MAX_IMAGE_BYTES {
        return Err(format!("The image is too big ({} MB, at most {} MB). Pick a smaller one.", size / (1024 * 1024), MAX_IMAGE_BYTES / (1024 * 1024)));
    }
    Ok(())
}

/// Base64 data URI for an instance's custom icon/banner, read fresh each time. Neither file has an
/// extension, so the MIME type is only a hint; browsers sniff the content.
fn image_data_uri(dir: &Path, filename: &Option<String>) -> Option<String> {
    let path = dir.join(filename.as_ref()?);
    // The list of instances carries every icon and banner at once; one huge picture would make it huge.
    if std::fs::metadata(&path).ok()?.len() > MAX_IMAGE_BYTES {
        return None;
    }
    let bytes = std::fs::read(path).ok()?;
    use base64::Engine;
    Some(format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)))
}

/// Writes a fetched icon/banner into the instance folder (creating it) and returns the name to
/// store in the profile; `None` when there was nothing to write or it couldn't be written.
fn save_image(dir: &Path, file: &str, bytes: Option<Vec<u8>>) -> Option<String> {
    let bytes = bytes?;
    std::fs::create_dir_all(dir).ok()?;
    std::fs::write(dir.join(file), bytes).ok()?;
    Some(file.to_string())
}

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

pub fn get_modpacks() -> Result<serde_json::Value, String> {
    let path = library::context::game_path()?;
    let root = Path::new(&path).join("instances");
    let list = runtime().block_on(library::profile::list_instances(&root));

    let result: Vec<serde_json::Value> = list
        .into_iter()
        .map(|(name, profile)| {
            let dir = root.join(&name);
            let icon_data = image_data_uri(&dir, &profile.icon);
            let banner_data = image_data_uri(&dir, &profile.banner);
            let nihao_client = library::nihao_client::is_installed(&dir);
            serde_json::json!({ "name": name, "profile": profile, "icon_data": icon_data, "banner_data": banner_data, "nihao_client": nihao_client })
        })
        .collect();
    Ok(serde_json::Value::Array(result))
}

/// Quick summary for the library hover preview (`LibraryPage`, `src/launcher.tsx`). An optional
/// convention: `call_module(gameId, "get_home_preview", { path })` returning `{ label, items }`,
/// rendered generically by the host. `last_played` (unix seconds, `null` if never) is what the
/// launcher's main page picks the game to show by.
pub fn get_home_preview() -> Result<serde_json::Value, String> {
    let path = library::context::game_path()?;
    let root = Path::new(&path).join("instances");
    let list = runtime().block_on(library::profile::list_instances(&root));

    let last_played = list.iter().filter_map(|(_, profile)| profile.last_played).max();
    let items: Vec<String> = list
        .into_iter()
        .map(|(name, profile)| {
            if profile.display_name.is_empty() { name } else { profile.display_name }
        })
        .collect();

    Ok(serde_json::json!({ "label": "Modpacks", "items": items, "last_played": last_played }))
}

/// The icon (a data URI, or `null`) of the instance an install job is about; `name` is the job's
/// label. An optional convention: `call_module(gameId, "get_install_icon", { name })`, for the
/// launcher's status panel.
pub fn get_install_icon(name: String) -> Result<serde_json::Value, String> {
    let root = Path::new(&library::context::game_path()?).join("instances");
    let list = runtime().block_on(library::profile::list_instances(&root));
    let icon = list
        .into_iter()
        .find(|(dir, profile)| *dir == name || profile.display_name == name)
        .and_then(|(dir, profile)| image_data_uri(&root.join(dir), &profile.icon));
    Ok(serde_json::json!(icon))
}

/// The newest entries of Mojang's launcher news feed, as the launcher's news cards
/// (`NewsItem` in `src/launcher/NewsFeed.tsx`). An optional convention: `call_module(gameId, "get_news")`.
pub fn get_news() -> Result<serde_json::Value, String> {
    const FEED: &str = "https://launchercontent.mojang.com/news.json";
    let feed: serde_json::Value = runtime().block_on(async {
        let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(8)).build().map_err(|e| e.to_string())?;
        client.get(FEED).send().await.map_err(|e| e.to_string())?.json().await.map_err(|e| e.to_string())
    })?;

    let mut entries: Vec<(i64, serde_json::Value)> = feed["entries"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|e| {
            let date = chrono::NaiveDate::parse_from_str(e["date"].as_str()?, "%Y-%m-%d").ok()?.and_hms_opt(0, 0, 0)?.and_utc().timestamp();
            let item = serde_json::json!({
                "id": e["id"],
                "title": e["title"],
                "text": e["text"],
                "date": date,
                "link": e["readMoreLink"],
                "image": e["newsPageImage"]["url"].as_str().map(|u| format!("https://launchercontent.mojang.com{u}")),
            });
            Some((date, item))
        })
        .collect();
    entries.sort_by_key(|(date, _)| std::cmp::Reverse(*date));
    Ok(serde_json::Value::Array(entries.into_iter().take(8).map(|(_, item)| item).collect()))
}

/// Everything this module keeps that uninstalling may delete, for the launcher's uninstall page:
/// each instance (its worlds and mods), the downloaded game folders and the profiles file. The
/// launcher names, measures and lets the player pick them; each path listed apart is a separate choice.
pub fn uninstall_paths() -> Result<Vec<PathBuf>, String> {
    Ok(uninstall_paths_in(Path::new(&library::context::game_path()?)))
}

fn uninstall_paths_in(root: &Path) -> Vec<PathBuf> {
    let instances = std::fs::read_dir(root.join("instances")).into_iter().flatten().flatten().map(|e| e.path()).filter(|p| p.is_dir());
    let shared = ["versions", "assets", "libraries", "runtime", "resource", library::session::GAME_SETTINGS_FILE_NAME].map(|name| root.join(name));
    instances.chain(shared).filter(|p| p.exists()).collect()
}

#[cfg(test)]
mod location_tests {
    use super::*;

    #[test]
    fn the_log_tells_where_the_player_is() {
        let mut at = Location::default();
        track_location("[Server thread/INFO]: Starting integrated minecraft server version 1.21.1", &mut at);
        assert_eq!(at, Location::World(String::new()), "named later from the saves folder");
        track_location("[12:00:00] [Server thread/INFO]: Preparing level \"My World\"", &mut at);
        assert_eq!(at, Location::World("My World".into()));
        track_location("[12:10:00] [Server thread/INFO]: Stopping server", &mut at);
        assert_eq!(at, Location::Menu);
        track_location("[12:11:00] [Render thread/INFO]: Connecting to play.example.com, 25565", &mut at);
        assert_eq!(at, Location::Server("play.example.com".into()));
        track_location("Connecting to 1.2.3.4, 25570", &mut at);
        assert_eq!(at, Location::Server("1.2.3.4:25570".into()));
        track_location("[Render thread/INFO]: Connecting to Discord (Attempt 0/10)", &mut at);
        track_location("voice chat server: 127.0.0.1:56110. Connecting to 127.0.0.1, abc", &mut at);
        assert_eq!(at, Location::Server("1.2.3.4:25570".into()), "mod lines are not servers");
    }
}

#[cfg(test)]
mod job_tests {
    use super::*;

    #[test]
    fn a_second_job_on_the_same_instance_is_refused_until_the_first_ends() {
        let label = "job-test-instance";
        assert!(ensure_idle(label).is_ok());
        begin_job(label, 5, "download").unwrap();
        assert!(ensure_idle(label).unwrap_err().contains("busy"));
        assert!(begin_job(label, 5, "repair").is_err());
        assert!(ensure_idle("another-instance").is_ok(), "other instances are not blocked");
        finish_job(label, "Install", &Ok(()));
        assert!(begin_job(label, 5, "repair").is_ok());
        finish_job(label, "Install", &Ok(()));
    }
}

#[cfg(test)]
mod uninstall_tests {
    use super::*;

    #[test]
    fn every_instance_and_game_folder_is_listed_on_its_own() {
        let root = std::env::temp_dir().join(format!("nihao-mc-uninstall-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("instances/Pack")).unwrap();
        std::fs::create_dir_all(root.join("instances/Other")).unwrap();
        std::fs::write(root.join("instances/not-an-instance.txt"), "x").unwrap();
        std::fs::create_dir_all(root.join("libraries")).unwrap();
        std::fs::write(root.join("game.nihao"), "{}").unwrap();

        let mut found = uninstall_paths_in(&root);
        found.sort();
        let mut want = vec![root.join("instances/Other"), root.join("instances/Pack"), root.join("libraries"), root.join("game.nihao")];
        want.sort();
        assert_eq!(found, want);
        assert!(uninstall_paths_in(&root.join("missing")).is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }
}

/// The named local ("offline") sessions and which one is the default, stored in `{path}/game.nihao`
/// (see `library::session`). `path` is the game install directory. Never errors: a fresh install
/// returns an empty list.
pub fn get_profiles() -> Result<library::session::ProfilesData, String> {
    let path = library::context::game_path()?;
    Ok(runtime().block_on(library::session::load_profiles(&path)))
}

pub fn save_profiles(
    profiles: Vec<library::session::OfflineProfile>,
    default_profile_id: Option<String>,
) -> Result<(), String> {
    let path = library::context::game_path()?;
    let data = library::session::ProfilesData { profiles, default_profile_id };
    runtime().block_on(library::session::save_profiles(&path, &data))
}

/// Signs in to Ely.by and saves the account as a player profile (or renews the token of the one
/// already there). The password is used once and not kept.
pub fn login_elyby(login: String, password: String) -> Result<library::session::OfflineProfile, String> {
    let path = library::context::game_path()?;
    runtime().block_on(async {
        let account = library::elyby::authenticate(login.trim(), &password).await?;
        let profile = library::session::OfflineProfile { id: format!("elyby-{}", account.uuid), name: account.name.clone(), service: "elyby".into() };
        let mut data = library::session::load_profiles(&path).await;
        data.profiles.retain(|p| p.id != profile.id);
        data.profiles.push(profile.clone());
        library::session::save_profiles(&path, &data).await?;
        library::session::save_elyby_token(&path, &profile.id, &account).await?;
        Ok(profile)
    })
}

/// Makes the launch run under the picked profile: an Ely.by one gets its token renewed and handed
/// to the NiHao Client mod. Offline profiles need nothing.
async fn apply_session_profile(path: &str, profile_id: &str, instance: &mut MinecraftInstance) -> Result<(), String> {
    let data = library::session::load_profiles(path).await;
    let Some(profile) = data.profiles.iter().find(|p| p.id == profile_id) else { return Ok(()) };
    if profile.service != "elyby" {
        return Ok(());
    }
    let relogin = || format!("Sign in to Ely.by again for '{}' (Player profiles)", profile.name);
    let (access, client) = library::session::load_elyby_token(path, profile_id).ok_or_else(relogin)?;
    let account = library::elyby::refresh(&access, &client).await.map_err(|e| format!("{} — {}", relogin(), e))?;
    library::session::save_elyby_token(path, profile_id, &account).await?;
    instance.session.session_type = library::auth::SessionTypeEnum::ELYBY;
    instance.session.nihao_token = Some(account.access_token);
    Ok(())
}

/// The player's skin (Ely.by, else the licensed account) as a data URI, `null` when there is none.
pub fn get_skin(nickname: String) -> Result<Option<String>, String> {
    use base64::Engine;
    Ok(runtime()
        .block_on(library::session::find_skin(&nickname))
        .map(|png| format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(png))))
}

/// A skin PNG the player dropped on the profiles page, as a data URI to try on the preview. Only
/// a 64x64 PNG up to 1 MB is taken: the model's UVs are laid out for that skin format.
pub fn read_skin_file(path: String) -> Result<String, String> {
    use base64::Engine;
    const MAX_BYTES: u64 = 1024 * 1024;
    let path = Path::new(&path);
    if !path.extension().is_some_and(|e| e.eq_ignore_ascii_case("png")) {
        return Err("A skin is a .png file".into());
    }
    let size = std::fs::metadata(path).map_err(|e| format!("Cannot read the file: {e}"))?.len();
    if size > MAX_BYTES {
        return Err("The file is too big for a skin (over 1 MB)".into());
    }
    let bytes = std::fs::read(path).map_err(|e| format!("Cannot read the file: {e}"))?;
    // The PNG signature, then the IHDR chunk with the width and height as big-endian u32.
    let (width, height) = match bytes.get(..24) {
        Some(head) if head.starts_with(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]) => (
            u32::from_be_bytes([head[16], head[17], head[18], head[19]]),
            u32::from_be_bytes([head[20], head[21], head[22], head[23]]),
        ),
        _ => return Err("This is not a PNG image".into()),
    };
    if (width, height) != (64, 64) {
        return Err(format!("A skin has to be 64x64 pixels (this one is {width}x{height})"));
    }
    Ok(format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)))
}

/// The player's Ely.by cape as a data URI, `null` when there is none.
pub fn get_cape(nickname: String) -> Result<Option<String>, String> {
    use base64::Engine;
    Ok(runtime()
        .block_on(library::session::find_cape(&nickname))
        .map(|png| format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(png))))
}

/// The "Public" tab in Create Modpack: NiHao's hosted catalog (`GET /minecraft/modpacks` on the
/// module's own server, see `library::online_modpacks`), not Modrinth. Nothing to show while signed
/// out.
pub fn list_online_modpacks(images: Option<bool>) -> Result<Vec<library::online_modpacks::OnlineModpack>, String> {
    let session_token = library::context::session_token()?;
    runtime().block_on(library::online_modpacks::list(&session_token, images.unwrap_or(true)))
}

/// The "Public" tab's download button: fetches the pack's latest manifest and icon/banner
/// synchronously (returns only once the instance's profile is saved), then installs it as a new
/// instance `name` in the background: pack files via `GET .../files/{path}` (or `source.url`), then
/// the same `build_instance`/`install_stream` pipeline as `create_modpack`/`import_modpack`, since
/// a manifest never covers the game itself. Tracked under the instance name.
pub fn install_online_modpack(name: String, id: String) -> Result<serde_json::Value, String> {
    let path = library::context::game_path()?;
    let session_token = library::context::session_token()?;
    let dir = instance_dir(&path, &name);
    if dir.exists() {
        return Err(format!("An instance named '{}' already exists", name));
    }
    ensure_idle(&name)?;

    let manifest_json = runtime().block_on(library::online_modpacks::fetch_manifest(&session_token, &id))?;
    let manifest: ModpackManifest = serde_json::from_value(manifest_json)
        .map_err(|e| format!("Invalid manifest from server: {}", e))?;

    // Fetched and written before the profile is first saved, not partway through the background
    // job: the pack download can take a while, and a late icon left the tile on the default icon,
    // which reads as a glitch. Best-effort: a missing or failed icon/banner doesn't block the
    // install.
    let (icon_bytes, banner_bytes) = runtime().block_on(library::online_modpacks::fetch_pack_images(&session_token, &id));
    std::fs::create_dir_all(&dir).map_err(|e| format!("Cannot create '{}': {}", dir.display(), e))?;
    let icon = icon_bytes.and_then(|bytes| {
        std::fs::write(dir.join(ICON_FILE_NAME), bytes).ok()?;
        Some(ICON_FILE_NAME.to_string())
    });
    let banner = banner_bytes.and_then(|bytes| {
        std::fs::write(dir.join(BANNER_FILE_NAME), bytes).ok()?;
        Some(BANNER_FILE_NAME.to_string())
    });

    let profile = MinecraftProfile {
        display_name: name.clone(),
        version_id: manifest.minecraft_version.clone(),
        core: manifest.loader.clone(),
        loader_version: manifest.loader_version.clone(),
        max_ram: 2048,
        min_ram: 512,
        use_custom_ram: false,
        java_path: None,
        jvm_arguments: String::new(),
        icon,
        banner,
        // Set from the very first save together with `downloaded`: otherwise, while the pack files
        // download, the instance is `downloaded: true` with `pack: None`, the Public tab's
        // `notYetInstalled` filter (matching `profile.pack.id`) doesn't recognise it, and the
        // catalog card and the tile show as duplicates.
        pack: Some(manifest.clone()),
        downloaded: true,
        play_secs: 0,
        play_stats: Default::default(),
        last_played: None,
        source: None,
        missing_files: Vec::new(),
    };
    runtime().block_on(profile.save(&dir))?;

    let label = name.clone();
    begin_job(&label, 1, "download")?;

    let dir_bg = dir.clone();
    let path_bg = path.clone();
    let name_bg = name.clone();
    let label_bg = label.clone();
    let session_bg = session_token.clone();
    let id_bg = id.clone();
    let manifest_bg = manifest.clone();
    std::thread::spawn(move || {
        let result: Result<(), String> = runtime().block_on(async {
            let diff = diff_manifests(None, &manifest_bg);
            let total_files = diff.to_download.len();
            for (i, entry) in diff.to_download.iter().enumerate() {
                install_state().lock().unwrap_or_else(|e| e.into_inner()).active.insert(
                    label_bg.clone(),
                    InstallProgress {
                        name: label_bg.clone(),
                        etap: "Downloading pack files".to_string(),
                        current_etaps: 0,
                        total_etaps: 1,
                        current_file: i,
                        total_files,
                        status: "download".to_string(),
                        filename: entry.path.clone(),
                        job_type: "download".to_string(),
                    },
                );

                let dest = library::modpack_format::safe_join(&dir_bg, &entry.path)?;
                if let Some(parent) = dest.parent() {
                    tokio::fs::create_dir_all(parent)
                        .await
                        .map_err(|e| format!("Cannot create '{}': {}", parent.display(), e))?;
                }
                library::online_modpacks::download_file(&session_bg, &id_bg, manifest_bg.build, entry, &dest).await?;
            }

            let profile = MinecraftProfile::load(&dir_bg).await?;

            // The pack only supplies mods/configs/resourcepacks; the client/libraries/assets/Java
            // still come from the normal install pipeline.
            let mut instance = build_instance(&path_bg, &name_bg, &profile, "Player");
            let (mut stream, handle) = instance.install_stream().await?;
            while let Some(info) = stream.next().await {
                install_state().lock().unwrap_or_else(|e| e.into_inner()).active.insert(
                    label_bg.clone(),
                    InstallProgress::from_info(&label_bg, &info, "download"),
                );
            }
            handle.await.map_err(|e| format!("Install task panicked: {}", e))?
        });

        let mut state = install_state().lock().unwrap_or_else(|e| e.into_inner());
        state.active.remove(&label_bg);
        match &result {
            Ok(()) => println!("[minecraft] Online install finished for '{}'.", name_bg),
            Err(e) => {
                eprintln!("[minecraft] Online install failed for '{}': {}", name_bg, e);
                state.last_error = Some((label_bg.clone(), e.clone()));
            }
        }
    });

    Ok(serde_json::json!({ "status": "installing", "name": name }))
}

/// Saves the profile synchronously, then runs the install pipeline on a detached background thread,
/// so the call returns at once instead of blocking for the Java/libraries/assets/client download.
/// Progress is polled via `get_install_status`.
pub fn create_modpack(
    name: String,
    core: String,
    version: String,
    loader: Option<String>,
    nihao_client: Option<bool>,
) -> Result<serde_json::Value, String> {
    let path = library::context::game_path()?;
    let dir = instance_dir(&path, &name);
    ensure_idle(&name)?;

    // Re-using an existing name re-saves the profile and re-runs the install instead of erroring:
    // the reasons to "create" over an existing instance (retry, "Repair / re-verify files") must
    // not reset RAM, java path, jvm args or icon.
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
        downloaded: existing.as_ref().map(|p| p.downloaded).unwrap_or(false),
        play_secs: existing.as_ref().map(|p| p.play_secs).unwrap_or(0),
        play_stats: existing.as_ref().map(|p| p.play_stats.clone()).unwrap_or_default(),
        last_played: existing.as_ref().and_then(|p| p.last_played),
        source: existing.as_ref().and_then(|p| p.source.clone()),
        missing_files: existing.as_ref().map(|p| p.missing_files.clone()).unwrap_or_default(),
    };

    runtime().block_on(profile.save(&dir))?;

    // Re-running on an instance that already has a profile is a repair/re-verify, not a fresh
    // install.
    let job_type = if existing.is_some() { "repair" } else { "download" };

    begin_job(&name, 5, job_type)?;

    let path_bg = path.clone();
    let name_bg = name.clone();
    let nihao_bg = nihao_client.unwrap_or(false).then(|| (profile.core.to_string(), profile.version_id.clone()));
    std::thread::spawn(move || {
        let result = runtime().block_on(async {
            run_install(&path_bg, &name_bg, &name_bg, job_type).await?;
            if let Some((loader, version)) = nihao_bg {
                library::nihao_client::install(&instance_dir(&path_bg, &name_bg), &loader, &version).await?;
            }
            Ok(())
        });
        finish_job(&name_bg, "Install", &result);
    });

    Ok(serde_json::json!({ "status": "installing", "name": name }))
}

/// The NiHao Client build for a loader + game version, or `null` when there is none: the create
/// form shows its "Use NiHao Client" checkbox only for a non-null answer.
pub fn get_nihao_client(core: String, version: String) -> Result<Option<library::nihao_client::NihaoClientBuild>, String> {
    Ok(runtime().block_on(library::nihao_client::find_build(&MinecraftLoader::from_str(&core).to_string(), &version)))
}

/// Polled by the launcher UI to show an ambient "installing" indicator with detail.
pub fn get_install_status() -> Result<serde_json::Value, String> {
    let state = install_state().lock().unwrap_or_else(|e| e.into_inner());
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

/// Loader (build) versions compatible with a Minecraft game version; powers the "Loader version"
/// select (Fabric, NeoForge).
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

/// Reads the general "RAM Allocation" Game setting straight from `{path}/game.nihao`, used at
/// launch when the instance has "Use custom RAM" off. Read here, not passed by the frontend: a
/// `ram_override` param raced the async load of that setting and silently fell back to a stale
/// `profile.max_ram`.
fn general_ram_setting(path: &str) -> Option<u32> {
    let content = std::fs::read_to_string(Path::new(path).join("game.nihao")).ok()?;
    let json: serde_json::Value = serde_json::from_str(&content).ok()?;
    json.get("ram")?.as_u64().map(|v| v as u32)
}

/// Every screenshot of every instance (`instances/*/screenshots`), newest first, capped at 1000.
/// Metadata only; the image comes from `get_screenshot` when a tile scrolls into view.
pub fn list_screenshots() -> Result<serde_json::Value, String> {
    let path = library::context::game_path()?;
    let root = Path::new(&path).join("instances");
    let mut shots: Vec<(u64, String, String)> = Vec::new();
    for inst in std::fs::read_dir(&root).into_iter().flatten().flatten() {
        let instance = inst.file_name().to_string_lossy().into_owned();
        for f in std::fs::read_dir(inst.path().join("screenshots")).into_iter().flatten().flatten() {
            let file = f.file_name().to_string_lossy().into_owned();
            let lower = file.to_lowercase();
            if !(lower.ends_with(".png") || lower.ends_with(".jpg") || lower.ends_with(".jpeg")) {
                continue;
            }
            let modified = f
                .metadata()
                .and_then(|m| m.created().or_else(|_| m.modified()))
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map_or(0, |d| d.as_secs());
            shots.push((modified, instance.clone(), file));
        }
    }
    shots.sort_by(|a, b| b.0.cmp(&a.0));
    shots.truncate(1000);
    Ok(serde_json::Value::Array(
        shots
            .into_iter()
            .map(|(modified, instance, file)| serde_json::json!({ "instance": instance, "file": file, "modified": modified }))
            .collect(),
    ))
}

/// Names come from the UI: keep only the last path part of the file (`instance_dir` does the same
/// for the instance) so neither can point outside `screenshots/`.
fn screenshot_path(instance: &str, file: &str) -> Result<PathBuf, String> {
    join_screenshot(&instance_dir(&library::context::game_path()?, instance), file)
}

fn join_screenshot(instance_dir: &Path, file: &str) -> Result<PathBuf, String> {
    let file = Path::new(file).file_name().ok_or("Bad file name")?;
    Ok(instance_dir.join("screenshots").join(file))
}

#[cfg(test)]
mod screenshot_tests {
    use super::*;

    #[test]
    fn file_name_cannot_leave_screenshots() {
        let dir = Path::new("inst");
        assert_eq!(join_screenshot(dir, "../../x.png").unwrap(), dir.join("screenshots").join("x.png"));
        assert!(join_screenshot(dir, "..").is_err());
        assert!(join_screenshot(dir, "").is_err());
    }
}

pub fn delete_screenshot(instance: String, file: String) -> Result<(), String> {
    std::fs::remove_file(screenshot_path(&instance, &file)?).map_err(|e| format!("Cannot delete screenshot: {}", e))
}

pub fn save_screenshot_as(instance: String, file: String, dest_path: String) -> Result<(), String> {
    std::fs::copy(screenshot_path(&instance, &file)?, dest_path)
        .map(|_| ())
        .map_err(|e| format!("Cannot save screenshot: {}", e))
}

/// Saves a service's gallery image (`url`) to `dest_path`; see `ContentService::fetch_image`.
pub fn save_remote_image(service: String, url: String, dest_path: String) -> Result<(), String> {
    let bytes = runtime().block_on(library::services::get(&service)?.fetch_image(&url))?;
    std::fs::write(dest_path, bytes).map_err(|e| format!("Cannot save the image: {}", e))
}

/// One screenshot as a data URI (the webview cannot load local files directly).
pub fn get_screenshot(instance: String, file: String) -> Result<String, String> {
    let file_path = screenshot_path(&instance, &file)?;
    let file = file_path.file_name().unwrap_or_default().to_owned();
    let bytes = std::fs::read(&file_path).map_err(|e| format!("Cannot read screenshot: {}", e))?;
    let mime = if file.to_string_lossy().to_lowercase().ends_with(".png") { "png" } else { "jpeg" };
    use base64::Engine;
    Ok(format!("data:image/{};base64,{}", mime, base64::engine::general_purpose::STANDARD.encode(bytes)))
}

/// `{ online, players, max }` - a server that does not answer within ~1.5s is just `online: false`.
pub fn ping_server(address: String) -> Result<serde_json::Value, String> {
    Ok(match library::play_targets::ping(&address) {
        Some((players, max)) => serde_json::json!({ "online": true, "players": players, "max": max }),
        None => serde_json::json!({ "online": false }),
    })
}

pub fn list_play_targets(name: String) -> Result<serde_json::Value, String> {
    let path = library::context::game_path()?;
    Ok(library::play_targets::list(&instance_dir(&path, &name)))
}

/// `world` (a `saves/` folder name) or `server` (`host[:port]`), when given, makes the game join it
/// right after starting. `nickname` is the selected offline profile (default "Player").
pub fn play_modpack(name: String, nickname: Option<String>, profile_id: Option<String>, world: Option<String>, server: Option<String>) -> Result<serde_json::Value, String> {
    let path = library::context::game_path()?;
    ensure_idle(&name)?;
    if let Some(process) = running_state().lock().unwrap_or_else(|e| e.into_inner()).get_mut(&name) {
        if matches!(process.child.try_wait(), Ok(None)) {
            return Err(format!("'{}' is already running", name));
        }
    }
    let mut child = runtime().block_on(async {
        let dir = instance_dir(&path, &name);
        let profile = MinecraftProfile::load(&dir)
            .await
            .map_err(|e| format!("Instance '{}' not found: {}", name, e))?;

        let mut instance = build_instance(&path, &name, &profile, nickname.as_deref().unwrap_or("Player"));
        if let Some(id) = profile_id.as_deref() {
            apply_session_profile(&path, id, &mut instance).await?;
        }
        instance.quick_play = match (world, server) {
            (Some(w), _) if !w.is_empty() => Some(library::QuickPlay::World(w)),
            (_, Some(s)) if !s.is_empty() => Some(library::QuickPlay::Server(s)),
            _ => None,
        };
        if !profile.use_custom_ram {
            instance.option.max_ram = general_ram_setting(&path).unwrap_or(crate::ram_defaults().1 as u32);
        }
        instance.build().await
    })?;

    let log = Arc::new(Mutex::new(Vec::new()));
    let location = Arc::new(Mutex::new(Location::default()));
    if let Some(stdout) = child.stdout.take() {
        spawn_log_reader(stdout, log.clone(), location.clone());
    }
    if let Some(stderr) = child.stderr.take() {
        spawn_log_reader(stderr, log.clone(), location.clone());
    }

    running_state().lock().unwrap_or_else(|e| e.into_inner()).insert(name.clone(), RunningProcess { child, log, location: location.clone() });
    track_play_time(&instance_dir(&path, &name), name, location);

    Ok(serde_json::json!({ "status": "ok" }))
}

/// Stamps `last_played` now, then adds the session length to `play_secs` once the game exits
/// (noticed within ~5s, also when `get_launch_log` already dropped the process).
fn track_play_time(dir: &Path, name: String, location: Arc<Mutex<Location>>) {
    let dir = dir.to_path_buf();
    let started = std::time::Instant::now();
    let mut last_tick = started;
    let mut stats = library::profile::PlayStats::default();
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs());
    update_profile_quietly(&dir, move |p| p.last_played = Some(now));
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_secs(5));
        let alive = running_state()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get_mut(&name)
            .is_some_and(|r| matches!(r.child.try_wait(), Ok(None)));
        // Time since the last tick goes to where the player was; sub-second remainders are dropped.
        let slice = last_tick.elapsed().as_secs();
        last_tick = std::time::Instant::now();
        let mut at = location.lock().unwrap_or_else(|e| e.into_inner());
        if *at == Location::World(String::new()) {
            if let Some(world) = newest_save(&dir.join("saves")) {
                *at = Location::World(world);
            }
        }
        match &*at {
            Location::Menu => stats.menu_secs += slice,
            Location::World(w) => *stats.worlds.entry(w.clone()).or_default() += slice,
            Location::Server(s) => *stats.servers.entry(s.clone()).or_default() += slice,
        }
        drop(at);
        *stats.daily.entry(chrono::Local::now().format("%Y-%m-%d").to_string()).or_default() += slice;
        if !alive {
            let secs = started.elapsed().as_secs();
            update_profile_quietly(&dir, move |p| {
                p.play_secs += secs;
                p.play_stats.menu_secs += stats.menu_secs;
                for (k, v) in stats.worlds { *p.play_stats.worlds.entry(k).or_default() += v; }
                for (k, v) in stats.servers { *p.play_stats.servers.entry(k).or_default() += v; }
                for (k, v) in stats.daily { *p.play_stats.daily.entry(k).or_default() += v; }
            });
            break;
        }
    });
}

/// Load-modify-save of an instance's profile; a stats update must never fail a launch, so errors are dropped.
fn update_profile_quietly(dir: &Path, change: impl FnOnce(&mut MinecraftProfile)) {
    let _ = runtime().block_on(async {
        let mut profile = MinecraftProfile::load(dir).await?;
        change(&mut profile);
        profile.save(dir).await
    });
}

/// Polled by the Play page while an instance runs: whether the process is alive plus its captured
/// stdout/stderr; drops it from `running_state` once it exited on its own. The log is read before
/// any removal, or the poll that notices a launch crash would wipe the log it needs to show.
pub fn get_launch_log(name: String) -> Result<serde_json::Value, String> {
    let mut state = running_state().lock().unwrap_or_else(|e| e.into_inner());

    let log = state
        .get(&name)
        .map(|p| p.log.lock().unwrap_or_else(|e| e.into_inner()).clone())
        .unwrap_or_default();

    let mut running = state.contains_key(&name);
    let mut exit_code = None;
    if let Some(process) = state.get_mut(&name) {
        if let Ok(Some(status)) = process.child.try_wait() {
            exit_code = status.code();
            state.remove(&name);
            running = false;
        }
    }

    Ok(serde_json::json!({ "running": running, "log": log, "exit_code": exit_code }))
}

/// Updates an instance's "Install" settings (RAM, java path, extra JVM args). Takes effect on the
/// next launch: `build()` reads them fresh from the profile each time.
pub fn update_modpack_settings(
    name: String,
    max_ram: u32,
    min_ram: u32,
    use_custom_ram: bool,
    java_path: Option<String>,
    jvm_arguments: String,
) -> Result<serde_json::Value, String> {
    let path = library::context::game_path()?;
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

/// Renames an instance's display name only; its internal id (directory name, key for
/// `running_state`/`install_state`/`instance_dir`) never changes, so this is safe during an install
/// or a running game.
pub fn rename_modpack(name: String, display_name: String) -> Result<serde_json::Value, String> {
    let path = library::context::game_path()?;
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

/// Fills a service-linked instance's missing `source.icon_url`/`source.url` (packs installed before
/// they were stored) from the service and saves them. A failed lookup is an error and leaves the
/// fields unset, so the next call retries. Returns the (possibly updated) `source`, `null` if none.
pub fn refresh_modpack_source(name: String) -> Result<serde_json::Value, String> {
    let path = library::context::game_path()?;
    let dir = instance_dir(&path, &name);
    runtime().block_on(async {
        let profile = MinecraftProfile::load(&dir).await.map_err(|e| format!("Instance '{}' not found: {}", name, e))?;
        let Some(source) = profile.source else { return Ok(serde_json::Value::Null) };
        if source.icon_url.is_some() && source.url.is_some() {
            return Ok(serde_json::json!(source));
        }
        let detail = library::services::get(&source.service)?.project(&source.project_id).await?;
        // Reloaded: the lookup took a while and the profile may have been edited meanwhile.
        let mut profile = MinecraftProfile::load(&dir).await?;
        let Some(source) = profile.source.as_mut() else { return Ok(serde_json::Value::Null) };
        source.icon_url = source.icon_url.take().or(detail.icon_url);
        source.url = source.url.take().or(Some(detail.url).filter(|u| !u.is_empty()));
        let updated = serde_json::json!(source);
        profile.save(&dir).await?;
        Ok(updated)
    })
}

/// Opens an instance's directory in the OS file explorer via a plain `Command` (this plugin has no
/// `tauri` dependency).
pub fn open_modpack_folder(name: String) -> Result<serde_json::Value, String> {
    let path = library::context::game_path()?;
    let dir = instance_dir(&path, &name);
    std::fs::create_dir_all(&dir).map_err(|e| format!("Cannot create instance folder: {}", e))?;

    crate::platforms::open_folder(&dir)?;

    Ok(serde_json::json!({ "status": "ok" }))
}

/// Opens the folder a file lies in (a finished export) in the OS file explorer.
pub fn reveal_in_folder(path: String) -> Result<(), String> {
    let folder = Path::new(&path).parent().filter(|p| p.is_dir()).ok_or("That file's folder doesn't exist")?;
    crate::platforms::open_folder(folder)
}

/// Re-checks the files a pack was missing (`MinecraftProfile::missing_files`): one that is now in
/// the instance, or in the player's Downloads folder (copied in), is no longer missing. See
/// `library::missing_files::check`.
pub fn check_missing_files(name: String) -> Result<library::missing_files::CheckResult, String> {
    let path = library::context::game_path()?;
    let dir = instance_dir(&path, &name);
    runtime().block_on(async {
        let mut profile = MinecraftProfile::load(&dir).await?;
        let result = library::missing_files::check(&dir, dirs::download_dir().as_deref(), std::mem::take(&mut profile.missing_files));
        profile.missing_files = result.missing.clone();
        profile.save(&dir).await?;
        Ok(result)
    })
}

/// Deletes the copies `check_missing_files` made from the Downloads folder, once the player agrees;
/// returns how many went. Only files identical to the instance's are deleted.
pub fn delete_downloaded_files(name: String, files: Vec<library::missing_files::DownloadedCopy>) -> Result<usize, String> {
    let path = library::context::game_path()?;
    let dir = instance_dir(&path, &name);
    let downloads = dirs::download_dir().ok_or_else(|| "Cannot find the Downloads folder".to_string())?;
    Ok(library::missing_files::delete_copies(&dir, &downloads, &files))
}

/// The folders/files in an instance (or, with `path`, in one of its folders), for the Share modal's
/// "what to include" tree. See `library::modpack_format::list_top_level_entries`.
pub fn list_export_entries(name: String, path: Option<String>) -> Result<Vec<library::modpack_format::ExportEntry>, String> {
    let game = library::context::game_path()?;
    let dir = instance_dir(&game, &name);
    match path.filter(|p| !p.is_empty()) {
        Some(sub) => library::modpack_format::list_top_level_entries(&library::modpack_format::safe_join(&dir, &sub)?),
        None => library::modpack_format::list_top_level_entries(&dir),
    }
}

/// One file/folder in a content listing. A resourcepack/datapack can be a `.zip` or a folder
/// (`is_dir`). `display_name`/`version`/`icon_data` come from
/// `library::content_cache::resolve_content` (`None` if neither the file nor an online service
/// identified it). `enabled` is `false` only for a mod renamed to `*.jar.disabled`.
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
    /// Set only when the metadata came from an online lookup (`ResolvedContent::project_id`, owned
    /// by `service`); the frontend shows "Installed" instead of "Install" on a matching Browse hit.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub service: Option<String>,
}

#[derive(Serialize)]
pub struct ContentLists {
    pub mods: Vec<ContentEntry>,
    pub resourcepacks: Vec<ContentEntry>,
    pub shaderpacks: Vec<ContentEntry>,
    pub datapacks: Vec<ContentEntry>,
}

/// Lists `{instance_dir}/{category}` and resolves each entry's name/version/icon via
/// `library::content_cache::resolve_content` (cached in `cache.nihao`, with an online lookup
/// fallback), so it only does real work for new or changed files. For mods a `.disabled` suffix
/// doesn't stop the file being read as a jar.
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
                service: info.and_then(|r| r.service.clone()),
                name,
                size,
                is_dir,
            }
        })
        .collect();
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    out
}

/// The Content manager's data: every mod/resourcepack/shaderpack/datapack in the instance. A
/// missing folder yields an empty list. Blocks until everything is resolved; the first scan of a
/// freshly imported modpack can take several seconds, so see `start_content_scan` for a
/// progress-reporting version.
pub fn list_content(name: String) -> Result<ContentLists, String> {
    let path = library::context::game_path()?;
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

/// Tracks `start_content_scan` runs so `get_content_scan_status` can report progress, the finished
/// list (once) or the failure (once). Separate from `install_state()`, which feeds the bottom
/// progress bar.
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

/// Same data as `list_content`, run in the background with progress via `get_content_scan_status`.
/// `name` is the state key; a second scan for the same instance restarts the running one.
pub fn start_content_scan(name: String) -> Result<serde_json::Value, String> {
    let path = library::context::game_path()?;
    let dir = instance_dir(&path, &name);
    {
        let mut state = content_scan_state().lock().unwrap_or_else(|e| e.into_inner());
        state.results.remove(&name);
        state.errors.remove(&name);
        state.progress.insert(name.clone(), ContentScanProgress { category: String::new(), current: 0, total: 0 });
    }

    let name_bg = name.clone();
    std::thread::spawn(move || {
        // A panic in the scan (a damaged jar, say) must end the scan with an error: the panel polls
        // until it hears "done" or "error", so a dead thread would leave it scanning forever.
        let scanned = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| runtime().block_on(async {
            let mut lists = ContentLists { mods: Vec::new(), resourcepacks: Vec::new(), shaderpacks: Vec::new(), datapacks: Vec::new() };
            for category in ["mods", "resourcepacks", "shaderpacks", "datapacks"] {
                let category_owned = category.to_string();
                let name_progress = name_bg.clone();
                let on_progress = move |current: usize, total: usize| {
                    content_scan_state().lock().unwrap_or_else(|e| e.into_inner()).progress.insert(
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
        })));

        let mut state = content_scan_state().lock().unwrap_or_else(|e| e.into_inner());
        state.progress.remove(&name_bg);
        match scanned {
            Ok(lists) => {
                state.results.insert(name_bg, lists);
            }
            Err(_) => {
                state.errors.insert(name_bg, "The scan stopped unexpectedly.".to_string());
            }
        }
    });

    Ok(serde_json::json!({ "status": "scanning" }))
}

/// Polled by the Content manager while `start_content_scan` runs. `results`/`errors` are taken
/// (removed) on read: the panel stops polling at `"done"`/`"error"`, and clearing keeps a stale
/// result from replaying for a later scan.
pub fn get_content_scan_status(name: String) -> Result<serde_json::Value, String> {
    let mut state = content_scan_state().lock().unwrap_or_else(|e| e.into_inner());
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

/// Enables/disables a mod by renaming it to/from `*.jar.disabled`: every loader (Fabric, Forge,
/// NeoForge) only loads files ending in `.jar` from `mods/`, and Prism/MultiMC use the same
/// convention.
pub fn toggle_content_file(name: String, category: String, filename: String) -> Result<serde_json::Value, String> {
    let path = library::context::game_path()?;
    let dir = content_category_dir(&instance_dir(&path, &name), &category)?;
    let src = library::modpack_format::safe_join(&dir, &filename)?;
    let new_name = match filename.strip_suffix(".disabled") {
        Some(stripped) => stripped.to_string(),
        None => format!("{}.disabled", filename),
    };
    std::fs::rename(&src, library::modpack_format::safe_join(&dir, &new_name)?)
        .map_err(|e| format!("Cannot toggle '{}': {}", filename, e))?;
    Ok(serde_json::json!({ "status": "ok", "name": new_name }))
}

/// Deletes one file/folder from `mods`/`resourcepacks`/`shaderpacks`/`datapacks`.
pub fn delete_content_file(name: String, category: String, filename: String) -> Result<serde_json::Value, String> {
    let path = library::context::game_path()?;
    let dir = content_category_dir(&instance_dir(&path, &name), &category)?;
    let target = library::modpack_format::safe_join(&dir, &filename)?;
    if target.is_dir() {
        std::fs::remove_dir_all(&target).map_err(|e| format!("Cannot delete '{}': {}", filename, e))?;
    } else {
        std::fs::remove_file(&target).map_err(|e| format!("Cannot delete '{}': {}", filename, e))?;
    }
    Ok(serde_json::json!({ "status": "ok" }))
}

/// A service as listed to the UI: its info, plus why it can't be used right now (if so).
#[derive(Serialize)]
pub struct ServiceListing {
    #[serde(flatten)]
    info: &'static library::services::ServiceInfo,
    unavailable: Option<&'static str>,
}

/// Every online content service, for the UI to build its tabs and filters from. One that can't be
/// used yet is still listed, so the player sees why.
pub fn list_content_services() -> Result<Vec<ServiceListing>, String> {
    Ok(library::services::all()
        .iter()
        .map(|s| ServiceListing { info: s.info(), unavailable: s.unavailable() })
        .collect())
}

#[cfg(test)]
mod service_listing_tests {
    #[test]
    fn listing_flattens_info_next_to_the_unavailable_reason() {
        let listed = serde_json::to_value(super::list_content_services().unwrap()).unwrap();
        let modrinth = listed.as_array().unwrap().iter().find(|s| s["id"] == "modrinth").unwrap();
        assert_eq!(modrinth["name"], "Modrinth");
        assert!(modrinth["unavailable"].is_null());
        assert!(listed.as_array().unwrap().iter().any(|s| s["id"] == "curseforge"));
    }
}

/// Loads `name`'s profile, for the commands that scope a service request to an instance.
fn load_instance(name: &str) -> Result<(PathBuf, MinecraftProfile), String> {
    let path = library::context::game_path()?;
    let dir = instance_dir(&path, name);
    let profile = runtime()
        .block_on(MinecraftProfile::load(&dir))
        .map_err(|e| format!("Instance '{}' not found: {}", name, e))?;
    Ok((dir, profile))
}

/// "Browse content": searches `service` for `query`, scoped to `category`'s project type and
/// (best-effort) the instance's game version/loader. See `library::services::ContentService::search`.
pub fn search_content(
    service: String,
    name: String,
    category: String,
    query: String,
    offset: u32,
    limit: u32,
    sort: String,
    categories: Vec<String>,
    environments: Vec<String>,
) -> Result<library::services::BrowseSearchResult, String> {
    let service = library::services::get(&service)?;
    let (_, profile) = load_instance(&name)?;
    runtime().block_on(service.search(&library::services::SearchQuery {
        category,
        query,
        minecraft_version: profile.version_id,
        loader: profile.core.to_string(),
        offset,
        limit,
        sort,
        categories,
        environments,
        ..Default::default()
    }))
}

/// The filter categories Browse offers for `category`. Needs no instance profile: a taxonomy isn't
/// version/loader-specific.
pub fn list_content_categories(service: String, category: String) -> Result<Vec<String>, String> {
    runtime().block_on(library::services::get(&service)?.categories(&category))
}

/// The "open a mod" detail view's data — see `library::services::ContentService::project`.
pub fn get_content_project(service: String, project_id: String) -> Result<library::services::ProjectDetail, String> {
    runtime().block_on(library::services::get(&service)?.project(&project_id))
}

/// The `active`/`last_error` key a content install is tracked under in `install_state()`, distinct
/// from a plain instance name (like `export_job_label`).
fn install_job_label(title: &str, service: &str) -> String {
    format!("{} ({})", title, service)
}

/// Downloads a Browse content result's best-matching file into the instance
/// (`library::services::install`). Runs in the background and reports through `install_state()`;
/// the frontend watches `get_install_status` for the returned `job` to disappear, then re-lists.
/// `title` is only the bottom bar's label; the project is looked up by `project_id`.
pub fn install_content(service: String, name: String, category: String, project_id: String, title: String) -> Result<serde_json::Value, String> {
    let service = library::services::get(&service)?;
    let (dir, profile) = load_instance(&name)?;

    let label = install_job_label(&title, service.info().name);
    begin_job(&label, 3, "download")?;

    let label_bg = label.clone();
    std::thread::spawn(move || {
        let request = library::services::FileRequest {
            category,
            project_id,
            version_id: None,
            minecraft_version: profile.version_id,
            loader: profile.core.to_string(),
        };
        let result = runtime().block_on(library::services::install(
            service,
            &request,
            &dir,
            &job_progress_callback(label_bg.clone(), "download"),
        ));

        let mut state = install_state().lock().unwrap_or_else(|e| e.into_inner());
        state.active.remove(&label_bg);
        if let Err(e) = &result {
            eprintln!("[minecraft] Install failed for '{}': {}", label_bg, e);
            state.last_error = Some((label_bg.clone(), e.clone()));
        }
    });

    Ok(serde_json::json!({ "status": "installing", "job": label }))
}

/// The `active`/`last_error` key an export job is tracked under, distinct from the instance name
/// `create_modpack` uses so an export next to an install of the same instance doesn't clobber its
/// entry. Shown verbatim in the bottom bar.
fn export_job_label(name: &str) -> String {
    format!("{} (export)", name)
}

/// Turns `library::export`/`import`'s format-agnostic progress ticks into `install_state()`
/// updates, so exports/imports show in the bottom progress bar with no frontend change. `job_type`
/// is fixed per caller (see `InstallProgress`).
fn job_progress_callback(label: String, job_type: &str) -> library::export::ProgressCallback {
    let job_type = job_type.to_string();
    std::sync::Arc::new(move |p: library::export::ExportProgress| {
        install_state().lock().unwrap_or_else(|e| e.into_inner()).active.insert(
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
                job_type: job_type.clone(),
            },
        );
    })
}

/// The instance's profile as it goes into a `Full` export: what says how to run the game stays, what
/// belongs to this player (Java path, play time, the link to a published pack, images) does not.
fn shareable_profile_json(profile: &MinecraftProfile) -> Result<Vec<u8>, String> {
    let mut shared = profile.clone();
    shared.java_path = None;
    shared.play_secs = 0;
    shared.play_stats = Default::default();
    shared.last_played = None;
    shared.pack = None;
    shared.downloaded = false;
    shared.source = None;
    shared.icon = None;
    shared.banner = None;
    shared.missing_files = Vec::new();
    serde_json::to_vec_pretty(&shared).map_err(|e| e.to_string())
}

/// Exports an instance as a self-contained archive in this project's own format, Share's first
/// option: `mode` `"full"` (plain files and `profile.nihao`) or `"compress"` (manifest and
/// `overrides/`, the default). `include` is the paths checked in the Share modal
/// (`list_export_entries`). Runs in the background; the frontend watches
/// `get_install_status`/`export_job_label(name)` disappear. See
/// `library::export::export_own_format` and MODPACK_FORMAT.md.
pub fn export_modpack_own(name: String, include: Vec<String>, dest_path: String, mode: Option<String>) -> Result<serde_json::Value, String> {
    let path = library::context::game_path()?;
    let dir = instance_dir(&path, &name);
    let profile = runtime()
        .block_on(MinecraftProfile::load(&dir))
        .map_err(|e| format!("Instance '{}' not found: {}", name, e))?;

    let (id, pack_name, build, version) = match &profile.pack {
        Some(pack) => (pack.id.clone(), pack.name.clone(), pack.build, pack.version.clone()),
        None => (name.clone(), profile.display_name.clone(), 1, None),
    };

    let mode = library::export::OwnMode::from_str(mode.as_deref().unwrap_or("compress"));
    let profile_json = shareable_profile_json(&profile)?;

    let label = export_job_label(&name);
    begin_job(&label, if mode == library::export::OwnMode::Full { 1 } else { 2 }, "unknown")?;

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
            mode,
            profile_json,
            PathBuf::from(dest_path),
            job_progress_callback(label_bg.clone(), "unknown"),
        ));

        let mut state = install_state().lock().unwrap_or_else(|e| e.into_inner());
        state.active.remove(&label_bg);
        if let Err(e) = &result {
            eprintln!("[minecraft] Export failed for '{}': {}", name_bg, e);
            state.last_error = Some((label_bg.clone(), e.clone()));
        }
    });

    Ok(serde_json::json!({ "status": "exporting" }))
}

/// Exports an instance as a standard Modrinth `.mrpack`, Share's second option. `include` as in
/// `export_modpack_own`, same background-job shape. See `library::export::export_mrpack`.
pub fn export_modpack_mrpack(name: String, include: Vec<String>, dest_path: String) -> Result<serde_json::Value, String> {
    let path = library::context::game_path()?;
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
    begin_job(&label, 3, "unknown")?;

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
            job_progress_callback(label_bg.clone(), "unknown"),
        ));

        let mut state = install_state().lock().unwrap_or_else(|e| e.into_inner());
        state.active.remove(&label_bg);
        if let Err(e) = &result {
            eprintln!("[minecraft] Export failed for '{}': {}", name_bg, e);
            state.last_error = Some((label_bg.clone(), e.clone()));
        }
    });

    Ok(serde_json::json!({ "status": "exporting" }))
}

/// Registers a new pack on the NiHao server (`POST /minecraft/modpacks`): the one-time step before
/// an instance's first `publish_modpack_build`; not needed for later builds of the same pack. The
/// `id` is server-generated (see `library::online_modpacks::register`), so the frontend must use
/// the returned one for the next call.
pub fn register_online_modpack(name: String, visibility: String) -> Result<serde_json::Value, String> {
    let session_token = library::context::session_token()?;
    let id = runtime().block_on(library::online_modpacks::register(&session_token, &name, &visibility))?;
    Ok(serde_json::json!({ "id": id }))
}

/// "Publish to NiHao", Share's third option. Builds the `modpack.nihao` + `override/` archive
/// (`library::export::export_for_publish`; anything Modrinth hosts is referenced by URL, never
/// re-uploaded) on a background thread (same progress convention as the other exports), then
/// uploads it to `POST /minecraft/modpacks/{id}/builds`. On success saves the server's manifest as
/// `profile.pack`, so a later build picks up the right `id`/`build`.
pub fn publish_modpack_build(
    name: String,
    id: String,
    include: Vec<String>,
    version: Option<String>,
) -> Result<serde_json::Value, String> {
    let path = library::context::game_path()?;
    let session_token = library::context::session_token()?;
    let dir = instance_dir(&path, &name);
    let profile = runtime()
        .block_on(MinecraftProfile::load(&dir))
        .map_err(|e| format!("Instance '{}' not found: {}", name, e))?;

    let label = export_job_label(&name);
    begin_job(&label, 2, "upload")?;

    let label_bg = label.clone();
    let name_bg = name.clone();
    let dir_bg = dir.clone();
    let minecraft_version = profile.version_id.clone();
    let loader_enum = profile.core.clone();
    let loader_version = profile.loader_version.clone();
    let icon_filename = profile.icon.clone();
    let banner_filename = profile.banner.clone();
    let publish_version = version.clone();
    let id_bg = id.clone();
    println!("[minecraft:publish] Publish requested for instance '{}' -> pack '{}' (version: {:?})", name, id_bg, publish_version);
    std::thread::spawn(move || {
        let result: Result<(), String> = runtime().block_on(async {
            let zip_path = std::env::temp_dir().join(format!(
                "nihao-publish-{}-{}.zip",
                name_bg,
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis())
                    .unwrap_or(0)
            ));

            library::export::export_for_publish(
                dir_bg.clone(),
                publish_version,
                minecraft_version.clone(),
                loader_enum,
                loader_version.clone(),
                include.into_iter().collect(),
                zip_path.clone(),
                job_progress_callback(label_bg.clone(), "upload"),
            )
            .await?;
            println!("[minecraft:publish] Archive built, starting upload for pack '{}'...", id_bg);

            install_state().lock().unwrap_or_else(|e| e.into_inner()).active.insert(label_bg.clone(), InstallProgress {
                name: label_bg.clone(),
                etap: "Uploading".to_string(),
                current_etaps: 2,
                total_etaps: 2,
                current_file: 0,
                total_files: 0,
                status: "write".to_string(),
                filename: String::new(),
                job_type: "upload".to_string(),
            });

            // The pack's custom icon/banner (if set) ride along with the build upload; a missing
            // or unreadable file means no custom icon, not a publish failure.
            let icon_bytes = match &icon_filename {
                Some(name) => tokio::fs::read(dir_bg.join(name)).await.ok(),
                None => None,
            };
            let banner_bytes = match &banner_filename {
                Some(name) => tokio::fs::read(dir_bg.join(name)).await.ok(),
                None => None,
            };

            let manifest_json = library::online_modpacks::publish_build(
                &session_token,
                &id,
                &zip_path,
                icon_bytes,
                banner_bytes,
            )
            .await;

            let _ = tokio::fs::remove_file(&zip_path).await;
            let manifest_json = manifest_json.inspect_err(|e| {
                println!("[minecraft:publish] Upload failed for pack '{}': {}", id_bg, e);
            })?;
            let manifest: ModpackManifest =
                serde_json::from_value(manifest_json).map_err(|e| format!("Invalid manifest from server: {e}"))?;
            println!("[minecraft:publish] Upload succeeded, saving build #{} locally...", manifest.build);

            let mut profile = MinecraftProfile::load(&dir_bg).await?;
            profile.pack = Some(manifest);
            profile.save(&dir_bg).await?;
            println!("[minecraft:publish] Done — instance '{}' now tracks pack '{}'.", name_bg, id_bg);
            Ok(())
        });

        let mut state = install_state().lock().unwrap_or_else(|e| e.into_inner());
        state.active.remove(&label_bg);
        if let Err(e) = &result {
            eprintln!("[minecraft:publish] Publish failed for '{}': {}", name_bg, e);
            state.last_error = Some((label_bg.clone(), e.clone()));
        }
    });

    Ok(serde_json::json!({ "status": "publishing" }))
}

/// Data for the "Publish" settings panel: an instance tracking a `pack` doesn't know its
/// `visibility` or ownership locally (server-side only), so this refetches the caller's pack list
/// and picks `profile.pack.id`. `None` = no longer visible to this account; the frontend then only
/// offers "detach".
pub fn get_modpack_publish_info(id: String) -> Result<serde_json::Value, String> {
    let session_token = library::context::session_token()?;
    let modpacks = runtime().block_on(library::online_modpacks::list(&session_token, false))?;
    let found = modpacks.into_iter().find(|m| m.id == id);
    println!(
        "[minecraft:publish] Ownership check for pack '{}': {}",
        id,
        match &found {
            Some(m) => format!("found, is_owner={}, visibility={}, latest_build={}", m.is_owner, m.visibility, m.latest_build),
            None => "not found for this account".to_string(),
        }
    );
    Ok(match found {
        Some(m) => serde_json::json!({ "visibility": m.visibility, "is_owner": m.is_owner, "latest_build": m.latest_build }),
        None => serde_json::Value::Null,
    })
}

/// Renames the pack and/or flips its visibility server-side (`PATCH /minecraft/modpacks/{id}`),
/// distinct from the local `display_name` (`rename_modpack`). Owner-only; a non-owner gets the
/// server's `403` as-is.
pub fn update_modpack_publish(id: String, name: Option<String>, visibility: Option<String>) -> Result<serde_json::Value, String> {
    let session_token = library::context::session_token()?;
    runtime().block_on(library::online_modpacks::update(&session_token, &id, name.as_deref(), visibility.as_deref()))?;
    Ok(serde_json::json!({ "status": "ok" }))
}

/// Invites `login` to an invite-only pack (`POST /minecraft/modpacks/{id}/access`).
pub fn invite_to_modpack_publish(id: String, login: String) -> Result<serde_json::Value, String> {
    let session_token = library::context::session_token()?;
    runtime().block_on(library::online_modpacks::invite(&session_token, &id, &login))?;
    Ok(serde_json::json!({ "status": "ok" }))
}

/// Whether the caller can view/create modpacks (`GET /minecraft/modpacks/permissions`), so the
/// frontend hides the Public tab / "Publish to NiHao" up front (neither permission is granted to
/// non-developers by default, see API.md) instead of showing a raw `403`.
pub fn get_modpack_permissions() -> Result<serde_json::Value, String> {
    let session_token = library::context::session_token()?;
    let (can_view, can_create) = runtime().block_on(library::online_modpacks::permissions(&session_token))?;
    Ok(serde_json::json!({ "can_view": can_view, "can_create": can_create }))
}

/// "Detach": stops tracking the pack locally (`profile.pack = None`) without touching the server
/// (pack, builds, other players' copies). Purely local, so it needs no `session_token`. The next
/// publish registers a fresh pack.
pub fn unlink_modpack_publish(name: String) -> Result<serde_json::Value, String> {
    let path = library::context::game_path()?;
    let dir = instance_dir(&path, &name);
    runtime().block_on(async {
        let mut profile = MinecraftProfile::load(&dir)
            .await
            .map_err(|e| format!("Instance '{}' not found: {}", name, e))?;
        profile.pack = None;
        profile.save(&dir).await
    })?;
    Ok(serde_json::json!({ "status": "ok" }))
}

/// "Detach" from the service an instance was installed from (ours, Modrinth, CurseForge): it
/// becomes a custom instance again, free to edit. Purely local: its files and the files it still
/// lacks (`missing_files`) are left as they are.
pub fn detach_modpack(name: String) -> Result<serde_json::Value, String> {
    let path = library::context::game_path()?;
    let dir = instance_dir(&path, &name);
    runtime().block_on(async {
        let mut profile = MinecraftProfile::load(&dir)
            .await
            .map_err(|e| format!("Instance '{}' not found: {}", name, e))?;
        profile.pack = None;
        profile.downloaded = false;
        profile.source = None;
        profile.save(&dir).await
    })?;
    Ok(serde_json::json!({ "status": "ok" }))
}

/// Deletes the pack server-side (`DELETE /minecraft/modpacks/{id}`): owner-only, irreversible (all
/// builds, icon/banner, access grants; no soft-delete). Also detaches this instance (`profile.pack
/// = None`). The frontend must confirm with the player first; nothing here asks twice.
pub fn delete_online_modpack(name: String, id: String) -> Result<serde_json::Value, String> {
    let path = library::context::game_path()?;
    let session_token = library::context::session_token()?;
    runtime().block_on(library::online_modpacks::delete(&session_token, &id))?;
    let dir = instance_dir(&path, &name);
    runtime().block_on(async {
        let mut profile = MinecraftProfile::load(&dir)
            .await
            .map_err(|e| format!("Instance '{}' not found: {}", name, e))?;
        profile.pack = None;
        profile.save(&dir).await
    })?;
    Ok(serde_json::json!({ "status": "ok" }))
}

/// Parses a `.zip`/`.mrpack`'s metadata (name/game version/loader) without extracting or
/// downloading anything, to preview the "Install modpack" screen. A `.zip` with neither of our
/// manifests comes back as `ImportPreview.format == "raw"`, with `minecraft_version`/`loader` left
/// for the player.
pub fn peek_modpack_file(source_path: String) -> Result<library::import::ImportPreview, String> {
    library::import::peek(Path::new(&source_path))
}

/// Imports a `.zip`/`.mrpack` as a new instance (Share's counterpart). `source_path` is a natively
/// picked file, `name` the instance to create (from `peek_modpack_file`).
/// `minecraft_version`/`loader`/`loader_version` override the preview and are only sent for a
/// `"raw"` pack. Same background-job shape as `create_modpack`, which supplies the
/// client/libraries/assets (no pack format bundles them). See `library::import` and
/// MODPACK_FORMAT.md.
pub fn import_modpack(
    name: String,
    source_path: String,
    minecraft_version: Option<String>,
    loader: Option<String>,
    loader_version: Option<String>,
    icon_url: Option<String>,
    banner_url: Option<String>,
    source: Option<library::profile::ModpackSource>,
) -> Result<serde_json::Value, String> {
    let path = library::context::game_path()?;
    let dir = instance_dir(&path, &name);
    // A new instance only: importing over an existing one would replace its profile (RAM, java,
    // play time, the link to its pack) and lay the pack's files over its own.
    if dir.exists() {
        return Err(format!("An instance named '{}' already exists", name));
    }
    ensure_idle(&name)?;
    let mut preview = library::import::peek(Path::new(&source_path))?;

    if let Some(v) = minecraft_version {
        preview.minecraft_version = v;
    }
    if let Some(l) = loader {
        preview.loader = l;
    }
    if loader_version.is_some() {
        preview.loader_version = loader_version;
    }

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
        downloaded: false,
        play_secs: 0,
        play_stats: Default::default(),
        last_played: None,
        source,
        missing_files: Vec::new(),
    };
    let mut profile = profile;
    // Fetched before the profile is first saved, so the tile never shows the default images first;
    // a missing or failed image just stays unset.
    if let Some(service) = profile.source.as_ref().and_then(|s| library::services::get(&s.service).ok()) {
        let (icon, banner) = runtime().block_on(async {
            tokio::join!(
                async { match &icon_url { Some(url) => service.fetch_icon(url).await, None => None } },
                async { match &banner_url { Some(url) => service.fetch_image(url).await.ok(), None => None } },
            )
        });
        profile.icon = save_image(&dir, ICON_FILE_NAME, icon);
        profile.banner = save_image(&dir, BANNER_FILE_NAME, banner);
    }
    runtime().block_on(profile.save(&dir))?;

    let label = name.clone();
    begin_job(&label, 1, "download")?;

    let dir_bg = dir.clone();
    let path_bg = path.clone();
    let name_bg = name.clone();
    let label_bg = label.clone();
    let source_bg = PathBuf::from(source_path);
    let format = preview.format.clone();
    std::thread::spawn(move || {
        // A pack the market saved in the temp folder goes once imported; one the player picked stays.
        let _downloaded = library::services::TempPack(source_bg.clone());
        let result: Result<(), String> = runtime().block_on(async {
            if format == "own" {
                let manifest = library::import::import_own_format(
                    dir_bg.clone(),
                    source_bg,
                    job_progress_callback(label_bg.clone(), "download"),
                )
                .await?;

                // Now that the real manifest is known (not just `peek()`'s summary), track it as
                // this instance's pack.
                let mut profile = MinecraftProfile::load(&dir_bg).await?;
                profile.pack = Some(manifest);
                profile.save(&dir_bg).await?;
            } else if format == "mrpack" {
                library::import::import_mrpack(
                    dir_bg.clone(),
                    source_bg,
                    false,
                    job_progress_callback(label_bg.clone(), "download"),
                )
                .await?;
            } else if format == "curseforge" {
                let missing = library::import::import_curseforge(
                    dir_bg.clone(),
                    source_bg,
                    false,
                    job_progress_callback(label_bg.clone(), "download"),
                )
                .await?
                .missing;
                if !missing.is_empty() {
                    println!("[minecraft] '{}': {} file(s) must be downloaded by hand.", name_bg, missing.len());
                    let mut profile = MinecraftProfile::load(&dir_bg).await?;
                    profile.missing_files = missing;
                    profile.save(&dir_bg).await?;
                }
            } else {
                library::import::import_raw_zip(
                    dir_bg.clone(),
                    source_bg,
                    job_progress_callback(label_bg.clone(), "download"),
                )
                .await?;
            }

            run_install(&path_bg, &name_bg, &label_bg, "download").await
        });
        finish_job(&label_bg, "Import", &result);
    });

    Ok(serde_json::json!({ "status": "installing", "name": name }))
}

/// "Repair" and "Update/Downgrade" for an instance installed from a service (`profile.source`):
/// applies that service's build `version_id` of the pack, or without it the build the instance
/// already has.
///
/// The same build is a restore: files the pack lists that are missing or broken are fetched again
/// and everything else stays (edited configs included). Another build replaces the files, deletes
/// those of the old build it dropped, and keeps saves, screenshots and settings. Either way the
/// game's own files are re-verified afterwards. Background job like `create_modpack`; a build that
/// can't run here (an unsupported loader) fails before any file is touched.
pub fn sync_modpack(name: String, version_id: Option<String>, version_number: Option<String>) -> Result<serde_json::Value, String> {
    let path = library::context::game_path()?;
    let dir = instance_dir(&path, &name);
    let profile = runtime()
        .block_on(MinecraftProfile::load(&dir))
        .map_err(|e| format!("Instance '{}' not found: {}", name, e))?;
    let source = profile.source.ok_or_else(|| format!("'{}' wasn't installed from a service", name))?;
    let service = library::services::get(&source.service)?;
    if running_state().lock().unwrap_or_else(|e| e.into_inner()).get_mut(&name).is_some_and(|p| matches!(p.child.try_wait(), Ok(None))) {
        return Err(format!("Close '{}' first: its files are in use", name));
    }

    let target = version_id.unwrap_or_else(|| source.version_id.clone());
    let restore = target == source.version_id;
    let job_type = if restore { "repair" } else { "update" };
    begin_job(&name, 1, job_type)?;

    let name_bg = name.clone();
    std::thread::spawn(move || {
        let result: Result<(), String> = runtime().block_on(async {
            let progress = job_progress_callback(name_bg.clone(), job_type);
            progress(library::export::ExportProgress {
                etap: "Downloading modpack".to_string(),
                current_etaps: 0,
                total_etaps: 2,
                current_file: 0,
                total_files: 0,
                status: "check".to_string(),
                filename: String::new(),
            });
            // What the old build added, to find what the new one drops. Without it nothing is deleted.
            // Read before the new build is downloaded: both may be saved under the same file name.
            let old_paths = if restore {
                Vec::new()
            } else {
                let listed = async {
                    let old_pack = library::services::TempPack(
                        library::services::download_modpack(service, &source.project_id, Some(&source.version_id)).await?,
                    );
                    library::import::pack_paths(old_pack.0.clone()).await
                };
                listed.await.unwrap_or_else(|e| {
                    eprintln!("[minecraft] '{}': can't tell which files the old version added ({}); keeping them.", name_bg, e);
                    Vec::new()
                })
            };

            let new_pack = library::services::TempPack(library::services::download_modpack(service, &source.project_id, Some(&target)).await?);
            let preview = library::import::peek(&new_pack.0)?;

            let report = match preview.format.as_str() {
                "mrpack" => library::import::import_mrpack(dir.clone(), new_pack.0.clone(), restore, progress).await?,
                "curseforge" => library::import::import_curseforge(dir.clone(), new_pack.0.clone(), restore, progress).await?,
                other => return Err(format!("A '{}' pack can't be applied to an instance from a service", other)),
            };
            for stale in old_paths.iter().filter(|p| !report.files.contains(p)) {
                if let Ok(file) = library::modpack_format::safe_join(&dir, stale) {
                    let _ = std::fs::remove_file(file);
                }
            }

            let mut profile = MinecraftProfile::load(&dir).await?;
            profile.version_id = preview.minecraft_version;
            profile.core = MinecraftLoader::from_str(&preview.loader);
            profile.loader_version = preview.loader_version;
            if let Some(source) = profile.source.as_mut() {
                source.version_number = version_number.unwrap_or_else(|| target.clone());
                source.version_id = target;
            }
            profile.missing_files = library::missing_files::check(&dir, None, report.missing).missing;
            profile.save(&dir).await?;

            run_install(&path, &name_bg, &name_bg, job_type).await
        });
        finish_job(&name_bg, if restore { "Repair" } else { "Update" }, &result);
    });

    Ok(serde_json::json!({ "status": "installing", "name": name }))
}

/// "Browse" in the Modpack market: searches `service`'s modpacks. No instance exists yet, so
/// `minecraft_version`/`loaders` are player-picked filters rather than implicit from a profile.
pub fn search_modpacks(
    service: String,
    query: String,
    offset: u32,
    limit: u32,
    sort: String,
    minecraft_version: String,
    categories: Vec<String>,
    environments: Vec<String>,
    loaders: Vec<String>,
) -> Result<library::services::BrowseSearchResult, String> {
    runtime().block_on(library::services::get(&service)?.search(&library::services::SearchQuery {
        category: "modpacks".to_string(),
        query,
        minecraft_version,
        offset,
        limit,
        sort,
        categories,
        environments,
        loaders,
        ..Default::default()
    }))
}

/// All builds of a modpack, for the version picker shown before downloading it.
pub fn list_modpack_versions(service: String, project_id: String) -> Result<Vec<library::services::ModpackVersion>, String> {
    runtime().block_on(library::services::get(&service)?.modpack_versions(&project_id))
}

/// Downloads a market result to a temp file and returns its path; the frontend then runs the same
/// `peek_modpack_file` -> `import_modpack` flow as for a local file. See
/// `library::services::download_modpack`.
pub fn download_modpack(service: String, project_id: String, version_id: Option<String>) -> Result<String, String> {
    let service = library::services::get(&service)?;
    let path = runtime().block_on(library::services::download_modpack(service, &project_id, version_id.as_deref()))?;
    Ok(path.to_string_lossy().into_owned())
}

/// Deletes an instance permanently, killing its game first if running (Windows refuses to delete
/// files a running process holds open).
pub fn delete_modpack(name: String) -> Result<serde_json::Value, String> {
    let path = library::context::game_path()?;
    ensure_idle(&name)?;
    if let Some(mut process) = running_state().lock().unwrap_or_else(|e| e.into_inner()).remove(&name) {
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
pub fn duplicate_modpack(name: String, new_name: String) -> Result<serde_json::Value, String> {
    let path = library::context::game_path()?;
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
        // A duplicate is a standalone custom instance: it never keeps the original's server pack
        // link.
        profile.pack = None;
        profile.downloaded = false;
        profile.source = None;
        profile.play_secs = 0;
        profile.play_stats = Default::default();
        profile.last_played = None;
        profile.save(&dst_dir).await
    })?;

    Ok(serde_json::json!({ "status": "ok", "name": new_name }))
}

const ICON_FILE_NAME: &str = "icon";
const BANNER_FILE_NAME: &str = "banner";

/// Copies a picked image into the instance directory as `icon` (no extension; the bytes are kept
/// as-is and browsers sniff the content).
pub fn set_modpack_icon(name: String, icon_source_path: String) -> Result<serde_json::Value, String> {
    let path = library::context::game_path()?;
    let dir = instance_dir(&path, &name);
    let src = Path::new(&icon_source_path);
    check_image_size(src)?;

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
pub fn set_modpack_banner(name: String, banner_source_path: String) -> Result<serde_json::Value, String> {
    let path = library::context::game_path()?;
    let dir = instance_dir(&path, &name);
    let src = Path::new(&banner_source_path);
    check_image_size(src)?;

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
    if let Some(mut process) = running_state().lock().unwrap_or_else(|e| e.into_inner()).remove(&name) {
        let _ = process.child.kill();
        let _ = process.child.wait();
    }
    Ok(serde_json::json!({ "status": "ok" }))
}

/// Scans an instance and writes/overwrites its tracked pack manifest (`pack` in `profile.nihao`):
/// the "publish this as a distributable pack" action and the refresh after applying a diff. See
/// MODPACK_FORMAT.md and `library::modpack_format`.
pub fn generate_modpack_manifest(
    name: String,
    id: String,
    pack_name: String,
    build: u64,
    version: Option<String>,
) -> Result<ModpackManifest, String> {
    let path = library::context::game_path()?;
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
pub fn get_modpack_manifest(name: String) -> Result<Option<ModpackManifest>, String> {
    let path = library::context::game_path()?;
    let dir = instance_dir(&path, &name);
    let profile = runtime()
        .block_on(MinecraftProfile::load(&dir))
        .map_err(|e| format!("Instance '{}' not found: {}", name, e))?;
    Ok(profile.pack)
}

/// Compares the instance's tracked manifest against a `remote` manifest (raw JSON, fetched by the
/// frontend) and reports which files need downloading or deleting.
pub fn diff_modpack_manifest(
    name: String,
    remote: serde_json::Value,
) -> Result<ModpackDiff, String> {
    let path = library::context::game_path()?;
    let remote: ModpackManifest =
        serde_json::from_value(remote).map_err(|e| format!("Invalid remote manifest: {}", e))?;
    let dir = instance_dir(&path, &name);
    let profile = runtime()
        .block_on(MinecraftProfile::load(&dir))
        .map_err(|e| format!("Instance '{}' not found: {}", name, e))?;
    Ok(diff_manifests(profile.pack.as_ref(), &remote))
}

/// Whether the instance `name` has NiHao Client (and which version), the newest build that fits
/// its loader and game version (`null` when none does), and whether that build is newer than the
/// installed one: the launch page's chip, its update button and its "install" notice.
pub fn get_nihao_client_status(name: String) -> Result<serde_json::Value, String> {
    let path = library::context::game_path()?;
    let dir = instance_dir(&path, &name);
    let profile = runtime().block_on(MinecraftProfile::load(&dir))?;
    let build = runtime().block_on(library::nihao_client::find_build(&profile.core.to_string(), &profile.version_id));
    let installed_version = library::nihao_client::installed_version(&dir);
    let update = match (&build, &installed_version) {
        (Some(build), Some(installed)) => library::nihao_client::is_newer(&build.version, installed),
        _ => false,
    };
    Ok(serde_json::json!({
        "installed": library::nihao_client::is_installed(&dir),
        "installed_version": installed_version,
        "build": build,
        "update": update,
    }))
}

/// Adds (or updates) NiHao Client in the instance `name`. A single small jar, so it returns once
/// the file is in place instead of running as a background job.
pub fn install_nihao_client(name: String) -> Result<(), String> {
    let path = library::context::game_path()?;
    ensure_idle(&name)?;
    let dir = instance_dir(&path, &name);
    let profile = runtime().block_on(MinecraftProfile::load(&dir))?;
    runtime().block_on(library::nihao_client::install(&dir, &profile.core.to_string(), &profile.version_id))?;
    Ok(())
}


#[cfg(test)]
mod skin_file_tests {
    use super::*;

    /// A PNG's first 24 bytes (signature and the start of IHDR) are all `read_skin_file` looks at.
    fn png_head(width: u32, height: u32) -> Vec<u8> {
        let mut bytes = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, b'I', b'H', b'D', b'R'];
        bytes.extend(width.to_be_bytes());
        bytes.extend(height.to_be_bytes());
        bytes
    }

    #[test]
    fn only_a_64_by_64_png_is_taken_as_a_skin() {
        let dir = std::env::temp_dir().join(format!("nihao-skin-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let write = |name: &str, bytes: &[u8]| {
            let path = dir.join(name);
            std::fs::write(&path, bytes).unwrap();
            path.to_string_lossy().into_owned()
        };
        assert!(read_skin_file(write("ok.png", &png_head(64, 64))).unwrap().starts_with("data:image/png;base64,"));
        assert!(read_skin_file(write("old.png", &png_head(64, 32))).unwrap_err().contains("64x64"));
        assert!(read_skin_file(write("fake.png", b"not a png at all, just text....")).unwrap_err().contains("not a PNG"));
        assert!(read_skin_file(write("skin.txt", &png_head(64, 64))).unwrap_err().contains(".png"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
