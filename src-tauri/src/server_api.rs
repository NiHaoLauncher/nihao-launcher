//! Talks to the NiHaoLauncher server (DOCUMENTATION/server) from Rust, not the webview: a browser
//! fetch to the server is cross-origin and blocked by CORS, and the single WebSocket the whole API
//! runs on lives here, so it survives the frontend's render lifecycle.
//!
//! Signing in is plain HTTPS (an emailed code); everything after that is operations on the one
//! WebSocket (`call`), whose events are forwarded to the frontend.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use futures_util::{SinkExt, StreamExt};
use hmac::{Hmac, Mac};
use lazy_static::lazy_static;   
use reqwest::Client;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::Sha256;
use tauri::Manager;
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::tungstenite::Message;

const DEFAULT_SERVER_API: &str = "https://nihao.bogdancater.dev/api";

/// The server's address. A release always uses the one built in; only a development build lets
/// `SERVER_API` (the environment or `.env`) point somewhere else. A release that took it from the
/// environment would send the refresh token wherever that variable says.
fn server_api_base() -> String {
    if cfg!(debug_assertions) {
        if let Ok(base) = std::env::var("SERVER_API") {
            return base;
        }
    }
    DEFAULT_SERVER_API.to_string()
}

/// `{server}/seg1/seg2/...` with every segment percent-encoded, so a user-supplied value can't
/// turn into a different endpoint or a query string.
fn api_url(segments: &[&str]) -> String {
    let base = server_api_base();
    match reqwest::Url::parse(&base) {
        Ok(mut url) => {
            if let Ok(mut path) = url.path_segments_mut() {
                path.pop_if_empty().extend(segments);
            }
            url.to_string()
        }
        Err(_) => format!("{}/{}", base, segments.join("/")),
    }
}

/// `wss://…/ws`; plain `ws://` only when a development build points `SERVER_API` at an http server.
fn ws_url() -> Result<String, String> {
    let mut url = reqwest::Url::parse(&server_api_base()).map_err(|e| format!("Bad server address: {e}"))?;
    let scheme = if url.scheme() == "http" { "ws" } else { "wss" };
    url.set_scheme(scheme).map_err(|_| "Bad server address".to_string())?;
    url.path_segments_mut().map_err(|_| "Bad server address".to_string())?.pop_if_empty().push("ws");
    Ok(url.to_string())
}

lazy_static! {
    /// The newest `refresh_token`, held in memory (and mirrored into `local.data` once a profile
    /// exists). Credentials never reach the frontend: it only ever sees `linked`/`status`.
    static ref REFRESH_TOKEN: Mutex<Option<String>> = Mutex::new(None);
    static ref DEVICE_ID: Mutex<Option<String>> = Mutex::new(None);
}

pub fn remembered_refresh_token() -> Option<String> {
    REFRESH_TOKEN.lock().unwrap().clone()
}

/// Remembers a new (or cleared) refresh token and persists it to `local.data` in the background.
fn remember_refresh_token(token: Option<String>) {
    *REFRESH_TOKEN.lock().unwrap() = token.clone();
    tauri::async_runtime::spawn(async move { crate::local::store_refresh_token(token).await });
}

/// This install's random `device_id`, created on first use and kept in `device.id` next to the
/// executable. Never derived from hardware; the refresh token is bound to it.
fn device_id() -> Result<String, String> {
    let mut cached = DEVICE_ID.lock().unwrap();
    if let Some(id) = cached.as_ref() {
        return Ok(id.clone());
    }
    let path: PathBuf = crate::get_program_path()?.join("device.id");
    let id = match std::fs::read_to_string(&path).map(|s| s.trim().to_string()) {
        Ok(id) if !id.is_empty() => id,
        _ => {
            let id = uuid::Uuid::new_v4().to_string();
            launcher_common::write_atomic(&path, id.as_bytes())?;
            id
        }
    };
    *cached = Some(id.clone());
    Ok(id)
}

