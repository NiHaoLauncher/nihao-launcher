//! Discord Rich Presence. A single background thread owns the IPC connection to the Discord desktop
//! client (a local socket/pipe; only an Application/Client ID is needed, no bot token). Everything
//! else (Settings toggle, route changes, a module reporting play, the activity pulse for AFK) sends
//! a `PresenceCommand` down a channel, so nothing needs `Send`/`Sync`.
//!
//! Precedence for what to show: `playing` wins (the game has focus, so launcher inactivity says
//! nothing); otherwise `browsing` (the open route/game section), or "AFK" when the launcher window
//! has had no input for `AFK_THRESHOLD`.

use discord_rich_presence::{activity, DiscordIpc, DiscordIpcClient};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::OnceLock;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// NiHaoLauncher's Application (Client) ID from Discord's Developer Portal; its name/icon there are
/// what Discord shows next to the presence text.
const DISCORD_CLIENT_ID: &str = "1192976241406525560";

/// Art Asset key (Developer Portal → Rich Presence → Art Assets) of the launcher's own logo.
const LAUNCHER_ASSET: &str = "main";

/// How long the window can go without input before presence shows "AFK" (only while nothing is
/// `Playing`).
const AFK_THRESHOLD: Duration = Duration::from_secs(10 * 60);
/// Also the poll interval for noticing the AFK threshold: an idle session sends no commands that
/// would wake the thread.
const AFK_CHECK_INTERVAL: Duration = Duration::from_secs(30);

#[derive(Clone, PartialEq)]
struct PlayingInfo {
    /// Also the Discord "small image" Art Asset key (see `apply`): a module's `gameId` (e.g.
    /// `"minecraft"`), so it works for any future module that has an asset with that exact key.
    game: String,
    /// The instance/modpack/save name — Discord's "details" line under the "state" line.
    detail: String,
    /// The in-game nickname the session is actually running under — shown as the small image's
    /// hover tooltip. `None` if the module has no such concept.
    nickname: Option<String>,
    /// `(label, url)` for an optional activity button (one used today, the crate allows two), e.g.
    /// Minecraft's "Play together" deep link (see `deeplink.rs`). `None` when there is nothing to
    /// invite anyone to.
    join_button: Option<(String, String)>,
    /// `"menu"` / `"singleplayer"` / `"multiplayer"` when the module can tell; replaces the generic
    /// "Playing <game>" line.
    status: Option<String>,
    /// Public https URL shown as the large image instead of the game's Art Asset (e.g. a modpack
    /// icon), with `large_text` as its tooltip.
    large_image: Option<String>,
    large_text: Option<String>,
    /// Second activity button, e.g. the modpack's page on its service.
    link_button: Option<(String, String)>,
}

enum PresenceCommand {
    SetEnabled(bool),
    /// `None` means that module stopped playing.
    SetPlaying(Option<PlayingInfo>),
    /// Current route's game section, if any (`/gm/:gameId`) — `None` for `/library`, `/profile`, etc.
    SetBrowsing(Option<String>),
    /// A launcher-window input pulse (mousemove/keydown) — resets the AFK timer.
    NotifyActive,
}

fn sender() -> &'static Sender<PresenceCommand> {
    static SENDER: OnceLock<Sender<PresenceCommand>> = OnceLock::new();
    SENDER.get_or_init(|| {
        let (tx, rx) = mpsc::channel::<PresenceCommand>();
        std::thread::spawn(move || run(rx));
        tx
    })
}

fn send(cmd: PresenceCommand) -> Result<(), String> {
    sender().send(cmd).map_err(|_| "Discord presence thread is gone".to_string())
}

pub fn set_enabled(enabled: bool) -> Result<(), String> {
    send(PresenceCommand::SetEnabled(enabled))
}

pub fn set_playing(
    game: Option<String>,
    detail: Option<String>,
    nickname: Option<String>,
    join_label: Option<String>,
    join_url: Option<String>,
    status: Option<String>,
    large_image: Option<String>,
    large_text: Option<String>,
    link_label: Option<String>,
    link_url: Option<String>,
) -> Result<(), String> {
    let playing = match (game, detail) {
        (Some(game), Some(detail)) => Some(PlayingInfo {
            game,
            detail,
            nickname,
            status,
            large_image,
            large_text,
            link_button: match (link_label, link_url) {
                (Some(label), Some(url)) => Some((label, url)),
                _ => None,
            },
            join_button: match (join_label, join_url) {
                (Some(label), Some(url)) => Some((label, url)),
                _ => None,
            },
        }),
        _ => None,
    };
    send(PresenceCommand::SetPlaying(playing))
}

pub fn set_browsing(game: Option<String>) -> Result<(), String> {
    send(PresenceCommand::SetBrowsing(game))
}

pub fn notify_active() -> Result<(), String> {
    send(PresenceCommand::NotifyActive)
}

fn unix_now() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

/// What is shown right now, derived on every change from `playing`/`browsing`/`is_afk` (see the
/// module doc for precedence).
#[derive(Clone, PartialEq)]
enum Shown {
    Playing(PlayingInfo),
    Browsing { game: Option<String> },
    Afk,
}

fn compute_shown(playing: &Option<PlayingInfo>, browsing: &Option<String>, is_afk: bool) -> Shown {
    if let Some(info) = playing {
        Shown::Playing(info.clone())
    } else if is_afk {
        Shown::Afk
    } else {
        Shown::Browsing { game: browsing.clone() }
    }
}

