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

#[cfg(windows)]
use std::os::windows::process::CommandExt;

/// Silent one-shot helpers (`cargo build`, `taskkill`) get no console at all — nothing the
/// user needs to watch live. Without this, Windows auto-allocates a console for them since
/// they run detached from any terminal the user can see.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;
/// The module's UI dev server *is* meant to be watched, so it gets its own console window
/// instead — `CREATE_NEW_CONSOLE` makes that explicit rather than relying on whatever
/// Windows decides to auto-allocate (which was landing on top of the launcher's window).
#[cfg(windows)]
const CREATE_NEW_CONSOLE: u32 = 0x00000010;

#[cfg(windows)]
fn no_window(cmd: &mut Command) -> &mut Command {
    cmd.creation_flags(CREATE_NO_WINDOW)
}
#[cfg(not(windows))]
fn no_window(cmd: &mut Command) -> &mut Command {
    cmd
}

#[cfg(windows)]
fn own_console(cmd: &mut Command) -> &mut Command {
    cmd.creation_flags(CREATE_NEW_CONSOLE)
}
#[cfg(not(windows))]
fn own_console(cmd: &mut Command) -> &mut Command {
    cmd
}

static RELOAD_COUNTER: AtomicU64 = AtomicU64::new(0);

lazy_static! {
    static ref DEV_UI_CHILD: Mutex<Option<Child>> = Mutex::new(None);
}

pub fn init_dev_mode() {
    // Load .env file
    if let Err(e) = dotenvy::dotenv() {
        println!("No .env file found: {}", e);
        return;
    }

    // Check if DEV_MODULE is set
    if let Ok(module_name) = env::var("DEV_MODULE") {
        println!("Development mode active for module: {}", module_name);

        // Load through the same staged-copy path used for hot-reload (see `rebuild_and_reload`)
        // instead of `Plugin::load`'s direct path — otherwise this first load would lock
        // `target/debug/{module}.dll` itself, and `cargo build` could never overwrite it later.
        if let Err(e) = rebuild_and_reload(&module_name) {
            eprintln!("Failed to load dev module '{}':\n{}", module_name, e);
        }

        spawn_dev_ui_server(&module_name);
        watch_module_source(module_name);
    }
}

/// `plugin-sources/games/{module}/ui` — the module's own Vite/React sub-project.
fn module_ui_dir(module_name: &str) -> PathBuf {
    PathBuf::from("../plugin-sources/games")
        .join(module_name)
        .join("ui")
}

/// Starts the module's own `npm run dev` (its UI's Vite dev server) so `cargo tauri dev`
/// is the only command a module author needs to run. If something is already listening on
/// `DEV_UI_PORT` (e.g. started manually), it's left alone instead of spawning a duplicate.
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

    let mut cmd = Command::new("cmd");
    cmd.args([
        "/C",
        "npm",
        "run",
        "dev",
        "--",
        "--port",
        &port.to_string(),
        "--strictPort",
    ])
    .current_dir(&ui_dir);
    // Own console window, not redirected — a new console needs its own I/O handles,
    // not the launcher's inherited ones.
    let child = own_console(&mut cmd).spawn();

    match child {
        Ok(child) => *DEV_UI_CHILD.lock().unwrap() = Some(child),
        Err(e) => eprintln!("[dev] Failed to start UI dev server: {}", e),
    }
}

/// Kills the auto-started UI dev server, if any. Called on app exit so closing the
/// launcher doesn't leave an orphaned `npm`/`vite` process behind.
///
/// `child` here is the `cmd /C npm run dev` wrapper, not `node` itself — plain
/// `child.kill()` would only kill `cmd.exe` and leave the actual Vite/node process running,
/// so on Windows we kill the whole process tree via `taskkill /T`.
pub fn shutdown_dev_ui_server() {
    if let Some(mut child) = DEV_UI_CHILD.lock().unwrap().take() {
        #[cfg(windows)]
        {
            let mut cmd = Command::new("taskkill");
            cmd.args(["/PID", &child.id().to_string(), "/T", "/F"]);
            let _ = no_window(&mut cmd).output();
        }
        #[cfg(not(windows))]
        {
            let _ = child.kill();
        }
        let _ = child.wait();
    }
}

/// `plugin-sources/common` is a real Cargo dependency of `src-tauri`, so Tauri's own
/// dev-mode Rust watcher already rebuilds+restarts the whole app when it changes.
/// Only the dynamically `libloading`-loaded plugin crate needs a watcher of its own.
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

        // Keeps the debouncer (and therefore the watch) alive for as long as this thread runs.
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

/// Rebuilds the plugin crate and hot-swaps the loaded `.dll` in place. On a build failure
/// the currently loaded plugin is left untouched, mirroring how Vite HMR keeps serving the
/// last-good frontend bundle after a compile error.
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

    // Windows locks a .dll file while it's mapped into this process, so `cargo build` must
    // always be free to write to `built_path` — we load a freshly copied, uniquely named
    // file instead of the original every time.
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
        .insert(module_name.to_string(), new_plugin);

    println!(
        "✅ Module '{}' loaded ({} {}).",
        module_name, info.name, info.version
    );
    Ok(())
}

/// `tag` (when given) is appended as a query string on the `index.tsx` import — this makes
/// each load a distinct module specifier from the browser's point of view, forcing a real
/// re-fetch instead of reusing whatever was imported under that same bare URL earlier in
/// the session, and lets `index.tsx` read back the custom-element tag name the host wants
/// it to register under this time (see `GameLoader.tsx`).
pub fn get_dev_ui_script(module: &str, tag: Option<&str>) -> Option<String> {
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