/// The key id and secret that prove this is a genuine build (security.md, "The client proof"),
/// baked in by `build.rs` from `NIHAO_BUILD_KEY_ID`/`NIHAO_BUILD_KEY` (environment or `.env`).
fn build_key() -> Option<(String, String)> {
    Some((option_env!("NIHAO_BUILD_KEY_ID")?.to_string(), option_env!("NIHAO_BUILD_KEY")?.to_string()))
}

/// `base64url(HMAC-SHA256(build_key, "nihao-proof-v1" 0 challenge 0 device_id 0 version))`, no padding.
fn client_proof(build_key: &str, challenge: &str, device_id: &str, version: &str) -> String {
    let mut mac = Hmac::<Sha256>::new_from_slice(build_key.as_bytes()).expect("HMAC accepts any key length");
    mac.update(format!("nihao-proof-v1\0{challenge}\0{device_id}\0{version}").as_bytes());
    URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
}

#[derive(Deserialize, Serialize, Debug, Clone)]
pub struct AuthUser {
    pub login: String,
    pub displayname: String,
    #[serde(default)]
    pub avatar: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
}

/// An HTTP error body is `{ "error": message, "code", "retry_after"? }`; `429`s say when to retry.
async fn parse_error(res: reqwest::Response) -> String {
    let status = res.status();
    match res.json::<Value>().await {
        Ok(body) => {
            let message = body.get("error").and_then(|v| v.as_str()).map(str::to_string);
            let retry = body.get("retry_after").and_then(|v| v.as_u64());
            match (message, retry) {
                (Some(m), Some(s)) => format!("{m} (try again in {s}s)"),
                (Some(m), None) => m,
                _ => format!("Request failed ({status})"),
            }
        }
        Err(_) => format!("Request failed ({status})"),
    }
}

/// `POST /auth/login`: the server emails `email` a one-time code. Returns how many seconds it
/// stays valid.
#[tauri::command]
pub async fn server_request_code(email: String) -> Result<u64, String> {
    let res = Client::new()
        .post(api_url(&["auth", "login"]))
        .json(&json!({ "email": email }))
        .send()
        .await
        .map_err(|e| format!("Cannot reach server: {e}"))?;
    if !res.status().is_success() {
        return Err(parse_error(res).await);
    }
    let body: Value = res.json().await.map_err(|e| format!("Invalid response from server: {e}"))?;
    Ok(body.get("expires_in").and_then(|v| v.as_u64()).unwrap_or(0))
}

/// `POST /auth/verify`: trades the emailed code for a refresh token (kept in the backend). The
/// frontend then opens the connection (`server_connect_stream`), which is what goes online.
#[tauri::command]
pub async fn server_verify_code(email: String, code: String) -> Result<AuthUser, String> {
    #[derive(Deserialize)]
    struct Verified {
        refresh_token: String,
        user: AuthUser,
    }
    let res = Client::new()
        .post(api_url(&["auth", "verify"]))
        .json(&json!({ "email": email, "code": code, "device_id": device_id()? }))
        .send()
        .await
        .map_err(|e| format!("Cannot reach server: {e}"))?;
    if !res.status().is_success() {
        return Err(parse_error(res).await);
    }
    let verified: Verified = res.json().await.map_err(|e| format!("Invalid response from server: {e}"))?;
    remember_refresh_token(Some(verified.refresh_token));
    Ok(verified.user)
}

/// Ends this device's session (`session.logout` revokes the refresh token), then stops the
/// connection. Signed out locally even if the server can't be told.
#[tauri::command]
pub async fn server_logout() -> Result<(), String> {
    let _ = call("session.logout", json!({})).await;
    server_disconnect_stream();
    remember_refresh_token(None);
    Ok(())
}

