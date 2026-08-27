#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
pub mod developing;
pub mod language;
pub mod local;
pub mod plugins;
pub mod server_api;
pub mod updater;

use plugins::loader::Plugin;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::env;
use std::path::PathBuf;
use std::sync::Mutex;
use sysinfo::System;

use crate::language::{get_lang, get_lang_list};

lazy_static::lazy_static! {
    pub(crate) static ref LOADED_PLUGINS: Mutex<HashMap<String, Plugin>> = Mutex::new(HashMap::new());
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
async fn get_virtual_memory() -> u64 {
    let mut sys = System::new();
    sys.refresh_memory();
    let total_memory_kb = sys.total_memory();
    return total_memory_kb / 1024;
}

/// Returns total RAM in MB
#[tauri::command]
async fn get_total_ram_mb() -> u64 {
    let mut sys = System::new();
    sys.refresh_memory();
    // sysinfo returns bytes
    sys.total_memory() / (1024 * 1024)
}

#[tauri::command]
fn list_modules() -> Vec<String> {
    let plugins = LOADED_PLUGINS.lock().unwrap();
    plugins.keys().cloned().collect()
}

#[tauri::command]
fn load_plugin(name: &str) -> Result<String, String> {
    match Plugin::load(name) {
        Ok(plugin) => {
            let info = plugin.game();
            let game_name = info.name;
            let game_version = info.version;
            LOADED_PLUGINS.lock().unwrap().insert(name.to_string(), plugin);
            Ok(format!("Loaded plugin: {game_name} ({game_version})"))
        }
        Err(e) => Err(format!("Failed to load plugin: {}", e)),
    }
}

#[tauri::command]
async fn call_module(module: String, method: String, args: Value) -> Result<Value, String> {
    let plugins = LOADED_PLUGINS.lock().unwrap();
    if let Some(plugin) = plugins.get(&module) {
        plugin.call(&method, args)
    } else {
        Err(format!("Module '{}' not loaded", module))
    }
}

#[tauri::command]
fn get_module_ui(module: String, tag: Option<String>) -> Result<String, String> {
    // Check for dev mode redirection
    if let Some(script) = developing::get_dev_ui_script(&module, tag.as_deref()) {
        return Ok(script);
    }

    let plugins = LOADED_PLUGINS.lock().unwrap();
    if let Some(plugin) = plugins.get(&module) {
        Ok(plugin.get_ui_bundle())
    } else {
        Err(format!("Module '{}' not loaded", module))
    }
}

#[tauri::command]
async fn init_local_data() -> Result<Value, String> {
    if !local::NHDataClient::is_alive().await? {
        return Err("data_not_alive".to_string());
    }
    let local_account = local::NHDataClient::import()
        .await
        .map_err(|e| e.to_string())?;
    Ok(json!(local_account))
}
#[tauri::command]
async fn save_local_data(data: local::NHDataClient) -> Result<(), String> {
    data.save().await
}

#[tauri::command]
async fn load_game_settings(path: String) -> Result<Value, String> {
    local::load_game_settings(&path).await
}

#[tauri::command]
async fn save_game_settings(path: String, settings: Value) -> Result<(), String> {
    local::save_game_settings(&path, &settings).await
}

fn load_all_plugins() {
    // Relative to the exe's own location, not the process's CWD — see the matching note on
    // `Plugin::resolve_path` for why that distinction matters here.
    let plugins_dir = match get_program_path() {
        Ok(dir) => dir.join("plugins"),
        Err(e) => {
            eprintln!("Cannot resolve program path, skipping plugin auto-load: {}", e);
            return;
        }
    };
    // Create directory if not exists
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
    std::env::var("DEV_MODULE").ok()
}

fn main() {
    // Initialize development mode if configured in .env
    developing::init_dev_mode();

    // Clean up leftovers from a previous self-update before anything else touches those files
    updater::cleanup_previous_update_artifacts();

    // Auto-load all modules from plugins/ folder
    load_all_plugins();

    tauri::Builder::default()
        .register_uri_scheme_protocol("nihao", |_app, request| {
            let res = (|| -> Result<_, Box<dyn std::error::Error>> {
                let uri = request.uri();
                let parsed_url = url::Url::parse(uri)?;
                let module_name = parsed_url.host_str().ok_or("Missing host")?;
                let asset_path = parsed_url.path().trim_start_matches('/');

                let plugins = LOADED_PLUGINS.lock().unwrap();
                if let Some(plugin) = plugins.get(module_name) {
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
            load_plugin,
            get_virtual_memory,
            get_total_ram_mb,
            get_lang_list,
            get_lang,
            init_local_data,
            save_local_data,
            load_game_settings,
            save_game_settings,
            call_module,
            get_module_ui,
            get_dev_module,
            server_api::server_login,
            server_api::server_logout,
            server_api::server_get_session,
            server_api::server_change_password,
            server_api::server_check_alive,
            server_api::server_connect_stream,
            server_api::server_disconnect_stream,
            updater::check_for_update,
            updater::install_update,
            updater::relaunch_app,
            updater::take_pending_update_info
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                developing::shutdown_dev_ui_server();
            }
        });
}
