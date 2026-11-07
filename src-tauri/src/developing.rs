use std::env;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use lazy_static::lazy_static;
use notify_debouncer_mini::{new_debouncer, notify::RecursiveMode};

use crate::plugins::loader::Plugin;
use crate::LOADED_PLUGINS;
use crate::platforms::{kill_process_tree, no_window, npm, own_console};

static RELOAD_COUNTER: AtomicU64 = AtomicU64::new(0);

lazy_static! {
    static ref DEV_UI_CHILD: Mutex<Option<Child>> = Mutex::new(None);
}

pub fn init_dev_mode() {
    // A release build ignores any `.env` next to the exe: it is a developer's file.
    if !cfg!(debug_assertions) {
        return;
    }
    if let Err(e) = dotenvy::dotenv() {
        println!("No .env file found: {}", e);
        return;
    }

    if let Ok(module_name) = env::var("DEV_MODULE") {
        println!("Development mode active for module: {}", module_name);

        // Load through the staged-copy path used for hot-reload (`rebuild_and_reload`):
        // `Plugin::load`'s direct path would lock `target/debug/{module}.dll` and `cargo build`
        // could never overwrite it.
        if let Err(e) = rebuild_and_reload(&module_name) {
            eprintln!("Failed to load dev module '{}':\n{}", module_name, e);
        }

        spawn_dev_ui_server(&module_name);
        watch_module_source(module_name);
    }
}

fn module_ui_dir(module_name: &str) -> PathBuf {
    PathBuf::from("../plugin-sources/games")
        .join(module_name)
        .join("ui")
}