/// `GET /health`: the server is up only if it answers `200 {"ok": true, …}`. A proxy in front of a
/// dead server (Cloudflare's 521/522 page) also answers, so "any answer" is not enough.
#[tauri::command]
pub async fn server_check_alive() -> bool {
    let Ok(res) = Client::new().get(api_url(&["health"])).timeout(Duration::from_secs(4)).send().await else {
        return false;
    };
    res.status().is_success()
        && res.json::<Value>().await.is_ok_and(|body| body.get("ok").and_then(|v| v.as_bool()) == Some(true))
}

/// The server's version from `/health`; `None` when it does not answer.
#[tauri::command]
pub async fn server_version() -> Option<String> {
    let res = Client::new().get(api_url(&["health"])).timeout(Duration::from_secs(4)).send().await.ok()?;
    let body = res.error_for_status().ok()?.json::<Value>().await.ok()?;
    body.get("version")?.as_str().map(str::to_string)
}

type Reply = Result<Value, String>;

lazy_static! {
    /// Frames to send on the open connection; `None` while there is none.
    static ref OUT: Mutex<Option<mpsc::UnboundedSender<String>>> = Mutex::new(None);
    /// Requests waiting for their response, by `id`.
    static ref PENDING: Mutex<HashMap<String, oneshot::Sender<Reply>>> = Mutex::new(HashMap::new());
}

const CONNECTION_LOST: &str = "Connection to the server was lost";

/// How long an operation waits for its response.
const CALL_TIMEOUT: Duration = Duration::from_secs(15);

/// Forgets the connection and fails every request still waiting on it.
fn drop_connection() {
    *OUT.lock().unwrap() = None;
    for (_, waiter) in PENDING.lock().unwrap().drain() {
        let _ = waiter.send(Err(CONNECTION_LOST.to_string()));
    }
}

/// A WebSocket error object (`{ code, message, retry_after }`) as the text shown to the user.
fn error_text(error: &Value) -> String {
    let message = error.get("message").and_then(|v| v.as_str()).unwrap_or("Request failed");
    match error.get("retry_after").and_then(|v| v.as_u64()) {
        Some(s) => format!("{message} (try again in {s}s)"),
        None => message.to_string(),
    }
}

/// Runs one operation on the open connection and returns its `data`.
async fn call(op: &str, params: Value) -> Reply {
    let out = OUT.lock().unwrap().clone().ok_or_else(|| "Not signed in".to_string())?;
    let id = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = oneshot::channel();
    PENDING.lock().unwrap().insert(id.clone(), tx);
    if out.send(json!({ "id": id, "op": op, "params": params }).to_string()).is_err() {
        PENDING.lock().unwrap().remove(&id);
        return Err(CONNECTION_LOST.to_string());
    }
    match tokio::time::timeout(CALL_TIMEOUT, rx).await {
        Ok(Ok(reply)) => reply,
        Ok(Err(_)) => Err(CONNECTION_LOST.to_string()),
        Err(_) => {
            PENDING.lock().unwrap().remove(&id);
            Err("The server did not answer in time".to_string())
        }
    }
}

async fn call_as<T: DeserializeOwned>(op: &str, params: Value) -> Result<T, String> {
    serde_json::from_value(call(op, params).await?).map_err(|e| format!("Invalid response from server: {e}"))
}

/// Hands a response to whoever is waiting for its `id`.
fn deliver(message: &Value) {
    let Some(id) = message.get("id").and_then(|v| v.as_str()) else { return };
    let Some(waiter) = PENDING.lock().unwrap().remove(id) else { return };
    let reply = if message.get("ok").and_then(|v| v.as_bool()) == Some(true) {
        Ok(message.get("data").cloned().unwrap_or(Value::Null))
    } else {
        Err(error_text(message.get("error").unwrap_or(&Value::Null)))
    };
    let _ = waiter.send(reply);
}