fn apply(client: &mut Option<DiscordIpcClient>, shown: &Shown, since: i64) {
    // Lazily (re)connect: Discord not running yet is the ordinary case, not worth logging every
    // 30s; leave `client` as `None` and retry next time.
    if client.is_none() {
        let mut c = DiscordIpcClient::new(DISCORD_CLIENT_ID);
        if c.connect().is_ok() {
            *client = Some(c);
        } else {
            return;
        }
    }

    let (state, details) = match shown {
        Shown::Playing(info) => (
            match info.status.as_deref() {
                Some("menu") => "In the menu".to_string(),
                Some("singleplayer") => "Playing singleplayer".to_string(),
                Some("multiplayer") => "Playing multiplayer".to_string(),
                _ => format!("Playing {}", info.game),
            },
            Some(info.detail.clone()),
        ),
        Shown::Browsing { game: Some(game) } => (format!("Browsing {game}"), None),
        Shown::Browsing { game: None } => ("Browsing NiHaoLauncher".to_string(), None),
        Shown::Afk => ("Inactive user".to_string(), None),
    };

    let mut payload = activity::Activity::new().state(state.as_str()).timestamps(activity::Timestamps::new().start(since));
    if let Some(details) = &details {
        payload = payload.details(details.as_str());
    }

    // Large image = the game being browsed/played, small = the launcher badge (both Art Asset
    // keys). Playing: game large, launcher small. Browsing a game: swapped. Elsewhere: launcher
    // only.
    let game_key = match shown {
        Shown::Playing(info) => info.game.to_lowercase(),
        Shown::Browsing { game: Some(game) } => game.to_lowercase(),
        _ => String::new(),
    };
    let assets = match shown {
        Shown::Playing(info) => {
            // Discord drops asset text outside 2..=128 chars, which can take the whole badge with it.
            let small_text = info.nickname.as_deref().filter(|n| (2..=128).contains(&n.chars().count())).unwrap_or("NiHaoLauncher");
            let (large, large_text) = match &info.large_image {
                Some(url) => (url.as_str(), info.large_text.as_deref().filter(|t| (2..=128).contains(&t.chars().count())).unwrap_or(info.game.as_str())),
                None => (game_key.as_str(), info.game.as_str()),
            };
            activity::Assets::new().large_image(large).large_text(large_text).small_image(LAUNCHER_ASSET).small_text(small_text)
        }
        Shown::Browsing { game: Some(game) } => {
            activity::Assets::new().large_image(LAUNCHER_ASSET).large_text("NiHaoLauncher").small_image(game_key.as_str()).small_text(game.as_str())
        }
        _ => activity::Assets::new().large_image(LAUNCHER_ASSET).large_text("NiHaoLauncher"),
    };
    payload = payload.assets(assets);

    // The join button only makes sense while actually playing.
    if let Shown::Playing(info) = shown {
        let buttons: Vec<_> = info
            .join_button
            .iter()
            .chain(info.link_button.iter())
            .map(|(label, url)| activity::Button::new(label.as_str(), url.as_str()))
            .collect();
        if !buttons.is_empty() {
            payload = payload.buttons(buttons);
        }
    }

    if let Some(c) = client {
        // A `set_activity` failure almost always means the connection died; drop it so the next
        // `apply` reconnects instead of going stale.
        if let Err(e) = c.set_activity(payload) {
            eprintln!("discord presence: set_activity failed: {e}");
            *client = None;
        }
    }
}

fn run(rx: mpsc::Receiver<PresenceCommand>) {
    let mut enabled = false;
    let mut client: Option<DiscordIpcClient> = None;
    let mut playing: Option<PlayingInfo> = None;
    let mut browsing: Option<String> = None;
    let mut is_afk = false;
    let mut last_active = Instant::now();
    let mut shown = compute_shown(&playing, &browsing, is_afk);
    let mut shown_since = unix_now();

    loop {
        let mut dirty = false;
        match rx.recv_timeout(AFK_CHECK_INTERVAL) {
            Ok(PresenceCommand::SetEnabled(value)) => {
                if enabled != value {
                    enabled = value;
                    if !enabled {
                        if let Some(mut c) = client.take() {
                            let _ = c.close();
                        }
                    } else {
                        dirty = true;
                    }
                }
            }
            Ok(PresenceCommand::SetPlaying(value)) => {
                if playing != value {
                    playing = value;
                    last_active = Instant::now();
                    is_afk = false;
                    dirty = true;
                }
            }
            Ok(PresenceCommand::SetBrowsing(value)) => {
                if browsing != value {
                    browsing = value;
                    dirty = true;
                }
            }
            Ok(PresenceCommand::NotifyActive) => {
                last_active = Instant::now();
                if is_afk {
                    is_afk = false;
                    dirty = true;
                }
            }
            Err(RecvTimeoutError::Timeout) => {
                let should_afk = !is_afk && playing.is_none() && last_active.elapsed() > AFK_THRESHOLD;
                if should_afk {
                    is_afk = true;
                    dirty = true;
                }
            }
            Err(RecvTimeoutError::Disconnected) => break,
        }

        if !dirty || !enabled {
            continue;
        }
        let next_shown = compute_shown(&playing, &browsing, is_afk);
        if next_shown != shown {
            shown = next_shown;
            shown_since = unix_now();
        }
        apply(&mut client, &shown, shown_since);
    }
}
