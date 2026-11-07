//! The "Public" tab in Create Modpack and "Publish to NiHao" in Share: NiHao's hosted modpack
//! catalog, not a third-party content service (`services/`). Talks to `games::minecraft`'s own server, a
//! different address from the launcher's general one (see API.md, "Modpacks" / "Modpack content").

use std::path::Path;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::watch;

use crate::library::modpack_format::{FileSource, ModpackFileEntry};

const DEFAULT_MINECRAFT_SERVER_API: &str = "http://127.0.0.1:8082";

/// The server's address. A release always uses the one built in; only a development build lets
/// `MINECRAFT_SERVER_API` point somewhere else.
fn minecraft_server_api_base() -> String {
    if cfg!(debug_assertions) {
        if let Ok(base) = std::env::var("MINECRAFT_SERVER_API") {
            return base;
        }
    }
    DEFAULT_MINECRAFT_SERVER_API.to_string()
}

/// Whether the session token may be sent to `base`: https, or any address in a development build
/// (a local server).
fn may_send_token(base: &str, development: bool) -> bool {
    development || base.starts_with("https://")
}

/// Checked before every request that carries the session token (`context::session_token`): in a
/// release the token is never sent over plain http, where anything on the way, or on this PC at the
/// address, could read it. `DEFAULT_MINECRAFT_SERVER_API` must be the real https address before a
/// release; until then the online features report that they are not set up.
pub fn ensure_secure_server() -> Result<(), String> {
    if may_send_token(&minecraft_server_api_base(), cfg!(debug_assertions)) {
        Ok(())
    } else {
        Err("The online service is not set up in this build (its address must be https).".to_string())
    }
}

/// Cheap reachability probe for `games::minecraft`'s own server (the "Online Service" settings row,
/// `hasOnlineService`); mirrors `server_check_alive` in `server_api.rs`: any completed HTTP
/// response counts as up. No auth needed.
pub async fn check_alive() -> bool {
    Client::new()
        .get(minecraft_server_api_base())
        .timeout(Duration::from_secs(4))
        .send()
        .await
        .is_ok()
}

fn session_token_tx() -> &'static watch::Sender<Option<String>> {
    static TX: OnceLock<watch::Sender<Option<String>>> = OnceLock::new();
    TX.get_or_init(|| watch::channel(None).0)
}

/// Called from `notify_session_token` (lib.rs), which the launcher core's backend calls whenever
/// its session changes: the only way this plugin (a separate DLL) learns a reconnect finished. The
/// frontend never sees this token. Feeds `send_with_reauth`.
pub fn set_current_session_token(token: Option<String>) {
    // `send_replace`: the channel has no standing receiver, and `send` would then drop the value.
    session_token_tx().send_replace(token);
}

/// The session token the launcher core last pushed, if signed in.
pub fn current_session_token() -> Option<String> {
    session_token_tx().borrow().clone()
}

/// How long a 401-retry waits for a fresh `session_token` from the launcher before surfacing the
/// original 401.
const REAUTH_WAIT: Duration = Duration::from_secs(10);

/// Blocks until a new `session_token` is notified (a reconnect finishing) or `REAUTH_WAIT` elapses.
/// Subscribes fresh each call, so it only resolves on a token newer than the one current at call
/// time.
async fn wait_for_fresh_session_token() -> Option<String> {
    let mut rx = session_token_tx().subscribe();
    match tokio::time::timeout(REAUTH_WAIT, rx.changed()).await {
        Ok(Ok(())) => rx.borrow().clone(),
        _ => None,
    }
}

/// Every request in this module goes through here. `build` receives the token to use and must build
/// the complete request; it is called once, and again with a fresh token after a `401`.
///
/// `session_token` dies the instant the launcher's connection stream drops (no grace period, see
/// API.md's Auth section), so a request in the gap before a reconnect gets a transient 401, notably
/// in background jobs (publishing a build, downloading pack files), whose errors never reach the
/// frontend's own retry (`useCallModule`), only `install_state()`'s `last_error`. Waits once for a
/// fresher token (`wait_for_fresh_session_token`) and retries exactly once; otherwise returns the
/// response as-is. Mirrors `send_with_reauth` in `server_api.rs`; never loops, never swallows a
/// lasting failure.
async fn send_with_reauth<F>(token: &str, build: F) -> Result<reqwest::Response, reqwest::Error>
where
    F: Fn(&str) -> reqwest::RequestBuilder,
{
    let res = build(token).send().await?;
    if res.status() != reqwest::StatusCode::UNAUTHORIZED {
        return Ok(res);
    }
    match wait_for_fresh_session_token().await {
        Some(fresh) if fresh != token => build(&fresh).send().await,
        _ => Ok(res),
    }
}