/// `profile.me` / `profile.get`: the shape the server answers with.
#[derive(Deserialize, Serialize, Debug, Clone)]
pub struct Profile {
    pub login: String,
    pub displayname: String,
    #[serde(default)]
    pub avatar: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    /// Only on `profile.get` (someone else's); `None` for your own.
    #[serde(default)]
    pub online: Option<bool>,
    /// Only on `profile.get`: `none`/`friends`/`request_sent`/`request_received`.
    #[serde(default)]
    pub friendship: Option<String>,
}

#[tauri::command]
pub async fn server_get_profile() -> Result<Profile, String> {
    call_as("profile.me", json!({})).await
}

#[tauri::command]
pub async fn server_get_user_profile(login: String) -> Result<Profile, String> {
    call_as("profile.get", json!({ "login": login })).await
}

/// `profile.update`: either field may be `None` to leave it untouched.
#[tauri::command]
pub async fn server_update_profile(displayname: Option<String>, description: Option<String>) -> Result<AuthUser, String> {
    let mut params = serde_json::Map::new();
    if let Some(displayname) = displayname {
        params.insert("displayname".to_string(), Value::String(displayname));
    }
    if let Some(description) = description {
        params.insert("description".to_string(), Value::String(description));
    }
    call_as("profile.update", Value::Object(params)).await
}

/// Avatars never render larger than a small circle, but a camera photo can be tens of MB, past the
/// server's upload limit (5 MB). Downscale (never upscale) within this, keeping aspect
/// ratio, and always re-encode as JPEG: lossless formats compress photos poorly.
const AVATAR_MAX_DIMENSION: u32 = 512;
const AVATAR_JPEG_QUALITY: u8 = 88;

fn resize_avatar(bytes: &[u8]) -> Result<Vec<u8>, String> {
    let img = image::load_from_memory(bytes).map_err(|e| format!("Cannot read image: {e}"))?;
    let img = if img.width() > AVATAR_MAX_DIMENSION || img.height() > AVATAR_MAX_DIMENSION {
        img.resize(AVATAR_MAX_DIMENSION, AVATAR_MAX_DIMENSION, image::imageops::FilterType::Lanczos3)
    } else {
        img
    };
    let rgb = img.to_rgb8();
    let mut out = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, AVATAR_JPEG_QUALITY)
        .encode(&rgb, rgb.width(), rgb.height(), image::ColorType::Rgb8)
        .map_err(|e| format!("Cannot encode image: {e}"))?;
    Ok(out)
}

/// Resizes the image (`resize_avatar`), asks for an upload ticket (`avatar.upload_url`) and `PUT`s
/// the bytes to it. Returns the new avatar's URL.
#[tauri::command]
pub async fn server_upload_avatar(file_path: String) -> Result<String, String> {
    let raw = tokio::fs::read(&file_path).await.map_err(|e| format!("Cannot read file: {e}"))?;
    let bytes = tokio::task::spawn_blocking(move || resize_avatar(&raw))
        .await
        .map_err(|e| format!("Image resize task panicked: {e}"))??;

    let ticket = call("avatar.upload_url", json!({ "size": bytes.len(), "content_type": "image/jpeg" })).await?;
    let url = ticket.get("url").and_then(|v| v.as_str()).ok_or("Server didn't return an upload URL")?;

    let res = Client::new()
        .put(url)
        .header(reqwest::header::CONTENT_TYPE, "image/jpeg")
        .body(bytes)
        .send()
        .await
        .map_err(|e| format!("Cannot reach server: {e}"))?;
    if !res.status().is_success() {
        return Err(parse_error(res).await);
    }
    let body: Value = res.json().await.map_err(|e| format!("Invalid response from server: {e}"))?;
    body.get("avatar")
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .ok_or_else(|| "Server didn't return an avatar URL".to_string())
}

#[derive(Deserialize, Serialize, Debug, Clone)]
pub struct Friend {
    pub login: String,
    pub displayname: String,
    #[serde(default)]
    pub avatar: Option<String>,
    pub online: bool,
}

