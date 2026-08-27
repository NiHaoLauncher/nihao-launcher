use launcher_common::{GameInfo, GameSupport, declare_module_call};
use rust_embed::RustEmbed;
use base64::{Engine as _, engine::general_purpose};

#[derive(RustEmbed)]
#[folder = "ui/src/assets/"]
struct Assets;


pub(crate) mod library;
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
        get_config()
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

/// Base64 data URI for an embedded asset — used for images referenced from `get_config()`
/// (icon/banner/background) instead of an `nihao://` URL. Tauri 1.x's custom protocol
/// response path is unreliable for larger files on Windows/WebView2 (a documented issue —
/// small images load fine, ones in the hundreds-of-KB range silently fail in practice); a
/// data URI is handled natively by the webview and sidesteps that path entirely.
fn asset_data_uri(path: &str) -> Option<String> {
    let asset = Assets::get(path)?;
    Some(format!(
        "data:{};base64,{}",
        mime_for(path),
        general_purpose::STANDARD.encode(asset.data)
    ))
}

pub fn get_config() -> Result<serde_json::Value, String> {
    use sysinfo::System;
    let mut sys = System::new();
    sys.refresh_memory();
    let total_ram = sys.total_memory() / (1024 * 1024); // MB

    let all_marks = [512, 1024, 2048, 4096, 8192, 16384, 32768];
    let marks: Vec<u64> = all_marks.iter().copied().filter(|&m| m > 512 && m < total_ram).collect();
    
    let mut default_ram = (total_ram / 2) / 128 * 128;
    if default_ram > 8192 {
        default_ram = 8192;
    }
    if default_ram < 512 {
        default_ram = 512;
    }

    let default_path = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|p| p.join("game").join("minecraft")))
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|| "game\\minecraft".to_string());

    Ok(serde_json::json!({
        "name": "Minecraft",
        "icon": asset_data_uri("minecraft/icon.png").unwrap_or_default(),
        "banner": asset_data_uri("minecraft/banner.png").unwrap_or_default(),
        "background": asset_data_uri("minecraft/background.png").unwrap_or_default(),
        "defaultPath": default_path,
        "settingsFields": [
            {
                "key": "nickname",
                "label": "Nickname",
                "type": "text",
                "defaultValue": "Player"
            },
            {
                "key": "ram",
                "label": "RAM Allocation (MB)",
                "type": "slider",
                "defaultValue": default_ram,
                "min": 512,
                "max": total_ram,
                "step": 128,
                "unit": "MB",
                "marks": marks
            }
        ]
    }))
}

pub fn get_asset(path: String) -> Result<serde_json::Value, String> {
    let url = asset_data_uri(&path).ok_or_else(|| format!("Asset not found: {}", path))?;
    Ok(serde_json::json!({ "url": url }))
}