async fn parse_error(res: reqwest::Response) -> String {
    let status = res.status();
    let url = res.url().to_string();
    let body_text = res.text().await.unwrap_or_default();
    eprintln!("[minecraft] Server request failed: {} {} -> {}", url, status, body_text);
    serde_json::from_str::<Value>(&body_text)
        .ok()
        .and_then(|body| body.get("error").and_then(|v| v.as_str()).map(|s| s.to_string()))
        .unwrap_or_else(|| format!("Request failed ({status})"))
}

/// A bearer-authenticated request (`build` makes it from the token, see `send_with_reauth`) whose
/// non-2xx answer becomes the server's own error message.
async fn send<F>(session_token: &str, build: F) -> Result<reqwest::Response, String>
where
    F: Fn(&str) -> reqwest::RequestBuilder,
{
    let res = send_with_reauth(session_token, build).await.map_err(|e| format!("Cannot reach server: {e}"))?;
    if !res.status().is_success() {
        return Err(parse_error(res).await);
    }
    Ok(res)
}

/// `send`, then the answer's JSON as `T`.
async fn call_json<T, F>(session_token: &str, build: F) -> Result<T, String>
where
    T: serde::de::DeserializeOwned,
    F: Fn(&str) -> reqwest::RequestBuilder,
{
    send(session_token, build).await?.json::<T>().await.map_err(|e| format!("Invalid response from server: {e}"))
}

#[derive(Serialize, Deserialize, Clone)]
pub struct OnlineModpack {
    pub id: String,
    pub name: String,
    pub visibility: String,
    pub latest_build: u64,
    pub is_owner: bool,
    /// Raw image URLs as the server returns them (`null` if never uploaded). Not usable in `<img
    /// src>` since `.../icon`/`.../banner` need a bearer token; `list()` resolves them into
    /// `icon_data_uri`/`banner_data_uri`.
    #[serde(default, skip_serializing)]
    pub icon_url: Option<String>,
    #[serde(default, skip_serializing)]
    pub banner_url: Option<String>,
    #[serde(default)]
    pub icon_data_uri: Option<String>,
    #[serde(default)]
    pub banner_data_uri: Option<String>,
}

#[derive(Deserialize)]
struct ModpacksResponse {
    modpacks: Vec<OnlineModpack>,
}

/// Fetches a bearer-gated image endpoint (`.../icon` or `.../banner`) as a `data:` URI (like
/// `image_data_uri()` in interface.rs), since the frontend can't hit it without the token.
/// Best-effort (`None` on failure), no reauth retry: at worst an image is briefly blank.
async fn fetch_image_data_uri(session_token: &str, url: &str) -> Option<String> {
    use base64::Engine;
    let res = Client::new().get(url).bearer_auth(session_token).send().await.ok()?;
    if !res.status().is_success() {
        return None;
    }
    let mime = res
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("image/png")
        .to_string();
    let bytes = res.bytes().await.ok()?;
    Some(format!("data:{};base64,{}", mime, base64::engine::general_purpose::STANDARD.encode(bytes)))
}

/// Like `fetch_image_data_uri` but returns the raw bytes, for writing to disk. Same best-effort
/// contract.
async fn fetch_image_bytes(session_token: &str, url: &str) -> Option<Vec<u8>> {
    let res = Client::new().get(url).bearer_auth(session_token).send().await.ok()?;
    if !res.status().is_success() {
        return None;
    }
    res.bytes().await.ok().map(|b| b.to_vec())
}

