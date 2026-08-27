//! Talks to the NiHaoLauncher server (see API.md) from the Rust side, not the webview —
//! a plain browser `fetch`/`EventSource` to `http://127.0.0.1:8080` is cross-origin from the
//! app's own origin (`http://localhost:1420` in dev, `tauri://localhost` in prod) and gets
//! blocked by CORS unless the server opts in. Going through `reqwest` here sidesteps that
//! entirely — this isn't a browser request, so CORS doesn't apply — and lets the SSE stream
//! be read incrementally and forwarded to the frontend as Tauri events.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use futures_util::StreamExt;
use lazy_static::lazy_static;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

const DEFAULT_SERVER_API: &str = "http://127.0.0.1:8080";

fn server_api_base() -> String {
    std::env::var("SERVER_API").unwrap_or_else(|_| DEFAULT_SERVER_API.to_string())
}

#[derive(Deserialize, Serialize, Debug, Clone)]
pub struct AuthUser {
    pub login: String,
    pub displayname: String,
    #[serde(default)]
    pub role: Option<String>,
    #[serde(default)]
    pub avatar: Option<String>,
}

/// The server hands back `avatar` as a path relative to its own origin (e.g. `/avatars/42.png`,
/// see `avatar_upload_handler` in the server's `general` fragment) — resolve it against
/// `server_api_base()` here so the frontend can use it directly in an `<img src>` without also
/// needing to know the server's address.
fn resolve_avatar(mut user: AuthUser) -> AuthUser {
    if let Some(avatar) = &user.avatar {
        if !avatar.starts_with("http://") && !avatar.starts_with("https://") {
            user.avatar = Some(format!("{}{}", server_api_base(), avatar));
        }
    }
    user
}

#[derive(Deserialize, Serialize, Debug, Clone)]
pub struct AuthTokens {
    pub session_token: String,
    pub refresh_token: String,
    pub user: AuthUser,
}

async fn parse_error(res: reqwest::Response) -> String {
    let status = res.status();
    match res.json::<Value>().await {
        Ok(body) => body
            .get("error")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| format!("Request failed ({status})")),
        Err(_) => format!("Request failed ({status})"),
    }
}

#[tauri::command]
pub async fn server_login(login_id: String, password: String) -> Result<AuthTokens, String> {
    let res = Client::new()
        .post(format!("{}/auth/login", server_api_base()))
        .json(&json!({ "login": login_id, "password": password }))
        .send()
        .await
        .map_err(|e| format!("Cannot reach server: {e}"))?;

    if !res.status().is_success() {
        return Err(parse_error(res).await);
    }
    let mut tokens = res
        .json::<AuthTokens>()
        .await
        .map_err(|e| format!("Invalid response from server: {e}"))?;
    tokens.user = resolve_avatar(tokens.user);
    Ok(tokens)
}

#[tauri::command]
pub async fn server_logout(session_token: String) -> Result<(), String> {
    let _ = Client::new()
        .post(format!("{}/auth/logout", server_api_base()))
        .bearer_auth(session_token)
        .send()
        .await;
    Ok(())
}

#[tauri::command]
pub async fn server_change_password(
    session_token: String,
    current_password: String,
    new_password: String,
) -> Result<(), String> {
    let res = Client::new()
        .post(format!("{}/profile/me/password", server_api_base()))
        .bearer_auth(session_token)
        .json(&json!({ "current_password": current_password, "new_password": new_password }))
        .send()
        .await
        .map_err(|e| format!("Cannot reach server: {e}"))?;

    if !res.status().is_success() {
        return Err(parse_error(res).await);
    }
    Ok(())
}

#[tauri::command]
pub async fn server_get_session(session_token: String) -> Result<AuthUser, String> {
    let res = Client::new()
        .get(format!("{}/auth/session", server_api_base()))
        .bearer_auth(session_token)
        .send()
        .await
        .map_err(|e| format!("Cannot reach server: {e}"))?;

    if !res.status().is_success() {
        return Err(parse_error(res).await);
    }
    let user = res
        .json::<AuthUser>()
        .await
        .map_err(|e| format!("Invalid response from server: {e}"))?;
    Ok(resolve_avatar(user))
}

/// Cheap reachability probe — no health endpoint exists, so this just hits `/auth/session`
/// with no token and treats any completed HTTP response (even the expected 401) as "the
/// server is up"; only a failed/timed-out request means it isn't.
#[tauri::command]
pub async fn server_check_alive() -> bool {
    Client::new()
        .get(format!("{}/auth/session", server_api_base()))
        .timeout(Duration::from_secs(4))
        .send()
        .await
        .is_ok()
}

lazy_static! {
    static ref STREAM_TASK: Mutex<Option<tauri::async_runtime::JoinHandle<()>>> = Mutex::new(None);
}

