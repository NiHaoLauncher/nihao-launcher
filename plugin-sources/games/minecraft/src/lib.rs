use launcher_common::{GameInfo, GameSupport, declare_module_call};
use rust_embed::RustEmbed;
use base64::{Engine as _, engine::general_purpose};

#[derive(RustEmbed)]
#[folder = "ui/src/assets/"]
struct Assets;


pub(crate) mod library;
pub(crate) mod platforms;
pub (crate) mod interface;

pub struct MinecraftSupport;

impl GameSupport for MinecraftSupport {
    fn game(&self) -> GameInfo {
        let mut info = launcher_common::game_info_from_cargo!();
        info.name = "Minecraft";
        info.api_version = "1.7.10 - 1.19.2+ (Vanilla, Fabric)";

        return info;
    }

    fn get_ui_bundle(&self) -> &str {
        include_str!("../dist_ui/index.iife.js")
    }

    declare_module_call![
        service(interface::service),
        get_asset(path: String),
        get_config(),
        get_lang(id: String),
        notify_session_token(token: Option<String>),
        set_game_path(path: Option<String>),
        check_service_status()
    ];

    fn get_asset_data(&self, path: &str) -> Option<Vec<u8>> {
        Assets::get(path).map(|f| f.data.to_vec())
    }
}

launcher_common::export_plugin!(MinecraftSupport, MinecraftSupport);

fn mime_for(path: &str) -> &'static str {
    match std::path::Path::new(path).extension().and_then(|s| s.to_str()) {
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("svg") => "image/svg+xml",
        Some("webp") => "image/webp",
        Some("gif") => "image/gif",
        _ => "application/octet-stream",
    }
}

/// Base64 data URI for an embedded asset, used for images referenced from `get_config()` instead of
/// an `nihao://` URL: Tauri 1.x's custom protocol is unreliable for larger files on
/// Windows/WebView2 (hundreds of KB silently fail), while the webview handles data URIs natively.
fn asset_data_uri(path: &str) -> Option<String> {
    let asset = Assets::get(path)?;
    Some(format!(
        "data:{};base64,{}",
        mime_for(path),
        general_purpose::STANDARD.encode(asset.data)
    ))
}

/// Total system RAM in MB and the general RAM setting's default (half of it, 512..=8192).
/// Also the launch fallback when the player never saved the general setting.
pub fn ram_defaults() -> (u64, u64) {
    use sysinfo::System;
    let mut sys = System::new();
    sys.refresh_memory();
    let total_ram = sys.total_memory() / (1024 * 1024);
    let default_ram = ((total_ram / 2) / 128 * 128).clamp(512, 8192);
    (total_ram, default_ram)
}