#[tauri::command]
pub async fn server_get_friends() -> Result<Vec<Friend>, String> {
    #[derive(Deserialize)]
    struct Friends {
        friends: Vec<Friend>,
    }
    Ok(call_as::<Friends>("friends.list", json!({})).await?.friends)
}

#[tauri::command]
pub async fn server_send_friend_request(login: String) -> Result<(), String> {
    call("friends.request", json!({ "login": login })).await.map(|_| ())
}

#[tauri::command]
pub async fn server_accept_friend_request(login: String) -> Result<(), String> {
    call("friends.accept", json!({ "login": login })).await.map(|_| ())
}

#[tauri::command]
pub async fn server_decline_friend_request(login: String) -> Result<(), String> {
    call("friends.decline", json!({ "login": login })).await.map(|_| ())
}

/// A pending request, either one the caller sent (`outgoing`) or received (`incoming`).
#[derive(Deserialize, Serialize, Debug, Clone)]
pub struct FriendRequest {
    pub login: String,
    pub displayname: String,
    #[serde(default)]
    pub avatar: Option<String>,
    #[serde(default)]
    pub created_at: Option<String>,
}

#[derive(Deserialize, Serialize, Debug, Clone)]
pub struct FriendRequests {
    pub incoming: Vec<FriendRequest>,
    pub outgoing: Vec<FriendRequest>,
}

#[tauri::command]
pub async fn server_get_friend_requests() -> Result<FriendRequests, String> {
    call_as("friends.requests", json!({})).await
}

lazy_static! {
    static ref STREAM_TASK: Mutex<Option<tauri::async_runtime::JoinHandle<()>>> = Mutex::new(None);
}

/// Reconnect back-off: 1 s, 2 s, 4 s … up to this, plus jitter, so a server restart doesn't bring
/// every launcher back in the same second.
const MAX_BACKOFF: Duration = Duration::from_secs(60);

/// How long the server gets to send `hello`, and then to answer `auth`.
const HANDSHAKE_WAIT: Duration = Duration::from_secs(15);

const DEFAULT_HEARTBEAT_SECS: u64 = 45;

#[derive(Serialize, Clone)]
#[serde(tag = "kind")]
enum ConnectionEvent {
    /// Credentials stay in the backend; the frontend only learns who is signed in.
    Auth {
        user: AuthUser,
    },
    Unauthorized {
        message: String,
    },
    /// The connect request itself never got a response — the server isn't reachable at all.
    Unreachable,
    /// A connection that did successfully open later ended (closed cleanly or dropped mid-session).
    Closed,
}

fn emit_connection(window: &tauri::Window, event: ConnectionEvent) {
    let _ = window.emit("connection-event", event);
}

/// Opens the WebSocket and keeps it open, forwarding its state to the frontend through the
/// `connection-event` Tauri event; replaces any connection in flight. Fire-and-forget (see
/// `server_disconnect_stream`).
///
/// Owns the whole reconnect lifecycle: `run_stream_loop` retries with back-off until the server
/// says the credentials or this build are no good (`Unauthorized`: stops and surfaces the login
/// form), another device replaces this one, or the task is aborted (`server_disconnect_stream` or a
/// newer connect). It lives here so reconnecting survives independent of the frontend.
///
/// Spawns via `tauri::async_runtime::spawn`, not `tokio::spawn`: this is a plain sync `fn` invoked
/// on Tauri's event loop, with no Tokio reactor for a bare `tokio::spawn` to attach to.
#[tauri::command]
pub fn server_connect_stream(window: tauri::Window) {
    if let Some(handle) = STREAM_TASK.lock().unwrap().take() {
        println!("[connection] Superseding the currently running connection.");
        handle.abort();
    }
    drop_connection();
    let handle = tauri::async_runtime::spawn(async move {
        // The backend owns the credential: in memory if already signed in this run, else the
        // one saved in `local.data`.
        let token = match remembered_refresh_token() {
            Some(t) => Some(t),
            None => crate::local::stored_refresh_token().await,
        };
        let Some(token) = token else {
            emit_connection(&window, ConnectionEvent::Unauthorized { message: "No saved session".to_string() });
            return;
        };
        *REFRESH_TOKEN.lock().unwrap() = Some(token);
        run_stream_loop(window).await;
    });
    *STREAM_TASK.lock().unwrap() = Some(handle);
}