/// Downloads a pack's icon/banner (if any) as raw bytes, for `install_online_modpack` to save as
/// the new instance's own icon/banner. Resolves `id` through `list()`. Best-effort as a whole: any
/// failure just means no icon/banner, never a failed install.
pub async fn fetch_pack_images(session_token: &str, id: &str) -> (Option<Vec<u8>>, Option<Vec<u8>>) {
    let packs = match list(session_token, false).await {
        Ok(packs) => packs,
        Err(e) => {
            println!("[minecraft:publish] fetch_pack_images: list() failed for '{}': {}", id, e);
            return (None, None);
        }
    };
    let Some(pack) = packs.into_iter().find(|p| p.id == id) else {
        println!("[minecraft:publish] fetch_pack_images: pack '{}' not in this account's visible list.", id);
        return (None, None);
    };
    println!(
        "[minecraft:publish] fetch_pack_images: pack '{}' -> icon_url={:?}, banner_url={:?}",
        id, pack.icon_url, pack.banner_url
    );
    let base = minecraft_server_api_base();
    let icon = match &pack.icon_url {
        Some(path) => fetch_image_bytes(session_token, &format!("{base}{path}")).await,
        None => None,
    };
    let banner = match &pack.banner_url {
        Some(path) => fetch_image_bytes(session_token, &format!("{base}{path}")).await,
        None => None,
    };
    println!(
        "[minecraft:publish] fetch_pack_images: pack '{}' -> icon {} bytes, banner {} bytes",
        id,
        icon.as_ref().map(|b| b.len()).unwrap_or(0),
        banner.as_ref().map(|b| b.len()).unwrap_or(0),
    );
    (icon, banner)
}

/// `GET /minecraft/modpacks`: every pack the caller can see (public, owned, granted). Needs
/// `minecraft.modpacks.view` server-side; a `403` just means it wasn't granted. `with_images` off
/// skips the per-pack icon/banner downloads.
pub async fn list(session_token: &str, with_images: bool) -> Result<Vec<OnlineModpack>, String> {
    let mut body: ModpacksResponse = call_json(session_token, |token| {
        Client::new().get(format!("{}/minecraft/modpacks", minecraft_server_api_base())).bearer_auth(token)
    })
    .await?;

    if with_images {
        let base = minecraft_server_api_base();
        let base = &base;
        futures_util::future::join_all(body.modpacks.iter_mut().map(|pack| async move {
            if let Some(path) = &pack.icon_url {
                pack.icon_data_uri = fetch_image_data_uri(session_token, &format!("{base}{path}")).await;
            }
            if let Some(path) = &pack.banner_url {
                pack.banner_data_uri = fetch_image_data_uri(session_token, &format!("{base}{path}")).await;
            }
        }))
        .await;
    }
    Ok(body.modpacks)
}

/// `GET /minecraft/modpacks/{id}/manifest` — the pack's latest published build, full
/// `ModpackManifest` shape (`files[]` included).
pub async fn fetch_manifest(session_token: &str, id: &str) -> Result<Value, String> {
    call_json(session_token, |token| {
        Client::new()
            .get(format!("{}/minecraft/modpacks/{}/manifest", minecraft_server_api_base(), id))
            .bearer_auth(token)
    })
    .await
}

/// `POST /minecraft/modpacks`: registers a new pack (`latest_build` starts at 0, no content) and
/// returns its server-assigned `id` (opaque, random, never client-chosen; unchanged by later
/// renames). The first `publish_build` for it creates build 1.
pub async fn register(session_token: &str, name: &str, visibility: &str) -> Result<String, String> {
    println!("[minecraft:publish] Registering new pack '{}' (visibility: {})...", name, visibility);
    let body: Value = call_json(session_token, |token| {
        Client::new()
            .post(format!("{}/minecraft/modpacks", minecraft_server_api_base()))
            .bearer_auth(token)
            .json(&serde_json::json!({ "name": name, "visibility": visibility }))
    })
    .await?;
    let id = body
        .get("id")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| "Server didn't return a pack id".to_string())?;
    println!("[minecraft:publish] Registered pack '{}' -> id '{}'", name, id);
    Ok(id)
}

/// `PATCH /minecraft/modpacks/{id}`: owner-only; renames the pack and/or flips its visibility
/// (either may be omitted). Pack settings, not content.
pub async fn update(session_token: &str, id: &str, name: Option<&str>, visibility: Option<&str>) -> Result<(), String> {
    let mut body = serde_json::Map::new();
    if let Some(name) = name {
        body.insert("name".to_string(), Value::String(name.to_string()));
    }
    if let Some(visibility) = visibility {
        body.insert("visibility".to_string(), Value::String(visibility.to_string()));
    }
    send(session_token, |token| {
        Client::new()
            .patch(format!("{}/minecraft/modpacks/{}", minecraft_server_api_base(), id))
            .bearer_auth(token)
            .json(&Value::Object(body.clone()))
    })
    .await
    .map(|_| ())
}

