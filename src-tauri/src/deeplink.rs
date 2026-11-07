//! Handles `nihaolauncher://` launches, the mechanism behind Discord's "Play Together" button (see
//! `discord_presence.rs`).
//!
//! Two parts: (1) per-user OS registration on every launch (`register_protocol`, Windows-only for
//! now, `HKEY_CURRENT_USER` so no elevation) so the OS runs this exe with the URL as an argument;
//! (2) picking the URL out of argv, on a cold start (`main()` checks its own `env::args()`) or a
//! warm one (`tauri-plugin-single-instance` forwards the second launch's argv to
//! `handle_second_instance`).
//!
//! The parsed target is stashed in `PENDING` for the frontend to pull via `take_pending_deep_link`
//! (like `updater::take_pending_update_info`): an event fired before any listener attaches would be
//! dropped. The warm case also emits a live `"deep-link"` event.

use std::sync::Mutex;
use tauri::Manager;

// Deliberately not "nihao": that scheme is Tauri's internal `register_uri_scheme_protocol("nihao",
// ...)` asset loader in main.rs. They would never collide at runtime (webview vs OS), but sharing
// a name would be a landmine.
const SCHEME: &str = "nihaolauncher";

static PENDING: Mutex<Option<DeepLink>> = Mutex::new(None);

/// `nihaolauncher://<kind>/<segment>/...`, e.g. `play-together/minecraft/<packId>` parses to `{
/// kind: "play-together", segments: ["minecraft", "<packId>"] }`. What the segments mean is up to
/// the feature that builds the link and the frontend that consumes it (`App.tsx` routes on
/// `segments[0]` as a game id and hands the rest to that module via
/// `LauncherBridge.pendingDeepLink`).
#[derive(Clone, serde::Serialize)]
pub struct DeepLink {
    pub kind: String,
    pub segments: Vec<String>,
}

/// Parses the first `nihaolauncher://...` argument out of a raw arg list (this process's
/// `env::args()` or another instance's forwarded argv); everything else is ignored. `None` is the
/// ordinary case.
pub fn parse_from_args<S: AsRef<str>>(args: &[S]) -> Option<DeepLink> {
    let prefix = format!("{SCHEME}://");
    let url = args.iter().map(|a| a.as_ref()).find(|a| a.starts_with(&prefix))?;
    let rest = url.strip_prefix(&prefix)?.trim_end_matches('/');
    let mut parts = rest.split('/').filter(|s| !s.is_empty());
    let kind = parts.next()?.to_string();
    let segments = parts.map(|s| s.to_string()).collect();
    Some(DeepLink { kind, segments })
}

/// Cold start: called once from `main()` before the frontend mounts; just queues the link for
/// `take_pending_deep_link`.
pub fn handle_cold_start<S: AsRef<str>>(args: &[S]) {
    if let Some(link) = parse_from_args(args) {
        *PENDING.lock().unwrap() = Some(link);
    }
}

/// Warm start: `tauri-plugin-single-instance` fired because a second launch was folded into this
/// running instance. Queues the link (in case nothing listens yet), emits it immediately and brings
/// the window to the front.
pub fn handle_second_instance(app: &tauri::AppHandle, argv: Vec<String>) {
    if let Some(link) = parse_from_args(&argv) {
        *PENDING.lock().unwrap() = Some(link.clone());
        let _ = app.emit_all("deep-link", &link);
    }
    if let Some(window) = app.get_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

#[tauri::command]
pub fn take_pending_deep_link() -> Option<DeepLink> {
    PENDING.lock().unwrap().take()
}

/// Registers `nihaolauncher://` with Windows so opening a link re-launches this exe with the URL as
/// its argument. Per-user (`HKEY_CURRENT_USER`), no elevation. Idempotent: rewritten on every
/// startup so a moved exe self-heals. Best-effort: a failure only means the link does nothing.
pub fn register_protocol() {
    crate::platforms::register_protocol(SCHEME);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_link_is_found_among_other_arguments_and_split_into_parts() {
        let link = parse_from_args(&["app.exe", "--flag", "nihaolauncher://play-together/minecraft/abc123/"]).unwrap();
        assert_eq!(link.kind, "play-together");
        assert_eq!(link.segments, ["minecraft", "abc123"]);
    }

    #[test]
    fn what_is_not_a_link_is_nothing() {
        assert!(parse_from_args(&["app.exe"]).is_none());
        assert!(parse_from_args(&["app.exe", "https://example.com/x"]).is_none());
        assert!(parse_from_args(&["nihaolauncher://"]).is_none());
        assert!(parse_from_args(&["nihaolauncher:///"]).is_none());
        // Empty segments are dropped, and the link carries nothing but text for the page to route.
        let link = parse_from_args(&["nihaolauncher://open//x///../y"]).unwrap();
        assert_eq!((link.kind.as_str(), link.segments.as_slice()), ("open", ["x".to_string(), "..".to_string(), "y".to_string()].as_slice()));
    }
}
