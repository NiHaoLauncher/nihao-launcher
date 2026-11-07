//! The friends list lives in its own OS window, not the main one. The frontend only calls these
//! commands (it never creates windows itself) and the windows talk via events:
//!
//! - `social-window-state` (to `main`): `true` when the window opens, `false` when it is gone;
//! - `navigate` (to `main`): a path the main window should go to (e.g. a friend's profile) after it
//! is brought to the front.

use tauri::{AppHandle, Manager, Window, WindowBuilder, WindowEvent, WindowUrl};

pub const SOCIAL: &str = "social";
const MAIN: &str = "main";

fn emit_state(app: &AppHandle, open: bool) {
    if let Some(main) = app.get_window(MAIN) {
        let _ = main.emit("social-window-state", open);
    }
}

/// Opens the friends window — or, if it is already open, brings it to the front.
/// `async`: a command that builds a window must not run on the main thread (it would deadlock on
/// Windows).
#[tauri::command]
pub async fn open_social_window(app: AppHandle) -> Result<(), String> {
    if let Some(existing) = app.get_window(SOCIAL) {
        let _ = existing.unminimize();
        let _ = existing.show();
        return existing.set_focus().map_err(|e| e.to_string());
    }
    // `?window=social` makes the frontend render the friends view instead of the whole launcher.
    WindowBuilder::new(&app, SOCIAL, WindowUrl::App("index.html?window=social".into()))
        .title("NiHao — Social")
        .inner_size(340.0, 640.0)
        .min_inner_size(280.0, 360.0)
        .resizable(true)
        .decorations(true)
        .build()
        .map_err(|e| e.to_string())?;
    emit_state(&app, true);
    Ok(())
}

#[tauri::command]
pub fn close_social_window(app: AppHandle) {
    if let Some(w) = app.get_window(SOCIAL) {
        let _ = w.close();
    }
}

#[tauri::command]
pub fn is_social_window_open(app: AppHandle) -> bool {
    app.get_window(SOCIAL).is_some()
}

/// Brings the main window to the front and tells it to go to `path` (e.g. `/profile/someone`).
/// The path has to be an in-app route: it is only ever handed to the frontend's own router.
#[tauri::command]
pub fn show_main_and_navigate(app: AppHandle, path: String) -> Result<(), String> {
    if !path.starts_with('/') || path.starts_with("//") || path.len() > 200 {
        return Err("not an in-app path".to_string());
    }
    let main = app.get_window(MAIN).ok_or("main window is gone")?;
    let _ = main.unminimize();
    let _ = main.show();
    let _ = main.set_focus();
    main.emit("navigate", path).map_err(|e| e.to_string())
}

/// Window lifecycle: closing the main window takes the friends window with it (it is useless
/// without the launcher), and the friends window going away tells the main one.
pub fn on_window_event(window: &Window, event: &WindowEvent) {
    match (window.label(), event) {
        (MAIN, WindowEvent::CloseRequested { .. }) => {
            if let Some(social) = window.app_handle().get_window(SOCIAL) {
                let _ = social.close();
            }
        }
        (SOCIAL, WindowEvent::Destroyed) => emit_state(&window.app_handle(), false),
        _ => {}
    }
}