pub fn get_config() -> Result<serde_json::Value, String> {
    let (total_ram, default_ram) = ram_defaults();

    let all_marks = [512, 1024, 2048, 4096, 8192, 16384, 32768];
    let marks: Vec<u64> = all_marks.iter().copied().filter(|&m| m > 512 && m < total_ram).collect();

    let default_path = library::context::default_game_path();

    Ok(serde_json::json!({
        "name": "Minecraft",
        "icon": asset_data_uri("minecraft/icon.png").unwrap_or_default(),
        "banner": asset_data_uri("minecraft/banner.png").unwrap_or_default(),
        "background": asset_data_uri("minecraft/background.png").unwrap_or_default(),
        "defaultPath": default_path,
        // Player identity lives in the profile system (SessionSelector next to Launch; "Player
        // profiles" in Game settings), not a single nickname field here.
        "hasProfileManager": true,
        // This module talks to its own server (`games::minecraft`'s MINECRAFT_IP, separate from
        // the launcher's, see API.md) for modpack publishing/activity. Registers a Settings >
        // Online Service status row; see `check_service_status`.
        "hasOnlineService": true,
        "about": {
            "version": env!("CARGO_PKG_VERSION"),
            "description": "Modpack management, mod browsing and launching for Minecraft.",
            "links": [
                { "label": "GitHub", "url": "https://github.com/BogdanCater/nihao-minecraft-plugin" }
            ],
            // No single version: NiHao Client is built per loader and game version.
            "components": [{
                "name": "NiHao Client",
                "description": "The Minecraft mod that connects the game to the launcher: Ely.by skins and the screenshot gallery.",
                "links": [
                    { "label": "GitHub", "url": "https://github.com/NiHaoLauncher/nihao-minecraft-client" },
                    { "label": "GitLab", "url": "https://gitlab.com/nihaolauncher/nihao-minecraft-client" }
                ]
            }]
        },
        "settingsFields": [
            {
                "key": "ram",
                "label": "RAM allocation (MB)",
                "hint": "Memory Minecraft may use by default. Instances with their own RAM setting ignore it. Too little makes the game stutter; too much starves the rest of your system.",
                "type": "slider",
                "defaultValue": default_ram,
                "min": 512,
                "max": total_ram,
                "step": 128,
                "unit": "MB",
                "marks": marks
            },
            {
                "key": "default_nihao_client",
                "label": "Use NiHao Client by default",
                "hint": "New modpacks start with the NiHao Client mod (Ely.by skins, screenshot gallery) turned on when a build exists for their loader and game version. You can still change it per modpack.",
                "type": "toggle",
                "defaultValue": true
            }
        ]
    }))
}

pub fn get_asset(path: String) -> Result<serde_json::Value, String> {
    let url = asset_data_uri(&path).ok_or_else(|| format!("Asset not found: {}", path))?;
    Ok(serde_json::json!({ "url": url }))
}

/// Polled by Settings > Online Service for this module's status row (`hasOnlineService`): a cheap
/// unauthenticated reachability check against `games::minecraft`'s server, like the core's
/// `server_check_alive`.
pub fn check_service_status() -> Result<serde_json::Value, String> {
    let connected = interface::runtime().block_on(library::online_modpacks::check_alive());
    Ok(serde_json::json!({ "connected": connected }))
}

/// Pushed by the launcher core's backend whenever its session token changes (`None` on
/// sign-out/disconnect). This plugin is a separate DLL without the core's connection stream, so
/// this is how `send_with_reauth` in `library::online_modpacks` learns a reconnect finished. Also
/// the source of every command's token (`library::context::session_token`).
pub fn notify_session_token(token: Option<String>) -> Result<serde_json::Value, String> {
    library::online_modpacks::set_current_session_token(token);
    Ok(serde_json::json!({ "status": "ok" }))
}

/// This plugin's translation keys for language `id` (e.g. `"en_us"`, `"uk_ua"`, as in the
/// launcher's `lang/*.json`): a partial `minecraft.*` dictionary merged into
/// `window.__NIHAO_I18N__`. Read from `{launcher exe dir}/lang/minecraft/{id}.json`, deliberately
/// not embedded in the DLL, so translators can add a language without a rebuild. A missing language
/// yields an empty object: every `t(key, fallback)` has an English fallback.
pub fn set_game_path(path: Option<String>) -> Result<serde_json::Value, String> {
    library::context::set_game_path(path);
    Ok(serde_json::json!({ "status": "ok" }))
}

pub fn get_lang(id: String) -> Result<serde_json::Value, String> {
    // The id becomes part of a path: a plain name only.
    if id.is_empty() || id.len() > 64 || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
        return Ok(serde_json::json!({}));
    }
    let Ok(exe) = std::env::current_exe() else {
        return Ok(serde_json::json!({}));
    };
    let Some(exe_dir) = exe.parent() else {
        return Ok(serde_json::json!({}));
    };
    let path = exe_dir.join("lang").join("minecraft").join(format!("{}.json", id));
    let Ok(text) = std::fs::read_to_string(&path) else {
        return Ok(serde_json::json!({}));
    };
    serde_json::from_str(&text).map_err(|e| e.to_string())
}
