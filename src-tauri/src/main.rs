#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
pub mod deeplink;
pub mod developing;
pub mod discord_presence;
pub mod language;
pub mod local;
pub mod platforms;
pub mod plugins;
pub mod server_api;
pub mod social_window;
pub mod themes;
pub mod uninstall;
pub mod updater;
#[path = "../../shared/release_lookup.rs"]
mod release_lookup;
#[path = "../../shared/release_sig.rs"]
mod release_sig;

use plugins::loader::Plugin;
use serde_json::Value;
use std::collections::HashMap;
use std::env;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use crate::language::{get_lang, get_lang_list};

lazy_static::lazy_static! {
    /// `Arc` so a caller can clone a plugin out and release this lock before calling into it: a
    /// plugin call can take seconds, and holding the lock would stall every other plugin call, the
    /// `nihao://` protocol and `notify_plugin`.
    pub(crate) static ref LOADED_PLUGINS: Mutex<HashMap<String, Arc<Plugin>>> = Mutex::new(HashMap::new());
}

pub fn get_program_path() -> Result<PathBuf, String> {
    let my_path = match env::current_exe() {
        Ok(path) => path.parent().unwrap().to_path_buf(),
        Err(e) => {
            eprintln!("Error find path: {}", e);
            return Err(format!("Not find my path: {}", e));
        }
    };
    Ok(my_path)
}

#[tauri::command]
fn list_modules() -> Vec<String> {
    let plugins = LOADED_PLUGINS.lock().unwrap();
    plugins.keys().cloned().collect()
}

/// Loads the module `plugins/<name>.dll` at start. Not a command: the page must not be able to load
/// (or replace) a module while its threads are running.
fn load_plugin(name: &str) -> Result<String, String> {
    match Plugin::load(name) {
        Ok(plugin) => {
            let info = plugin.game();
            let game_name = info.name;
            let game_version = info.version;
            LOADED_PLUGINS.lock().unwrap().insert(name.to_string(), Arc::new(plugin));
            local::push_context(name);
            Ok(format!("Loaded plugin: {game_name} ({game_version})"))
        }
        Err(e) => Err(format!("Failed to load plugin: {}", e)),
    }
}

#[tauri::command]
async fn call_module(module: String, method: String, args: Value) -> Result<Value, String> {
    let plugin = get_plugin(&module).ok_or_else(|| format!("Module '{}' not loaded", module))?;
    // Plugin calls are synchronous and can block for seconds (server pings, big file reads): keep
    // them off the async workers so one slow call cannot stall every other command.
    tauri::async_runtime::spawn_blocking(move || plugin.call(&method, args))
        .await
        .map_err(|e| e.to_string())?
}

pub(crate) fn get_plugin(name: &str) -> Option<Arc<Plugin>> {
    LOADED_PLUGINS.lock().unwrap().get(name).cloned()
}

/// Backend -> plugin push (session token, game path, ...): best-effort, a plugin that doesn't
/// implement `method` just answers "not found", which is ignored. Frontend never sees these.
pub(crate) fn notify_plugin(name: &str, method: &str, args: Value) {
    if let Some(plugin) = get_plugin(name) {
        let _ = plugin.call(method, args);
    }
}

/// Calls `method` on every loaded plugin and returns the successful answers (plugins that don't
/// implement it, or fail, are skipped).
pub(crate) fn collect_from_plugins(method: &str, args: Value) -> Vec<Value> {
    let plugins: Vec<Arc<Plugin>> = LOADED_PLUGINS.lock().unwrap().values().cloned().collect();
    plugins.iter().filter_map(|p| p.call(method, args.clone()).ok()).collect()
}

#[tauri::command]
fn get_module_ui(module: String, tag: Option<String>) -> Result<String, String> {
    if let Some(script) = developing::get_dev_ui_script(&module, tag.as_deref()) {
        return Ok(script);
    }

    get_plugin(&module)
        .map(|plugin| plugin.get_ui_bundle())
        .ok_or_else(|| format!("Module '{}' not loaded", module))
}

#[tauri::command]
async fn init_local_data() -> Result<local::LocalClientView, String> {
    if !local::NHDataClient::is_alive().await? {
        return Err("data_not_alive".to_string());
    }
    local::load_view().await
}

#[tauri::command]
async fn save_local_data(data: local::LocalClientInput) -> Result<local::LocalClientView, String> {
    local::save_from_frontend(data).await
}

#[tauri::command]
async fn load_game_settings(path: String) -> Result<Value, String> {
    local::load_game_settings(&path).await
}

#[tauri::command]
async fn save_game_settings(path: String, settings: Value) -> Result<(), String> {
    local::save_game_settings(&path, &settings).await
}

/// Toggled from TS (`setLocalClient`) whenever `local.data` loads/changes, so the Rust-side
/// connection matches `interface.discord_presence_enabled`.
#[tauri::command]
fn discord_presence_set_enabled(enabled: bool) -> Result<(), String> {
    discord_presence::set_enabled(enabled)
}

/// Called by a game module (`LauncherBridge.reportPlayingActivity`) when a play session
/// starts/stops; `game`/`detail` both `None` = stopped. Takes precedence over
/// `discord_presence_set_browsing`. `nickname` is the small image's hover tooltip.
/// `join_label`/`join_url` (both or neither) add an activity button, e.g. "Play together" (a
/// `nihaolauncher://` deep link, see `deeplink.rs`).
#[tauri::command]
fn discord_presence_set_playing(
    game: Option<String>,
    detail: Option<String>,
    nickname: Option<String>,
    join_label: Option<String>,
    join_url: Option<String>,
    status: Option<String>,
    large_image: Option<String>,
    large_text: Option<String>,
    link_label: Option<String>,
    link_url: Option<String>,
) -> Result<(), String> {
    discord_presence::set_playing(game, detail, nickname, join_label, join_url, status, large_image, large_text, link_label, link_url)
}