/// `POST /minecraft/modpacks/{id}/access` — owner-only, invites `login` to an invite-only pack.
pub async fn invite(session_token: &str, id: &str, login: &str) -> Result<(), String> {
    send(session_token, |token| {
        Client::new()
            .post(format!("{}/minecraft/modpacks/{}/access", minecraft_server_api_base(), id))
            .bearer_auth(token)
            .json(&serde_json::json!({ "login": login }))
    })
    .await
    .map(|_| ())
}

/// `DELETE /minecraft/modpacks/{id}`: owner-only, permanent: every build's manifest/files,
/// icon/banner and every `ModpackAccess` grant, with no soft-delete. The caller (interface.rs) must
/// confirm with the player first.
pub async fn delete(session_token: &str, id: &str) -> Result<(), String> {
    send(session_token, |token| {
        Client::new()
            .delete(format!("{}/minecraft/modpacks/{}", minecraft_server_api_base(), id))
            .bearer_auth(token)
    })
    .await
    .map(|_| ())
}

/// `GET /minecraft/modpacks/permissions`: whether the caller can view/create modpacks, so the
/// frontend can decide up front whether to show modpack UI instead of a raw `403` (neither
/// permission is granted to non-developers by default, see API.md).
pub async fn permissions(session_token: &str) -> Result<(bool, bool), String> {
    let body: Value = call_json(session_token, |token| {
        Client::new()
            .get(format!("{}/minecraft/modpacks/permissions", minecraft_server_api_base()))
            .bearer_auth(token)
    })
    .await?;
    let can_view = body.get("can_view").and_then(|v| v.as_bool()).unwrap_or(false);
    let can_create = body.get("can_create").and_then(|v| v.as_bool()).unwrap_or(false);
    Ok((can_view, can_create))
}

/// `GET /minecraft/modpacks/{id}/files/{path}?build={build}`: one pack file's bytes for entries
/// whose `source` is `Server` (the default). A `Url`-sourced entry is fetched straight from its
/// URL, unauthenticated (a CDN/mirror), bypassing this endpoint and reauth (see MODPACK_FORMAT.md).
///
/// Streams to `dest` via `dest.part` (renamed on success) and checks `entry.sha256`, so a
/// truncated, tampered or error-page download never lands as the real file.
pub async fn download_file(
    session_token: &str,
    id: &str,
    build: u64,
    entry: &ModpackFileEntry,
    dest: &Path,
) -> Result<(), String> {
    use futures_util::StreamExt;
    use sha2::{Digest, Sha256};
    use tokio::io::AsyncWriteExt;

    let res = match &entry.source {
        FileSource::Server => {
            let url = pack_file_url(id, &entry.path)?;
            send_with_reauth(session_token, |token| {
                Client::new()
                    .get(url.clone())
                    .query(&[("build", build.to_string())])
                    .bearer_auth(token)
            })
            .await
            .map_err(|e| format!("Cannot reach server: {e}"))?
        }
        FileSource::Url { url } => {
            if !url.starts_with("https://") {
                return Err(format!("Refusing non-HTTPS download URL for '{}'", entry.path));
            }
            Client::new()
                .get(url)
                .send()
                .await
                .map_err(|e| format!("Cannot reach server: {e}"))?
        }
    };

    if !res.status().is_success() {
        return Err(parse_error(res).await);
    }

    let mut part_name = dest.as_os_str().to_owned();
    part_name.push(".part");
    let part = std::path::PathBuf::from(part_name);
    let mut file = tokio::fs::File::create(&part)
        .await
        .map_err(|e| format!("Cannot write '{}': {}", part.display(), e))?;
    let mut hasher = Sha256::new();
    let mut stream = res.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("Download of '{}' interrupted: {e}", entry.path))?;
        hasher.update(&chunk);
        file.write_all(&chunk).await.map_err(|e| format!("Cannot write '{}': {}", part.display(), e))?;
    }
    file.flush().await.map_err(|e| e.to_string())?;
    drop(file);

    if format!("{:x}", hasher.finalize()) != entry.sha256.to_lowercase() {
        let _ = tokio::fs::remove_file(&part).await;
        return Err(format!("Checksum mismatch for '{}'", entry.path));
    }
    tokio::fs::rename(&part, dest)
        .await
        .map_err(|e| format!("Cannot write '{}': {}", dest.display(), e))
}