#[tauri::command]
pub fn server_disconnect_stream() {
    if let Some(handle) = STREAM_TASK.lock().unwrap().take() {
        println!("[connection] Disconnecting (requested).");
        handle.abort();
    }
    drop_connection();
}

/// Print "connection refused" once, then stay quiet until something changes, instead of spamming on
/// every reconnect attempt.
static UNREACHABLE_LOGGED: AtomicBool = AtomicBool::new(false);

/// What one connection attempt ended with; `run_stream_loop` decides whether to retry.
enum StreamOutcome {
    /// The server refuses the credentials, this build or this version: stop retrying and let the
    /// frontend show the login form.
    Unauthorized(String),
    Unreachable,
    Closed,
    /// Closed on purpose (`session.logout`) or replaced by this device connecting again: no
    /// automatic reconnect.
    Finished,
}

/// What the next thing on the socket was.
enum Incoming {
    Json(Value),
    /// A ping, pong or other frame with nothing to handle (it still proves the link is alive).
    Frame,
    Closed(Option<u16>),
}

async fn read_incoming<S>(stream: &mut S) -> Incoming
where
    S: futures_util::Stream<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin,
{
    match stream.next().await {
        Some(Ok(Message::Text(text))) => serde_json::from_str(&text).map(Incoming::Json).unwrap_or(Incoming::Frame),
        Some(Ok(Message::Close(frame))) => Incoming::Closed(frame.map(|f| u16::from(f.code))),
        Some(Ok(_)) => Incoming::Frame,
        Some(Err(_)) | None => Incoming::Closed(None),
    }
}

/// What a close code asks of the client (websocket.md, "Close codes").
fn outcome_for_close(code: Option<u16>) -> StreamOutcome {
    match code {
        Some(1000) | Some(4001) => StreamOutcome::Finished,
        Some(4401) => StreamOutcome::Unauthorized("Session expired — sign in again".to_string()),
        Some(4403) => StreamOutcome::Unauthorized(
            "This launcher build was rejected by the server — update or reinstall it".to_string(),
        ),
        Some(4426) => StreamOutcome::Unauthorized("This launcher version is no longer supported — please update".to_string()),
        _ => StreamOutcome::Closed,
    }
}

/// Reads until `done` accepts a message; `Err` is the outcome to give up with (closed, or silent for
/// `HANDSHAKE_WAIT`).
async fn read_until<S>(stream: &mut S, done: impl Fn(&Value) -> bool) -> Result<Value, StreamOutcome>
where
    S: futures_util::Stream<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin,
{
    loop {
        match tokio::time::timeout(HANDSHAKE_WAIT, read_incoming(stream)).await {
            Ok(Incoming::Json(m)) if done(&m) => return Ok(m),
            Ok(Incoming::Json(_)) | Ok(Incoming::Frame) => {}
            Ok(Incoming::Closed(code)) => return Err(outcome_for_close(code)),
            Err(_) => return Err(StreamOutcome::Closed),
        }
    }
}