/// Called on every route change with the current `/gm/:gameId` section's display name, or `None`
/// outside any game section.
#[tauri::command]
fn discord_presence_set_browsing(game: Option<String>) -> Result<(), String> {
    discord_presence::set_browsing(game)
}

/// A launcher-window input pulse (throttled) that resets the AFK timer.
#[tauri::command]
fn discord_presence_notify_active() -> Result<(), String> {
    discord_presence::notify_active()
}

fn load_all_plugins() {
    // Relative to the exe's location, not the CWD (see `Plugin::resolve_path`).
    let plugins_dir = match get_program_path() {
        Ok(dir) => dir.join("plugins"),
        Err(e) => {
            eprintln!("Cannot resolve program path, skipping plugin auto-load: {}", e);
            return;
        }
    };
    let _ = std::fs::create_dir_all(&plugins_dir);

    if let Ok(entries) = std::fs::read_dir(&plugins_dir) {
        println!("--- Loading Modules ---");
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) == Some(std::env::consts::DLL_EXTENSION) {
                if let Some(name) = path.file_stem().and_then(|s| s.to_str()) {
                    match load_plugin(name) {
                        Ok(_) => println!("✅ Module '{}' loaded.", name),
                        Err(e) => eprintln!("❌ Failed to load '{}': {}", name, e),
                    }
                }
            }
        }
        println!("-----------------------");
    }
}

#[tauri::command]
fn get_dev_module() -> Option<String> {
    // Only a development build has a module under development.
    cfg!(debug_assertions).then(|| std::env::var("DEV_MODULE").ok()).flatten()
}

fn main() {
    developing::init_dev_mode();

    updater::cleanup_previous_update_artifacts();

    load_all_plugins();

    // Re-registers `nihaolauncher://` on every startup (idempotent, self-heals if the exe moved).
    // This process's argv is how a cold launch via the scheme reaches us; a warm one is forwarded
    // by the single-instance plugin below.
    deeplink::register_protocol();
    deeplink::handle_cold_start(&env::args().collect::<Vec<_>>());

    tauri::Builder::default()
        // Must be registered first (per tauri-plugin-single-instance): folds a second
        // `nihaolauncher://...` launch into this running instance instead of opening a new window.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if !uninstall::handle_second_instance(app, &argv) {
                deeplink::handle_second_instance(app, argv);
            }
        }))
        .register_uri_scheme_protocol("nihao", |_app, request| {
            let res = (|| -> Result<_, Box<dyn std::error::Error>> {
                let uri = request.uri();
                let parsed_url = url::Url::parse(uri)?;
                let module_name = parsed_url.host_str().ok_or("Missing host")?;
                let asset_path = parsed_url.path().trim_start_matches('/');

                if let Some(plugin) = get_plugin(module_name) {
                    if let Some(data) = plugin.get_asset_data(asset_path) {
                        let mime = mime_guess::from_path(asset_path).first_raw().unwrap_or("application/octet-stream");
                        
                        let response = tauri::http::ResponseBuilder::new()
                            .header("Content-Type", mime)
                            .header("Access-Control-Allow-Origin", "*")
                            .status(200)
                            .body(data)?;
                        return Ok(response);
                    }
                }

                let not_found = tauri::http::ResponseBuilder::new()
                    .status(404)
                    .body(Vec::new())?;
                Ok(not_found)
            })();
            res
        })
        .invoke_handler(tauri::generate_handler![
            list_modules,
            get_lang_list,
            get_lang,
            init_local_data,
            save_local_data,
            load_game_settings,
            save_game_settings,
            discord_presence_set_enabled,
            discord_presence_set_playing,
            discord_presence_set_browsing,
            discord_presence_notify_active,
            deeplink::take_pending_deep_link,
            call_module,
            get_module_ui,
            get_dev_module,
            server_api::server_request_code,
            server_api::server_verify_code,
            server_api::server_logout,
            server_api::server_get_profile,
            server_api::server_get_user_profile,
            server_api::server_update_profile,
            server_api::server_upload_avatar,
            server_api::server_get_friends,
            server_api::server_send_friend_request,
            server_api::server_accept_friend_request,
            server_api::server_decline_friend_request,
            server_api::server_get_friend_requests,
            server_api::server_check_alive,
            server_api::server_version,
            server_api::server_connect_stream,
            server_api::server_disconnect_stream,
            updater::check_for_update,
            updater::get_latest_release,
            updater::install_update,
            updater::relaunch_app,
            updater::take_pending_update_info,
            themes::list_themes,
            themes::get_theme_bundle,
            themes::open_themes_dir,
            themes::is_safe_mode,
            uninstall::is_uninstall_mode,
            uninstall::get_uninstall_options,
            uninstall::uninstall_apply,
            social_window::open_social_window,
            social_window::close_social_window,
            social_window::is_social_window_open,
            social_window::show_main_and_navigate
        ])
        .setup(|app| {
            // Windows refuses to raise a window of a process it did not just start from the foreground
            // (a launch from the installer, a shortcut): a toggle of always-on-top gets it past that.
            if let Some(window) = tauri::Manager::get_window(app, "main") {
                let _ = window.set_always_on_top(true);
                let _ = window.set_always_on_top(false);
                let _ = window.set_focus();
            }
            Ok(())
        })
        .on_window_event(|event| social_window::on_window_event(event.window(), event.event()))
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                developing::shutdown_dev_ui_server();
                let _ = discord_presence::set_enabled(false);
            }
        });
}