/// `{server}/minecraft/modpacks/{id}/files/{path}` with each part percent-encoded, so an odd
/// `id` or file name can't turn into a different endpoint or a query.
fn pack_file_url(id: &str, path: &str) -> Result<reqwest::Url, String> {
    pack_file_url_on(&minecraft_server_api_base(), id, path)
}

fn pack_file_url_on(base: &str, id: &str, path: &str) -> Result<reqwest::Url, String> {
    let mut url = reqwest::Url::parse(base).map_err(|e| format!("Bad server address: {e}"))?;
    url.path_segments_mut()
        .map_err(|_| "Bad server address".to_string())?
        .pop_if_empty()
        .extend(["minecraft", "modpacks"])
        .push(id)
        .push("files")
        .extend(path.split('/'));
    Ok(url)
}

/// `POST /minecraft/modpacks/{id}/builds`: owner-only; publishes `zip_path`
/// (`library::export::export_for_publish`: `modpack.nihao` plus an `override/` folder for anything
/// not resolvable by an online service) as the next build and returns the resulting manifest, which the
/// caller saves as `profile.pack`.
///
/// `minecraft_version`/`loader`/`loader_version`/`version` are not form fields: per API.md they
/// live inside `modpack.nihao`, like `.mrpack`'s `modrinth.index.json`. Only `file`/`icon`/`banner`
/// go on the wire.
///
/// The archive is re-opened and streamed per attempt (a pack can be gigabytes), never held in
/// memory; only icon/banner are shared via `Arc` between the attempt and a reauth retry.
pub async fn publish_build(
    session_token: &str,
    id: &str,
    zip_path: &Path,
    icon: Option<Vec<u8>>,
    banner: Option<Vec<u8>>,
) -> Result<Value, String> {
    let size = tokio::fs::metadata(zip_path)
        .await
        .map_err(|e| format!("Cannot read upload archive: {e}"))?
        .len();
    println!(
        "[minecraft:publish] Uploading build for pack '{}' — archive {:.2} MB (icon: {}, banner: {})",
        id,
        size as f64 / 1_048_576.0,
        icon.is_some(),
        banner.is_some(),
    );
    let file_name = zip_path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "pack.zip".to_string());
    let icon = icon.map(Arc::new);
    let banner = banner.map(Arc::new);

    let build_request = |token: String| {
        let file_name = file_name.clone();
        let icon = icon.clone();
        let banner = banner.clone();
        async move {
        let file = tokio::fs::File::open(zip_path)
            .await
            .map_err(|e| format!("Cannot read upload archive: {e}"))?;
        let stream = futures_util::stream::unfold(file, |mut file| async move {
            use tokio::io::AsyncReadExt;
            let mut buf = vec![0u8; 65536];
            match file.read(&mut buf).await {
                Ok(0) => None,
                Ok(n) => {
                    buf.truncate(n);
                    Some((Ok::<_, std::io::Error>(buf), file))
                }
                Err(e) => Some((Err(e), file)),
            }
        });
        let file_part = reqwest::multipart::Part::stream_with_length(reqwest::Body::wrap_stream(stream), size)
            .file_name(file_name)
            .mime_str("application/zip")
            .map_err(|e| e.to_string())?;

        let mut form = reqwest::multipart::Form::new().part("file", file_part);
        // Instance icon/banner files have no extension (browsers sniff content), so there is no
        // MIME type to read; PNG is assumed, as elsewhere for the same files (`image_data_uri` in
        // lib.rs/interface.rs).
        if let Some(icon) = &icon {
            let part = reqwest::multipart::Part::bytes((**icon).clone())
                .file_name("icon.png")
                .mime_str("image/png")
                .map_err(|e| e.to_string())?;
            form = form.part("icon", part);
        }
        if let Some(banner) = &banner {
            let part = reqwest::multipart::Part::bytes((**banner).clone())
                .file_name("banner.png")
                .mime_str("image/png")
                .map_err(|e| e.to_string())?;
            form = form.part("banner", part);
        }

        Ok::<_, String>(Client::new()
            .post(format!("{}/minecraft/modpacks/{}/builds", minecraft_server_api_base(), id))
            .bearer_auth(token)
            .multipart(form))
        }
    };

    let res = build_request(session_token.to_string()).await?
        .send()
        .await
        .map_err(|e| format!("Cannot reach server: {e}"))?;
    println!("[minecraft:publish] POST .../modpacks/{}/builds -> {}", id, res.status());

    let res = if res.status() == reqwest::StatusCode::UNAUTHORIZED {
        println!("[minecraft:publish] Got 401, retrying with a fresh session token...");
        match wait_for_fresh_session_token().await {
            Some(fresh) if fresh != session_token => {
                let retried = build_request(fresh).await?
                    .send()
                    .await
                    .map_err(|e| format!("Cannot reach server: {e}"))?;
                println!("[minecraft:publish] Retry -> {}", retried.status());
                retried
            }
            _ => res,
        }
    } else {
        res
    };

    if !res.status().is_success() {
        return Err(parse_error(res).await);
    }
    let value = res
        .json::<Value>()
        .await
        .map_err(|e| format!("Invalid response from server: {e}"))?;
    println!(
        "[minecraft:publish] Build accepted for pack '{}' — build #{}",
        id,
        value.get("build").and_then(|v| v.as_u64()).map(|b| b.to_string()).unwrap_or_else(|| "?".to_string())
    );
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_token_goes_only_over_https_except_in_development() {
        assert!(may_send_token("https://mc.example.org", false));
        assert!(!may_send_token("http://127.0.0.1:8082", false));
        assert!(!may_send_token("http://mc.example.org", false));
        assert!(!may_send_token("ftp://x", false));
        assert!(may_send_token("http://127.0.0.1:8082", true));
    }

    #[test]
    fn a_pack_file_url_keeps_every_part_in_its_place() {
        let url = pack_file_url_on("https://mc.example.org", "abc", "mods/a b.jar").unwrap();
        assert_eq!(url.as_str(), "https://mc.example.org/minecraft/modpacks/abc/files/mods/a%20b.jar");
        // A hostile id or name cannot start a query, climb out, or switch endpoint.
        let url = pack_file_url_on("https://mc.example.org/", "x?y=1#z", "a/../b?c").unwrap();
        assert_eq!(url.path(), "/minecraft/modpacks/x%3Fy=1%23z/files/a/b%3Fc");
        assert_eq!(url.query(), None);
        assert!(pack_file_url_on("not a url", "a", "b").is_err());
    }

    /// A one-file server: answers the next `count` requests with `body`.
    async fn serve(body: &'static [u8], count: usize) -> String {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move {
            for _ in 0..count {
                let (mut socket, _) = listener.accept().await.unwrap();
                let _ = socket.read(&mut [0u8; 2048]).await;
                let head = format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
                let _ = socket.write_all(head.as_bytes()).await;
                let _ = socket.write_all(body).await;
            }
        });
        base
    }

    #[tokio::test]
    async fn a_pack_file_is_kept_only_if_its_hash_is_the_manifests() {
        use sha2::{Digest, Sha256};
        let base = serve(b"mod bytes", 2).await;
        // The only test that sets it; a development build (this one) takes the server from here.
        std::env::set_var("MINECRAFT_SERVER_API", &base);
        let dir = std::env::temp_dir().join(format!("nihao-pack-file-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let entry = |sha256: String| ModpackFileEntry { path: "mods/a.jar".into(), sha256, size: 9, source: FileSource::Server };

        let good = dir.join("good.jar");
        let right = format!("{:x}", Sha256::digest(b"mod bytes"));
        download_file("token", "pack", 1, &entry(right), &good).await.unwrap();
        assert_eq!(std::fs::read(&good).unwrap(), b"mod bytes");

        let bad = dir.join("bad.jar");
        let error = download_file("token", "pack", 1, &entry("0".repeat(64)), &bad).await.unwrap_err();
        assert!(error.contains("Checksum mismatch"), "{error}");
        assert!(!bad.exists() && !dir.join("bad.jar.part").exists(), "a file that fails its hash is not left behind");

        let http = ModpackFileEntry { path: "x".into(), sha256: String::new(), size: 0, source: FileSource::Url { url: "http://example.org/x".into() } };
        assert!(download_file("token", "pack", 1, &http, &dir.join("x")).await.unwrap_err().contains("non-HTTPS"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