/// One connect-and-serve attempt. The `bool` says whether `auth` succeeded (it resets the back-off).
async fn run_stream_once(window: &tauri::Window) -> (StreamOutcome, bool) {
    let Some((key_id, build_key)) = build_key() else {
        return (StreamOutcome::Unauthorized("This build has no client key — reinstall the launcher".to_string()), false);
    };
    let (device_id, url, refresh_token) = match (device_id(), ws_url(), remembered_refresh_token()) {
        (Ok(d), Ok(u), Some(t)) => (d, u, t),
        (Err(e), _, _) | (_, Err(e), _) => return (StreamOutcome::Unauthorized(e), false),
        _ => return (StreamOutcome::Unauthorized("No saved session".to_string()), false),
    };

    println!("[connection] Connecting...");
    let socket = match tokio_tungstenite::connect_async(url).await {
        Ok((socket, _)) => socket,
        Err(e) => {
            if !UNREACHABLE_LOGGED.swap(true, Ordering::Relaxed) {
                eprintln!("[connection] Server unreachable: {e} (further identical failures logged only once until this changes)");
            }
            return (StreamOutcome::Unreachable, false);
        }
    };
    UNREACHABLE_LOGGED.store(false, Ordering::Relaxed);
    let (mut sink, mut stream) = socket.split();

    let hello = match read_until(&mut stream, |m| m.get("event").and_then(|v| v.as_str()) == Some("hello")).await {
        Ok(m) => m,
        Err(outcome) => return (outcome, false),
    };
    let Some(challenge) = hello.pointer("/data/challenge").and_then(|v| v.as_str()) else {
        return (StreamOutcome::Closed, false);
    };

    let auth_id = uuid::Uuid::new_v4().to_string();
    let version = env!("CARGO_PKG_VERSION");
    let auth = json!({ "id": auth_id, "op": "auth", "params": {
        "refresh_token": refresh_token,
        "device_id": device_id,
        "client": { "key": key_id, "version": version, "proof": client_proof(&build_key, challenge, &device_id, version) },
        "heartbeat_secs": DEFAULT_HEARTBEAT_SECS,
    } });
    if sink.send(Message::Text(auth.to_string())).await.is_err() {
        return (StreamOutcome::Closed, false);
    }

    let reply = match read_until(&mut stream, |m| m.get("id").and_then(|v| v.as_str()) == Some(auth_id.as_str())).await {
        Ok(m) => m,
        Err(outcome) => return (outcome, false),
    };
    if reply.get("ok").and_then(|v| v.as_bool()) != Some(true) {
        let error = reply.get("error").unwrap_or(&Value::Null);
        let message = error_text(error);
        eprintln!("[connection] Rejected: {message}");
        return match error.get("code").and_then(|v| v.as_str()) {
            Some("unauthorized") | Some("client_rejected") | Some("upgrade_required") => (StreamOutcome::Unauthorized(message), false),
            _ => (StreamOutcome::Closed, false),
        };
    }

    #[derive(Deserialize)]
    struct Authed {
        refresh_token: String,
        user: AuthUser,
        #[serde(default)]
        heartbeat_secs: Option<u64>,
    }
    let authed: Authed = match serde_json::from_value(reply.get("data").cloned().unwrap_or(Value::Null)) {
        Ok(a) => a,
        Err(e) => {
            eprintln!("[connection] Malformed auth reply: {e}");
            return (StreamOutcome::Closed, false);
        }
    };
    // A refresh token is single-use: the new one replaces the old one right away.
    remember_refresh_token(Some(authed.refresh_token));
    println!("[connection] Authenticated as '{}'.", authed.user.login);

    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<String>();
    *OUT.lock().unwrap() = Some(out_tx);
    emit_connection(window, ConnectionEvent::Auth { user: authed.user });

    // Nothing at all for 3 x heartbeat means the link died silently.
    let silence = Duration::from_secs(authed.heartbeat_secs.unwrap_or(DEFAULT_HEARTBEAT_SECS).clamp(20, 90) * 3);
    let dead = tokio::time::sleep(silence);
    tokio::pin!(dead);

    let outcome = loop {
        tokio::select! {
            incoming = read_incoming(&mut stream) => {
                dead.as_mut().reset(tokio::time::Instant::now() + silence);
                match incoming {
                    Incoming::Json(message) => handle_message(window, &message),
                    Incoming::Frame => {}
                    Incoming::Closed(code) => break outcome_for_close(code),
                }
            }
            Some(text) = out_rx.recv() => {
                if sink.send(Message::Text(text)).await.is_err() {
                    break StreamOutcome::Closed;
                }
            }
            _ = &mut dead => {
                eprintln!("[connection] No frames for {}s, treating the connection as dead.", silence.as_secs());
                break StreamOutcome::Closed;
            }
        }
    };
    println!("[connection] Connection closed.");
    (outcome, true)
}