#[derive(Serialize, Clone)]
#[serde(tag = "kind")]
enum ConnectionEvent {
    Auth {
        session_token: String,
        refresh_token: String,
        user: AuthUser,
    },
    Unauthorized {
        message: String,
    },
    /// The connect request itself never got a response — the server isn't reachable at all.
    Unreachable,
    /// A stream that did successfully open later ended (drained cleanly or dropped mid-session).
    Closed,
}

fn emit_connection(window: &tauri::Window, event: ConnectionEvent) {
    let _ = window.emit("connection-event", event);
}

/// Opens `GET /connection/stream?token=<refresh_token>` and streams events to the frontend
/// via the `connection-event` Tauri event as they arrive. Replaces any stream already in
/// flight. Fire-and-forget from the caller's perspective — see `server_disconnect_stream`.
///
/// Spawns via `tauri::async_runtime::spawn`, not `tokio::spawn` directly: this command is a
/// plain synchronous `fn`, so Tauri invokes it inline on its event loop rather than inside a
/// task on its own async runtime — there's no Tokio reactor active at that point for a bare
/// `tokio::spawn` to attach to. Tauri's wrapper holds its own handle to the runtime it
/// started at boot, so it works regardless of the calling context.
#[tauri::command]
pub fn server_connect_stream(window: tauri::Window, refresh_token: String) {
    if let Some(handle) = STREAM_TASK.lock().unwrap().take() {
        handle.abort();
    }
    let handle = tauri::async_runtime::spawn(async move {
        run_stream(window, refresh_token).await;
    });
    *STREAM_TASK.lock().unwrap() = Some(handle);
}

#[tauri::command]
pub fn server_disconnect_stream() {
    if let Some(handle) = STREAM_TASK.lock().unwrap().take() {
        handle.abort();
    }
}

/// The client-side retry loop (`AuthContext.tsx`) calls this every few seconds while the
/// server stays unreachable — logging the identical "connection refused" on every single
/// attempt would spam the console for as long as the server is down. Print it once, then stay
/// quiet until something actually changes (a real response, of any kind).
static UNREACHABLE_LOGGED: AtomicBool = AtomicBool::new(false);

async fn run_stream(window: tauri::Window, refresh_token: String) {
    let url = format!(
        "{}/connection/stream?token={}",
        server_api_base(),
        refresh_token
    );

    let res = match Client::new().get(url).send().await {
        Ok(res) => res,
        Err(e) => {
            if !UNREACHABLE_LOGGED.swap(true, Ordering::Relaxed) {
                eprintln!("Connection stream unreachable: {e} (further identical failures are logged only once until this changes)");
            }
            emit_connection(&window, ConnectionEvent::Unreachable);
            return;
        }
    };
    UNREACHABLE_LOGGED.store(false, Ordering::Relaxed);

    if res.status() == reqwest::StatusCode::UNAUTHORIZED {
        let message = parse_error(res).await;
        emit_connection(&window, ConnectionEvent::Unauthorized { message });
        return;
    }
    if !res.status().is_success() {
        emit_connection(&window, ConnectionEvent::Unreachable);
        return;
    }

    let mut stream = res.bytes_stream();
    let mut buffer = String::new();

    while let Some(chunk) = stream.next().await {
        let chunk = match chunk {
            Ok(c) => c,
            Err(e) => {
                eprintln!("Connection stream read error: {e}");
                break;
            }
        };
        buffer.push_str(&String::from_utf8_lossy(&chunk));

        while let Some(sep) = buffer.find("\n\n") {
            let frame: String = buffer.drain(..sep + 2).collect();
            handle_frame(&window, &frame);
        }
    }

    emit_connection(&window, ConnectionEvent::Closed);
}

fn handle_frame(window: &tauri::Window, frame: &str) {
    let mut event_name = "message".to_string();
    let mut data_lines = Vec::new();

    for line in frame.lines() {
        if line.starts_with(':') {
            continue; // keep-alive comment
        }
        if let Some(rest) = line.strip_prefix("event:") {
            event_name = rest.trim().to_string();
        } else if let Some(rest) = line.strip_prefix("data:") {
            data_lines.push(rest.trim().to_string());
        }
    }
    if data_lines.is_empty() {
        return;
    }
    let data = data_lines.join("\n");

    if event_name == "auth" {
        match serde_json::from_str::<AuthTokens>(&data) {
            Ok(tokens) => emit_connection(
                window,
                ConnectionEvent::Auth {
                    session_token: tokens.session_token,
                    refresh_token: tokens.refresh_token,
                    user: resolve_avatar(tokens.user),
                },
            ),
            Err(e) => eprintln!("Malformed auth event from connection stream: {e}"),
        }
    }
    // Future event types (friend online/offline, ...) will be handled here once they exist server-side.
}
