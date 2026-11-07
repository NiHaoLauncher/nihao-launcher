use serde::{Deserialize, Serialize};

#[derive(Clone, Serialize, Deserialize)]
pub enum SessionTypeEnum {
    OFFLINE, MICROSOFT, NIHAO, ELYBY
}
impl SessionTypeEnum {
    /// The value of `-Dnihao.session` the NiHao Client mod reads.
    pub fn property(&self) -> &'static str {
        match self {
            SessionTypeEnum::OFFLINE => "offline",
            SessionTypeEnum::MICROSOFT => "microsoft",
            SessionTypeEnum::NIHAO => "nihao",
            SessionTypeEnum::ELYBY => "elyby",
        }
    }
}
#[derive(Clone, Serialize, Deserialize)]
pub struct MinecraftSession {
    pub(crate) username: String,
    pub(crate) access_token: Option<String>,
    pub(crate) uuid: String,
    pub(crate) session_type: SessionTypeEnum,
    /// The account's own token, handed to the NiHao Client mod in the `NIHAO_TOKEN` environment variable. Never sent as
    /// the game's `--accessToken`, which the game would show to Mojang's servers.
    pub(crate) nihao_token: Option<String>,
}
impl MinecraftSession {
    pub fn create(username: String, access_token: String, uuid: String) -> MinecraftSession {
        MinecraftSession {username: username, access_token: Some(access_token), uuid:uuid, session_type: SessionTypeEnum::OFFLINE, nihao_token: None}
    }
}

/// Same name-based (v3) UUID derivation vanilla/offline-mode servers use for
/// `"OfflinePlayer:<username>"` — deterministic per nickname, so different players (and the
/// same player consistently across launches) don't collide on one shared UUID the way a single
/// hardcoded fallback would. Player data within a world save (`playerdata/{uuid}.dat`) is keyed
/// by this, so a fixed UUID for every nickname would silently merge different players' data.
pub fn offline_uuid(username: &str) -> String {
    let digest = md5::compute(format!("OfflinePlayer:{}", username));
    let mut bytes = digest.0;
    bytes[6] = (bytes[6] & 0x0f) | 0x30; // version 3 (name-based, MD5)
    bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
    format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        bytes[0], bytes[1], bytes[2], bytes[3],
        bytes[4], bytes[5],
        bytes[6], bytes[7],
        bytes[8], bytes[9],
        bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15]
    )
}