async fn run_stream_loop(window: tauri::Window) {
    let mut failures: u32 = 0;
    loop {
        let (outcome, authed) = run_stream_once(&window).await;
        drop_connection();
        failures = if authed { 0 } else { failures + 1 };
        match outcome {
            StreamOutcome::Unauthorized(message) => {
                println!("[connection] Server refused us, giving up: {message}");
                emit_connection(&window, ConnectionEvent::Unauthorized { message });
                return;
            }
            StreamOutcome::Finished => {
                emit_connection(&window, ConnectionEvent::Closed);
                return;
            }
            StreamOutcome::Unreachable => emit_connection(&window, ConnectionEvent::Unreachable),
            StreamOutcome::Closed => emit_connection(&window, ConnectionEvent::Closed),
        }
        let delay = backoff(failures);
        println!("[connection] Reconnecting in {:.1}s...", delay.as_secs_f32());
        tokio::time::sleep(delay).await;
    }
}

fn backoff(failures: u32) -> Duration {
    let base = Duration::from_secs(1u64 << failures.saturating_sub(1).min(6)).min(MAX_BACKOFF);
    let jitter_ms = u64::from(uuid::Uuid::new_v4().as_bytes()[0]) * 1000 / 255;
    base + Duration::from_millis(jitter_ms)
}

/// A response goes to its waiter; an event goes to every window as `server-event`
/// (`{ event, data }`), for the frontend to refresh what it shows.
fn handle_message(window: &tauri::Window, message: &Value) {
    if message.get("id").is_some() {
        deliver(message);
    } else if let Some(event) = message.get("event").and_then(|v| v.as_str()) {
        let _ = window.app_handle().emit_all("server-event", json!({ "event": event, "data": message.get("data") }));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn client_proof_matches_the_documented_test_vector() {
        assert_eq!(
            client_proof("test-build-key-do-not-use", "Qm9yZWQgb2YgdGhpcz8", "0b1c4f3e-0000-4000-8000-000000000001", "1.4.2"),
            "8P9GiU9WyeFo9PGclU3iFEqYf23xU122iM9RYjGVxDI"
        );
    }

    #[test]
    fn responses_reach_their_waiter_and_errors_say_when_to_retry() {
        let (tx, mut rx) = oneshot::channel();
        PENDING.lock().unwrap().insert("a".into(), tx);
        deliver(&json!({ "id": "a", "ok": true, "data": { "x": 1 } }));
        assert_eq!(rx.try_recv().unwrap().unwrap()["x"], 1);

        let (tx, mut rx) = oneshot::channel();
        PENDING.lock().unwrap().insert("b".into(), tx);
        deliver(&json!({ "id": "b", "ok": false, "error": { "code": "too_many_requests", "message": "slow down", "retry_after": 7 } }));
        assert_eq!(rx.try_recv().unwrap().unwrap_err(), "slow down (try again in 7s)");
    }

    #[test]
    fn close_codes_decide_whether_to_reconnect() {
        assert!(matches!(outcome_for_close(Some(4001)), StreamOutcome::Finished));
        assert!(matches!(outcome_for_close(Some(4403)), StreamOutcome::Unauthorized(_)));
        assert!(matches!(outcome_for_close(Some(4408)), StreamOutcome::Closed));
        assert!(matches!(outcome_for_close(None), StreamOutcome::Closed));
    }

    #[test]
    fn the_websocket_address_follows_the_server_scheme() {
        assert_eq!(ws_url().unwrap(), "wss://nihao-gateway.up.railway.app/ws");
    }
}