/// Starts the module's own `npm run dev` (its UI's Vite dev server) so `cargo tauri dev` is the
/// only command a module author runs. If something already listens on `DEV_UI_PORT`, it is left
/// alone.
fn spawn_dev_ui_server(module_name: &str) {
    let ui_dir = module_ui_dir(module_name);
    if !ui_dir.exists() {
        eprintln!(
            "[dev] No UI project at '{}', skipping auto-start.",
            ui_dir.display()
        );
        return;
    }

    let port: u16 = env::var("DEV_UI_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(5173);

    if TcpListener::bind(("127.0.0.1", port)).is_err() {
        println!(
            "[dev] Port {} already in use — assuming the module's UI dev server is already running.",
            port
        );
        return;
    }

    println!(
        "[dev] Starting UI dev server for '{}' on port {}...",
        module_name, port
    );

    let mut cmd = npm();
    cmd.args([
        "run",
        "dev",
        "--",
        "--port",
        &port.to_string(),
        "--strictPort",
    ])
    .current_dir(&ui_dir);
    let child = own_console(&mut cmd).spawn();

    match child {
        Ok(child) => *DEV_UI_CHILD.lock().unwrap() = Some(child),
        Err(e) => eprintln!("[dev] Failed to start UI dev server: {}", e),
    }
}

/// Kills the auto-started UI dev server on app exit so no orphaned `npm`/`vite` stays behind.
///
/// `child` is the `cmd /C npm run dev` wrapper, not `node`: a plain `kill()` would only stop
/// `cmd.exe`, so on Windows the whole tree is killed via `taskkill /T`.
pub fn shutdown_dev_ui_server() {
    if let Some(mut child) = DEV_UI_CHILD.lock().unwrap().take() {
        kill_process_tree(&mut child);
        let _ = child.wait();
    }
}

/// `plugin-sources/common` is a Cargo dependency of `src-tauri`, so Tauri's dev watcher already
/// rebuilds the app when it changes; only the `libloading`-loaded plugin crate needs a watcher of
/// its own.
fn module_source_dir(module_name: &str) -> PathBuf {
    PathBuf::from("../plugin-sources/games")
        .join(module_name)
        .join("src")
}

fn watch_module_source(module_name: String) {
    let watch_dir = module_source_dir(&module_name);
    if !watch_dir.exists() {
        eprintln!(
            "[dev] Cannot watch '{}': directory not found.",
            watch_dir.display()
        );
        return;
    }

    std::thread::spawn(move || {
        let (tx, rx) = std::sync::mpsc::channel();
        let mut debouncer = match new_debouncer(Duration::from_millis(300), tx) {
            Ok(d) => d,
            Err(e) => {
                eprintln!("[dev] Failed to start watcher: {}", e);
                return;
            }
        };

        if let Err(e) = debouncer
            .watcher()
            .watch(&watch_dir, RecursiveMode::Recursive)
        {
            eprintln!("[dev] Failed to watch '{}': {}", watch_dir.display(), e);
            return;
        }

        println!("[dev] Watching '{}' for changes...", watch_dir.display());

        for result in rx {
            match result {
                Ok(events) if !events.is_empty() => {
                    println!("[dev] Change detected, rebuilding '{}'...", module_name);
                    if let Err(e) = rebuild_and_reload(&module_name) {
                        eprintln!("[dev] Reload failed:\n{}", e);
                    }
                }
                Ok(_) => {}
                Err(e) => eprintln!("[dev] Watch error: {}", e),
            }
        }
    });
}

/// Rebuilds the plugin crate and hot-swaps the loaded `.dll`. On a build failure the loaded plugin
/// is left untouched (like Vite HMR keeping the last-good bundle).
fn rebuild_and_reload(module_name: &str) -> Result<(), String> {
    let mut cmd = Command::new("cargo");
    cmd.args(["build", "-p", module_name]);
    let output = no_window(&mut cmd)
        .output()
        .map_err(|e| format!("Failed to spawn cargo build: {}", e))?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).into_owned());
    }

    let dll_name = format!("{}.{}", module_name, std::env::consts::DLL_EXTENSION);
    let built_path = Path::new("../target/debug").join(&dll_name);
    if !built_path.exists() {
        return Err(format!(
            "Built artifact not found: {}",
            built_path.display()
        ));
    }

    // Windows locks a mapped .dll, so `cargo build` must stay free to write `built_path`: load a
    // freshly copied, uniquely named file every time.
    let staging_dir = Path::new("../target/debug/.dev_reload");
    std::fs::create_dir_all(staging_dir).map_err(|e| e.to_string())?;

    let n = RELOAD_COUNTER.fetch_add(1, Ordering::SeqCst);
    let staged_path = staging_dir.join(format!(
        "{}_{}.{}",
        module_name,
        n,
        std::env::consts::DLL_EXTENSION
    ));

    std::fs::copy(&built_path, &staged_path)
        .map_err(|e| format!("Failed to stage reloaded plugin: {}", e))?;

    let new_plugin = Plugin::load_from_path(&staged_path)
        .map_err(|e| format!("Failed to load reloaded plugin: {}", e))?;
    let info = new_plugin.game();

    LOADED_PLUGINS
        .lock()
        .unwrap()
        .insert(module_name.to_string(), std::sync::Arc::new(new_plugin));
    crate::local::push_context(&module_name);

    println!(
        "✅ Module '{}' loaded ({} {}).",
        module_name, info.name, info.version
    );
    Ok(())
}

/// `tag` (when given) is appended as a query string on the `index.tsx` import: each load is a
/// distinct module specifier (forcing a real re-fetch) and `index.tsx` reads it back as the
/// custom-element tag to register (see `GameLoader.tsx`).
pub fn get_dev_ui_script(module: &str, tag: Option<&str>) -> Option<String> {
    // Development builds only: a release must not load a module's UI from whatever listens on a
    // local port because `DEV_MODULE` happens to be set on this PC.
    if !cfg!(debug_assertions) {
        return None;
    }
    // `tag` goes into a script: a custom element name, nothing else.
    if tag.is_some_and(|t| t.is_empty() || !t.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')) {
        return None;
    }
    let dev_module = env::var("DEV_MODULE").ok()?;
    let dev_port = env::var("DEV_UI_PORT").unwrap_or_else(|_| "5173".to_string());
    let query = tag.map(|t| format!("?tag={}", t)).unwrap_or_default();

    if module == dev_module {
        Some(format!(
            r#"
            (async () => {{
                await import('http://localhost:{port}/@vite/client');
                await import('http://localhost:{port}/src/index.tsx{query}');
            }})();
            "#,
            port = dev_port, query = query
        ))
    } else {
        None
    }
}
