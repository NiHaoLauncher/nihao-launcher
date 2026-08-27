import { Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { open as openFileDialog, save as saveFileDialog } from "@tauri-apps/api/dialog";
import { open as openExternalUrl } from "@tauri-apps/api/shell";
import { t, T } from "@shared/components/Translate";
import { Modal, ConfirmModal, SliderField, BrowseField } from "@shared/index";
import { useCallModule } from "@shared/modules";
import { useLauncher } from "@shared";

import CUSTOM_INSTANCE from "@shared/assets/custom_instance.png";
import PACKAGE from "@shared/assets/package.png";
// Not a plain side-effect import — see index.tsx for why: this UI has no shadow root, and the
// built CSS is never loaded by the host on its own, so index.tsx injects it as a <style> tag.
import { LOADERS } from ".";
import { ActionsBanner, FolderIcon as OpenFolderIcon, ShareIcon, SettingsIcon } from "./ActionsBanner";

/** Loaders that have a separate build/version number to pick beyond the game version. */
const LOADERS_WITH_BUILD_VERSION = ["fabric", "neoforge"];

interface ModpackProfile {
  display_name: string;
  version_id: string;
  core: "VANILLA" | "FABRIC" | "NEOFORGE" | "FORGE";
  loader_version: string | null;
  max_ram: number;
  min_ram: number;
  use_custom_ram: boolean;
  java_path: string | null;
  jvm_arguments: string;
  icon: string | null;
  banner: string | null;
}
interface ModpackEntry {
  name: string;
  profile: ModpackProfile;
  icon_data: string | null;
  banner_data: string | null;
}

/** What `peek_modpack_file` returns — parsed from a picked .nihaopack/.mrpack without
 *  extracting or downloading anything, for the "Install modpack" screen's preview. */
interface ImportPreview {
  format: "own" | "mrpack";
  name: string;
  minecraft_version: string;
  loader: string;
  loader_version: string | null;
}

export function PagesBrowser() {
  return (
    <Routes>
      <Route path="/play" element={<MinecraftLaunch />} />
      <Route path="/" element={<ModpacksList />} />
    </Routes>
  )
}

/** The configured install path from Settings, falling back to the plugin's own default. */
function useGamePath(): string | undefined {
  const call_module = useCallModule();
  const { gamePath } = useLauncher() ?? {};
  const [fallback, setFallback] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (gamePath) return;
    call_module("get_config", {})
      .then((cfg: any) => setFallback(cfg?.defaultPath))
      .catch(console.error);
  }, [gamePath]);

  return gamePath ?? fallback;
}

/** The player's nickname, from the plugin's "Nickname" setting — drives the offline session's
 *  display name (and derived UUID) at launch instead of the "Player" fallback. */
function useNickname(): string | undefined {
  const call_module = useCallModule();
  const { gameSettings } = useLauncher() ?? {};
  const [fallback, setFallback] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (gameSettings?.nickname !== undefined) return;
    call_module("get_config", {})
      .then((cfg: any) => {
        const nicknameField = cfg?.settingsFields?.find((f: any) => f.key === "nickname");
        setFallback(nicknameField?.defaultValue);
      })
      .catch(console.error);
  }, [gameSettings?.nickname]);

  return gameSettings?.nickname ?? fallback;
}

/** The plugin's background image, as a base64 data URI from `get_config()` — not fetched via
 *  the `nihao://` custom protocol: Tauri 1.x's custom-protocol response path is unreliable for
 *  larger files on Windows/WebView2 in practice (small images load fine, this one didn't), so
 *  it's embedded straight into the config response instead (see `asset_data_uri` in lib.rs). */
function useBackgroundImage(): string | undefined {
  const call_module = useCallModule();
  const [background, setBackground] = useState<string | undefined>(undefined);

  useEffect(() => {
    call_module("get_config", {})
      .then((cfg: any) => setBackground(cfg?.background))
      .catch(console.error);
  }, []);

  return background;
}

/** Any other embedded asset (see `get_asset` in lib.rs / `Assets` in lib.rs), as a base64 data
 *  URI — same reasoning as `useBackgroundImage`: a direct `import "./assets/..."` resolves fine
 *  in a production build (Vite inlines it into the bundle), but under this project's dev mode
 *  (`DEV_MODULE` — see developing.rs's `get_dev_ui_script`) the whole UI is `import()`-ed
 *  straight from the Vite dev server into the launcher's own window, so a plain asset import
 *  turns into a dev-server-relative URL string (e.g. `/src/assets/...png`) that then gets
 *  resolved against the *launcher window's* origin, not `localhost:5173` — never loads. The
 *  `get_asset` IPC round-trip sidesteps that entirely, in dev and prod alike. `path` is relative
 *  to `ui/src/assets/` (e.g. `"minecraft/services/modrinth.png"`). */
function useAssetIcon(path: string): string | undefined {
  const call_module = useCallModule();
  const [url, setUrl] = useState<string | undefined>(undefined);

  useEffect(() => {
    call_module("get_asset", { path })
      .then((res: any) => setUrl(res?.url))
      .catch(console.error);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  return url;
}

/** The general "Game settings" RAM allocation — used at launch for instances that have
 *  "use custom RAM" turned off, and shown as a hint while that toggle is off. */
function useGeneralRam(): number | undefined {
  const call_module = useCallModule();
  const { gameSettings } = useLauncher() ?? {};
  const [fallback, setFallback] = useState<number | undefined>(undefined);

  useEffect(() => {
    if (gameSettings?.ram !== undefined) return;
    call_module("get_config", {})
      .then((cfg: any) => {
        const ramField = cfg?.settingsFields?.find((f: any) => f.key === "ram");
        setFallback(ramField?.defaultValue);
      })
      .catch(console.error);
  }, [gameSettings?.ram]);

  return gameSettings?.ram ?? fallback;
}

function useInstances(gamePath: string | undefined) {
  const call_module = useCallModule();
  const [instances, setInstances] = useState<ModpackEntry[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = () => {
    if (!gamePath) return;
    setLoading(true);
    call_module("get_modpacks", { path: gamePath })
      .then((res: any) => setInstances(Array.isArray(res) ? res : []))
      .catch(console.error)
      .finally(() => setLoading(false));
  };

  useEffect(reload, [gamePath]);

  return { instances, loading, reload };
}

export function ModpacksList() {
  const [activeTab, setActiveTab] = useState("all");
  const [createModpackModalOpen, setCreateModpackModalOpen] = useState(false);
  const gamePath = useGamePath();
  const { instances, loading, reload } = useInstances(gamePath);

  const tabs = [
    { key: "all", label: t("minecraft.modpacks_list.allInstanceLabel", "All Instance") },
    { key: "public", label: t("minecraft.modpacks_list.publicInstanceLabel", "Public"), disabled: true },
    { key: "custom", label: t("minecraft.modpacks_list.customInstanceLabel", "Custom") },
  ];

  return (
    <>
      <div style={{ width: "calc(100% - 20px)", height: "50px", display: "flex", alignItems: "center", margin: "0 10px 0 10px" }}>
        <nav style={{
          display: "flex",
          gap: "4px",
          backgroundColor: "var(--second-background-color)",
          borderRadius: "50px",
          padding: "4px",
        }}>
          {tabs.map((tab) => (
            <button
              disabled={tab.disabled ?? false}
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              style={{
                padding: "8px 16px",
                borderRadius: "50px",
                border: "none",
                backgroundColor: activeTab === tab.key ? "var(--main-color)" : "transparent",
                color: tab.disabled ? "var(--text-disabled-color)" : "var(--text-color)",
                fontSize: "14px",
                fontWeight: 600,
                cursor: tab.disabled ? "not-allowed" : "pointer",
                transition: "background-color 0.2s",
                boxShadow: "none",
              }}
            >
              {tab.label}
            </button>
          ))}
        </nav>
        <button
          onClick={() => setCreateModpackModalOpen(true)}
          style={{ marginLeft: "auto", backgroundColor: "var(--main-color)" }}
        >
          <T k="minecraft.modpacks_list.customButtonLabel" alt="Create/Import" />
        </button>
      </div>
      <div style={{
        width: "100%",
        height: "calc(100% - 50px)",
        borderTopLeftRadius: "var(--border-radius)",
        borderTopRightRadius: "var(--border-radius)"
      }}
      >
        {(activeTab === "all" || activeTab === "custom") && (
          <InstancesGrid instances={instances} loading={loading} gamePath={gamePath} reload={reload} />
        )}
        {activeTab === "public" && <ModpacksContent />}
        <CreateModpackModal
          open={createModpackModalOpen}
          onClose={() => setCreateModpackModalOpen(false)}
          onCreated={reload}
        />
      </div>
    </>
  )
}

function PlayIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true">
      <path d="M6.5 4.5a1 1 0 0 1 1.5-.87l12 7.5a1 1 0 0 1 0 1.74l-12 7.5A1 1 0 0 1 6.5 19.5v-15Z" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <path d="M4 7h16" strokeLinecap="round" />
      <path d="M9 7V4.5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1V7" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M6 7l1 12.5a1.5 1.5 0 0 0 1.5 1.4h7a1.5 1.5 0 0 0 1.5-1.4L18 7" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M10 11v6M14 11v6" strokeLinecap="round" />
    </svg>
  );
}

interface TileMenuTarget {
  name: string;
  profile: ModpackProfile;
  icon_data: string | null;
  banner_data: string | null;
}

/** Right-click menu for a modpack tile — Play/Settings/Share jump straight to `/play` (the
 *  latter two auto-opening their modal there, see MinecraftLaunch's `state.openSettings`/
 *  `openShare`); Open folder and Delete act directly since they don't need that page at all. */
function TileContextMenu({
  x, y, target, gamePath, onClose, onDeleted,
}: {
  x: number;
  y: number;
  target: TileMenuTarget;
  gamePath: string | undefined;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const navigate = useNavigate();
  const call_module = useCallModule();
  const menuRef = useRef<HTMLDivElement>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    function handlePointerDown(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose();
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose]);

  function goToPlay(extra?: { openSettings?: boolean; openShare?: boolean }) {
    navigate("/play", { state: { ...target, ...extra } });
    onClose();
  }

  async function handleOpenFolder() {
    if (!gamePath) return;
    try {
      await call_module("open_modpack_folder", { path: gamePath, name: target.name });
    } catch (e) {
      console.error(e);
    }
    onClose();
  }

  async function handleDelete() {
    if (!gamePath) return;
    setDeleting(true);
    try {
      await call_module("delete_modpack", { path: gamePath, name: target.name });
      onDeleted();
    } catch (e) {
      console.error(e);
    } finally {
      setDeleting(false);
      onClose();
    }
  }

  if (confirmDelete) {
    return (
      <ConfirmModal
        isOpen
        onCancel={() => { setConfirmDelete(false); onClose(); }}
        onConfirm={handleDelete}
        message={t(
          "minecraft.modpacks_list.delete_confirm",
          `Delete "${target.profile.display_name}"? This removes all its saves and mods permanently.`
        )}
        confirmText={t("minecraft.modpack_settings.delete", "Delete instance")}
        variant="danger"
      />
    );
  }

  return (
    <div ref={menuRef} className="modpack-context-menu" style={{ left: x, top: y }}>
      <button onClick={() => goToPlay()}>
        <PlayIcon />
        {t("minecraft.modpacks_list.menu_play", "Play")}
      </button>
      <button onClick={() => goToPlay({ openSettings: true })}>
        <SettingsIcon />
        {t("minecraft.modpack_settings.title", "Modpack settings")}
      </button>
      <button onClick={() => goToPlay({ openShare: true })}>
        <ShareIcon />
        {t("minecraft.share.title", "Share modpack")}
      </button>
      <button onClick={handleOpenFolder}>
        <OpenFolderIcon />
        {t("minecraft.modpacks_list.menu_open_folder", "Open folder")}
      </button>
      <hr />
      <button className="danger" onClick={() => setConfirmDelete(true)} disabled={deleting}>
        <TrashIcon />
        {t("minecraft.modpack_settings.delete", "Delete instance")}
      </button>
    </div>
  );
}

/** Tiles — banner dimmed/grayscale at rest, full color on hover, same idea as the old
 *  launcher's local-modpack list (see nihao-client-old/src/pages/game_list.html's .modpack).
 *  Each instance can set its own banner (Modpack settings → General); falls back to the
 *  plugin's shared background image (same as the old launcher's assets/background.png) for
 *  instances that haven't.
 *  Sized so ~4 fit per row at the launcher's default window width. */
function InstancesGrid({
  instances, loading, gamePath, reload,
}: {
  instances: ModpackEntry[];
  loading: boolean;
  gamePath: string | undefined;
  reload: () => void;
}) {
  const navigate = useNavigate();
  const defaultBackground = useBackgroundImage();
  const [menu, setMenu] = useState<{ x: number; y: number; target: TileMenuTarget } | null>(null);

  if (loading) {
    return <div style={{ padding: "20px", color: "var(--text-color, white)" }}>
      <T k="minecraft.modpacks_list.loading" alt="Loading..." />
    </div>;
  }
  if (instances.length === 0) {
    return <div style={{ padding: "20px", color: "var(--text-color, white)" }}>
      <T k="minecraft.modpacks_list.empty" alt="No instances yet — create one to get started." />
    </div>;
  }

  return (
    <div className="modpack-tiles">
      {instances.map(({ name, profile, icon_data, banner_data }) => {
        const background = banner_data ?? defaultBackground;
        return (
          <div
            key={name}
            className="modpack-tile"
            onClick={() => navigate("/play", { state: { name, profile, icon_data, banner_data } })}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu({ x: e.clientX, y: e.clientY, target: { name, profile, icon_data, banner_data } });
            }}
          >
            <div className="modpack-tile-background">
              {background && <img src={background} alt="" />}
            </div>
            <div className="modpack-tile-info">
              <img className="modpack-tile-icon" src={icon_data ?? PACKAGE} alt="" />
              <div className="modpack-tile-text">
                <h2>{profile.display_name}</h2>
                <p>{profile.core} · {profile.version_id}</p>
              </div>
            </div>
          </div>
        );
      })}

      {menu && (
        <TileContextMenu
          x={menu.x}
          y={menu.y}
          target={menu.target}
          gamePath={gamePath}
          onClose={() => setMenu(null)}
          onDeleted={reload}
        />
      )}
    </div>
  );
}

function AccountIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <circle cx="12" cy="8" r="3.5" />
      <path d="M4.5 20c1.4-3.6 4.4-5.5 7.5-5.5s6.1 1.9 7.5 5.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ChevronDownIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** The "session" (login) profile the game will launch under — currently a UI-only pick, not
 *  wired to `play_modpack` yet: "Offline" is the only one that actually reflects how the game
 *  launches today (the plain nickname from Game settings). "Online" is a placeholder for real
 *  Microsoft/Xbox Live/Minecraft-services auth — a genuinely large feature (device-code OAuth
 *  flow, token storage/refresh) intentionally not built yet. A third "own NiHao account" option
 *  is planned but must NOT be added here in any form — not even a disabled placeholder — until
 *  explicitly asked for. */
function SessionSelector() {
  const nickname = useNickname();
  // Offline has no real account/skin to show, so it's always this fixed placeholder — once
  // online accounts are wired up, THAT profile's avatar becomes the player's actual skin head
  // (fetched by UUID), but offline stays this icon permanently regardless.
  const offlineIcon = useAssetIcon("minecraft/offline-session.png");
  const [profile, setProfile] = useState<"offline" | "online">("offline");
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handlePointerDown(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpen(false);
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  const profiles: Record<"offline" | "online", { name: string; subtitle: string }> = {
    offline: {
      name: nickname ?? t("minecraft.launch.session_offline", "Offline"),
      subtitle: t("minecraft.launch.session_offline_subtitle", "Offline account"),
    },
    online: {
      name: t("minecraft.launch.session_not_signed_in", "Not signed in"),
      subtitle: t("minecraft.launch.session_online_subtitle", "Minecraft account"),
    },
  };
  const current = profiles[profile];

  // Offline always shows the fixed placeholder head; online will show the signed-in player's
  // real skin head once that's wired up — until then it falls back to the same generic icon.
  function avatarFor(p: "offline" | "online") {
    if (p === "offline") {
      return offlineIcon ? <img src={offlineIcon} alt="" /> : <AccountIcon />;
    }
    return <AccountIcon />;
  }

  return (
    <div className="modpack-session-selector" ref={menuRef}>
      <button className="modpack-launch-btn modpack-session-btn" onClick={() => setOpen((v) => !v)}>
        <span className="modpack-session-avatar">{avatarFor(profile)}</span>
        <span className="modpack-session-info">
          <span className="modpack-session-name">{current.name}</span>
          <span className="modpack-session-type">{current.subtitle}</span>
        </span>
        <ChevronDownIcon />
      </button>
      {open && (
        <div className="modpack-session-menu">
          {(["offline", "online"] as const).map((p) => (
            <button
              key={p}
              className={p === profile ? "active" : ""}
              onClick={() => { setProfile(p); setOpen(false); }}
            >
              <span className="modpack-session-avatar">{avatarFor(p)}</span>
              <span className="modpack-session-info">
                <span className="modpack-session-name">{profiles[p].name}</span>
                <span className="modpack-session-type">{profiles[p].subtitle}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ModpacksContent() {
  return <div style={{ padding: "20px", color: "var(--text-color, white)" }}>Modpacks content</div>;
}

export function MinecraftLaunch() {
  const call_module = useCallModule();
  const navigate = useNavigate();
  const gamePath = useGamePath();
  const generalRam = useGeneralRam();
  const nickname = useNickname();
  const defaultBackground = useBackgroundImage();
  const location = useLocation();
  const state = location.state as {
    name?: string;
    profile?: ModpackProfile;
    icon_data?: string | null;
    banner_data?: string | null;
    /** Set by the modpack tile's context menu (InstancesGrid) to jump straight into the
     *  matching modal instead of landing on the plain launch page first. */
    openSettings?: boolean;
    openShare?: boolean;
  } | null;
  const [launching, setLaunching] = useState(false);
  const [running, setRunning] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  // Console and Content manager share the same right-hand pane — only one at a time, like a
  // sidebar tool panel rather than separate popups.
  const [sidePanel, setSidePanel] = useState<"none" | "console" | "content">("none");
  const [settingsOpen, setSettingsOpen] = useState(state?.openSettings ?? false);
  const [shareOpen, setShareOpen] = useState(state?.openShare ?? false);
  const [profile, setProfile] = useState(state?.profile);
  const [iconData, setIconData] = useState(state?.icon_data ?? null);
  const [bannerData, setBannerData] = useState(state?.banner_data ?? null);
  const background = bannerData ?? defaultBackground;
  const [error, setError] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  // Poll the running process's captured stdout/stderr — the plugin call boundary can't
  // push a live log, so this is a simple poll instead. Also detects the game exiting on
  // its own (crash, or the player quitting from in-game) and flips the button back.
  useEffect(() => {
    if (!running || !state?.name) return;
    let cancelled = false;

    const poll = async () => {
      try {
        const res: any = await call_module("get_launch_log", { name: state.name });
        if (cancelled) return;
        setLog(Array.isArray(res?.log) ? res.log : []);
        if (!res?.running) setRunning(false);
      } catch {
        if (!cancelled) setRunning(false);
      }
    };

    poll();
    const interval = setInterval(poll, 800);
    return () => { cancelled = true; clearInterval(interval); };
  }, [running, state?.name]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [log]);

  if (!state?.name) {
    return <Navigate to="/" replace />;
  }

  async function handleLaunch() {
    if (!gamePath || !state?.name) return;
    setLaunching(true);
    setError(null);
    setLog([]);
    setSidePanel("console");
    try {
      // "Use custom RAM" off means the general Game settings RAM value is used instead —
      // decided on the Rust side now (reads game.nihao directly), not here, so it's correct
      // even if this page's own copy of that setting (generalRam, below) hasn't loaded yet.
      await call_module("play_modpack", { path: gamePath, name: state.name, nickname });
      setRunning(true);
    } catch (e) {
      setError(String(e));
    } finally {
      setLaunching(false);
    }
  }

  async function handleClose() {
    if (!state?.name) return;
    try {
      await call_module("close_modpack", { name: state.name });
    } catch (e) {
      console.error(e);
    } finally {
      setRunning(false);
    }
  }

  async function handleOpenFolder() {
    if (!gamePath || !state?.name) return;
    try {
      await call_module("open_modpack_folder", { path: gamePath, name: state.name });
    } catch (e) {
      console.error(e);
    }
  }

  const logPanelOpen = sidePanel !== "none";

  return (
    <div style={{
      width: "100%",
      height: "100%",
      position: "relative",
      overflow: "hidden",
    }}>
      <div style={{
        position: "absolute",
        inset: 0,
        backgroundImage: background ? `url(${background})` : undefined,
        backgroundColor: "var(--main-background-color)",
        backgroundSize: "cover",
        backgroundPosition: "center",
        backgroundRepeat: "no-repeat",
        zIndex: 0,
        borderTopLeftRadius: "var(--border-radius)",
        borderTopRightRadius: "var(--border-radius)"
      }} />
      <div style={{
        position: "absolute",
        inset: 0,
        background: "linear-gradient(to right, rgba(0,0,0,0.9) 0%, transparent 40%)",
        zIndex: 1,
      }} />
      <ActionsBanner
        visible={!logPanelOpen}
        onOpenConsole={() => setSidePanel((p) => (p === "console" ? "none" : "console"))}
        onOpenFolder={handleOpenFolder}
        onShare={() => setShareOpen(true)}
        onOpenContent={() => setSidePanel((p) => (p === "content" ? "none" : "content"))}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      <ShareModal
        open={shareOpen}
        onClose={() => setShareOpen(false)}
        gamePath={gamePath}
        name={state.name}
      />
      {profile && (
        <ModpackSettingsModal
          open={settingsOpen}
          onClose={() => setSettingsOpen(false)}
          name={state.name}
          profile={profile}
          iconData={iconData}
          bannerData={bannerData}
          generalRam={generalRam}
          onProfileChange={setProfile}
          onIconChange={setIconData}
          onBannerChange={setBannerData}
          onDeleted={() => navigate("/", { replace: true })}
          onDuplicated={(newName: string) => navigate("/", { replace: true, state: { justDuplicated: newName } })}
        />
      )}
      <div style={{
        position: "relative",
        zIndex: 2,
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        padding: "20px 20px 20px 20px",
        gap: "20px",
        boxSizing: "border-box",
      }}>
        <div style={{ display: "flex", flex: 1, minHeight: 0, gap: "20px" }}>
          <div style={{
            width: "300px",
            flexShrink: 0,
            display: "flex",
            flexDirection: "column",
            gap: "8px",
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
              {iconData && (
                <img src={iconData} alt="" style={{ width: "48px", height: "48px", borderRadius: "10px", objectFit: "cover", flexShrink: 0 }} />
              )}
              <h1 style={{ margin: 0 }}>{profile?.display_name ?? state.name}</h1>
            </div>
            <div style={{ overflowY: "auto" }}>
              <p>{profile ? `${profile.core} · ${profile.version_id}` : ""}</p>
            </div>
          </div>
          <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column" }}>
            {sidePanel === "console" && (
              <div className="client-log-panel">
                <div className="client-log-header">
                  <span>{t("minecraft.launch.log_title", "Client log")}</span>
                  <button
                    className="client-log-close"
                    onClick={() => setSidePanel("none")}
                    title={t("minecraft.launch.log_close", "Close log")}
                  >
                    ×
                  </button>
                </div>
                <div ref={logRef} className="client-log">
                  {log.length === 0 && <div className="client-log-line client-log-empty">Waiting for client output...</div>}
                  {log.map((line, i) => <div key={i} className="client-log-line">{line}</div>)}
                </div>
              </div>
            )}
            {sidePanel === "content" && (
              <ContentManagerPanel onClose={() => setSidePanel("none")} gamePath={gamePath} name={state.name} />
            )}
          </div>
        </div>
        <div style={{
          width: "100%",
          flexShrink: 0,
        }}>
          <div style={{ display: "flex", alignItems: "stretch", gap: "10px" }}>
            <button
              className="modpack-launch-btn"
              onClick={running ? handleClose : handleLaunch}
              disabled={launching || (!running && !gamePath)}
              style={{ fontSize: "24px", width: "300px" }}>
              {launching
                ? t("minecraft.launch.launching", "Launching...")
                : running
                  ? t("minecraft.launch.close", "Close")
                  : t("minecraft.launch.button", "Launch")}
            </button>
            <SessionSelector />
          </div>
          {error && <p style={{ color: "#ff6b6b", fontSize: "0.85rem" }}>{error}</p>}
        </div>
      </div>
    </div>
  )
}

/** Top-level entries checked by default when the Share modal's file list first loads — the
 *  usual "actual pack content" folders. Everything else `list_export_entries` returns (saves,
 *  logs, options.txt, ...) still shows up, just unchecked. */
const DEFAULT_CHECKED_ENTRIES = ["config", "mods", "datapacks", "resourcepacks", "shaderpacks"];

interface ExportEntry {
  name: string;
  is_dir: boolean;
}

function OwnFormatIcon() {
  return (
    <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <path d="M3.5 8.5 12 4l8.5 4.5v7L12 20l-8.5-4.5v-7Z" strokeLinejoin="round" />
      <path d="M3.5 8.5 12 13l8.5-4.5M12 13v7" strokeLinejoin="round" />
    </svg>
  );
}

function MrpackFormatIcon() {
  return (
    <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <path d="M7 16.5a4 4 0 0 1-.5-7.97A5.5 5.5 0 0 1 17.4 9.1 3.75 3.75 0 0 1 17 16.5H7Z" strokeLinejoin="round" />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true">
      <path d="M3.5 5.5A1.5 1.5 0 0 1 5 4h4.6c.4 0 .77.17 1.03.47l1.2 1.4a1.5 1.5 0 0 0 1.14.53H19a1.5 1.5 0 0 1 1.5 1.5v10a1.5 1.5 0 0 1-1.5 1.5H5a1.5 1.5 0 0 1-1.5-1.5v-13Z" />
    </svg>
  );
}

function FileIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path d="M6 2.5h7l4 4V20a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V3.5a1 1 0 0 1 1-1Z" strokeLinejoin="round" />
      <path d="M13 2.5V6a1 1 0 0 0 1 1h3.5" strokeLinejoin="round" />
    </svg>
  );
}

/** Several commands just kick a job off in the background and return immediately (export,
 *  import, Modrinth installs — see interface.rs's export_modpack_own/export_modpack_mrpack/
 *  install_modrinth_content) — the same shared `get_install_status` the bottom `.progress` bar
 *  polls tracks each one under `label`. Polls until that entry disappears (done), returning the
 *  failure message if `lastError` names this same job, or `null` on success. */
async function waitForBackgroundJob(call_module: (method: string, args?: any) => Promise<any>, label: string): Promise<string | null> {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const res: any = await call_module("get_install_status", {});
    const stillRunning = Array.isArray(res?.installing) && res.installing.some((p: any) => p?.name === label);
    if (stillRunning) continue;
    if (res?.lastError?.name === label) return String(res.lastError.error ?? "Job failed.");
    return null;
  }
}

/** "Share" — exports the instance as a self-contained archive someone else can install with
 *  no server involved. Two formats: this project's own (manifest + every file, bundled) or a
 *  standard Modrinth .mrpack (files Modrinth recognizes by hash point at its CDN, the rest go
 *  in overrides/). See MODPACK_FORMAT.md and library::export on the Rust side. */
function ShareModal({
  open, onClose, gamePath, name,
}: {
  open: boolean;
  onClose: () => void;
  gamePath: string | undefined;
  name: string;
}) {
  const call_module = useCallModule();
  const [entries, setEntries] = useState<ExportEntry[]>([]);
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [exporting, setExporting] = useState<"own" | "mrpack" | null>(null);
  const [hoveredFormat, setHoveredFormat] = useState<"own" | "mrpack" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !gamePath) return;
    setError(null);
    setSuccess(null);
    call_module("list_export_entries", { path: gamePath, name })
      .then((res: any) => {
        const list: ExportEntry[] = Array.isArray(res) ? res : [];
        setEntries(list);
        setChecked(Object.fromEntries(list.map((entry) => [entry.name, DEFAULT_CHECKED_ENTRIES.includes(entry.name)])));
      })
      .catch((e: any) => setError(String(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, gamePath, name]);

  function toggleEntry(entry: string) {
    setChecked((prev) => ({ ...prev, [entry]: !prev[entry] }));
  }

  async function handleExport(format: "own" | "mrpack") {
    if (!gamePath || exporting) return;
    const include = entries.filter((entry) => checked[entry.name]).map((entry) => entry.name);
    if (include.length === 0) {
      setError(t("minecraft.share.nothing_selected", "Select at least one folder or file to export."));
      return;
    }
    setError(null);
    setSuccess(null);
    try {
      const dest = await saveFileDialog({
        defaultPath: format === "own" ? `${name}.nihaopack` : `${name}.mrpack`,
        filters: [
          format === "own"
            ? { name: "NiHao Modpack", extensions: ["nihaopack"] }
            : { name: "Modrinth Modpack", extensions: ["mrpack"] },
        ],
      });
      if (!dest) return;
      setExporting(format);
      const method = format === "own" ? "export_modpack_own" : "export_modpack_mrpack";
      // The command itself just kicks the export off in the background (like install does) —
      // progress shows up in the launcher's own bottom .progress bar (see interface.rs's
      // export_job_label) while we poll here for it to finish.
      await call_module(method, { path: gamePath, name, include, dest_path: dest });
      const jobError = await waitForBackgroundJob(call_module, `${name} (export)`);
      if (jobError) throw new Error(jobError);
      setSuccess(t("minecraft.share.exported", "Exported successfully."));
    } catch (e) {
      setError(String(e));
    } finally {
      setExporting(null);
    }
  }

  return (
    <Modal isOpen={open} onClose={onClose} title={t("minecraft.share.title", "Share modpack")} size="medium">
      <div className="option-container">
        <p className="modpack-option-hint">
          {t(
            "minecraft.share.hint",
            "Export this instance to a file someone else can install — no server involved."
          )}
        </p>

        <div className="modpack-share-formats">
          <div
            className={`modpack-share-format${hoveredFormat && hoveredFormat !== "own" ? " dimmed" : ""}`}
            onMouseEnter={() => setHoveredFormat("own")}
            onMouseLeave={() => setHoveredFormat((f) => (f === "own" ? null : f))}
          >
            <button
              className="modpack-share-format-btn"
              onClick={() => handleExport("own")}
              disabled={exporting !== null || !gamePath}
            >
              <OwnFormatIcon />
            </button>
            <div className={`modpack-share-format-flyout${hoveredFormat === "own" ? " visible" : ""}`}>
              <strong>
                {exporting === "own"
                  ? t("minecraft.share.exporting", "Exporting...")
                  : t("minecraft.share.own_format", "Our format (.nihaopack)")}
              </strong>
              <span>{t("minecraft.share.own_format_hint", "Self-contained — bundles every file, ready to unzip and use.")}</span>
            </div>
          </div>

          <div
            className={`modpack-share-format${hoveredFormat && hoveredFormat !== "mrpack" ? " dimmed" : ""}`}
            onMouseEnter={() => setHoveredFormat("mrpack")}
            onMouseLeave={() => setHoveredFormat((f) => (f === "mrpack" ? null : f))}
          >
            <button
              className="modpack-share-format-btn"
              onClick={() => handleExport("mrpack")}
              disabled={exporting !== null || !gamePath}
            >
              <MrpackFormatIcon />
            </button>
            <div className={`modpack-share-format-flyout${hoveredFormat === "mrpack" ? " visible" : ""}`}>
              <strong>
                {exporting === "mrpack"
                  ? t("minecraft.share.exporting", "Exporting...")
                  : t("minecraft.share.mrpack_format", "Modrinth (.mrpack)")}
              </strong>
              <span>
                {t("minecraft.share.mrpack_format_hint", "Standard format other launchers understand. Needs internet to look up mods on Modrinth.")}
              </span>
            </div>
          </div>
        </div>

        <SettingsDivider />

        <div className="option">
          <label>{t("minecraft.share.files_label", "What to include")}</label>
          <div className="modpack-share-files">
            {entries.map((entry) => (
              <label key={entry.name} className="modpack-file-row">
                <input type="checkbox" checked={!!checked[entry.name]} onChange={() => toggleEntry(entry.name)} />
                <span className="modpack-file-icon">{entry.is_dir ? <FolderIcon /> : <FileIcon />}</span>
                <span className="modpack-file-name">{entry.name}</span>
              </label>
            ))}
            {entries.length === 0 && (
              <p className="modpack-option-hint">{t("minecraft.share.no_files", "This instance has no files yet.")}</p>
            )}
          </div>
        </div>

        {error && <p className="modpack-error">{error}</p>}
        {success && <p className="modpack-option-hint">{success}</p>}
      </div>
    </Modal>
  );
}

/** What `list_content` returns — every mod/resourcepack/shaderpack/datapack currently in the
 *  instance. `display_name`/`version`/`icon_data` come from the file's own metadata and/or a
 *  Modrinth lookup by hash — cached on the Rust side (`content_cache.rs`) so this stays fast.
 *  `enabled` is only meaningful for mods (a `*.jar.disabled` file) — always `true` for the
 *  other three categories. */
interface ContentEntry {
  name: string;
  size: number;
  is_dir: boolean;
  enabled: boolean;
  display_name?: string;
  version?: string;
  icon_data?: string;
  project_id?: string;
}
interface ContentLists {
  mods: ContentEntry[];
  resourcepacks: ContentEntry[];
  shaderpacks: ContentEntry[];
  datapacks: ContentEntry[];
}

type ContentCategory = "mods" | "resourcepacks" | "shaderpacks" | "datapacks";

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}

/** `1234` -> `"1.2K"`, `2600000` -> `"2.6M"` — for Modrinth download counts under Browse
 *  content's Install button, which don't have room for `.toLocaleString()`'s full digit count. */
function formatCount(n: number): string {
  if (n < 1000) return String(n);
  const units = ["K", "M", "B"];
  let value = n / 1000;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)}${units[unit]}`;
}

function DownloadIcon() {
  return (
    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M12 3v12" strokeLinecap="round" />
      <path d="M7 10l5 5 5-5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M4 19.5h16" strokeLinecap="round" />
    </svg>
  );
}

/** "Content manager" — browses what's actually in the instance's mods/resourcepacks/
 *  shaderpacks/datapacks folders, in the same right-hand pane as the client log (only one of
 *  the two showing at a time — see `sidePanel` in MinecraftLaunch), not a popup modal. Texture
 *  packs live in the same `resourcepacks/` folder as any other resource pack in modern
 *  Minecraft, so they're not a separate category here. Mods can be toggled/deleted in place;
 *  "Browse content" (a real modal — see `BrowseContentModal`) adds new ones from Modrinth. */
function ContentManagerPanel({
  onClose, gamePath, name,
}: {
  onClose: () => void;
  gamePath: string | undefined;
  name: string;
}) {
  const call_module = useCallModule();
  const [category, setCategory] = useState<ContentCategory>("mods");
  const [content, setContent] = useState<ContentLists | null>(null);
  const [loading, setLoading] = useState(false);
  const [scanProgress, setScanProgress] = useState<{ category: string; current: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [browseOpen, setBrowseOpen] = useState(false);

  /** Kicks off `start_content_scan` and polls `get_content_scan_status` until it's done —
   *  rather than one blocking `list_content` call — so the panel can show real progress instead
   *  of a plain "Loading..." for however long the first scan of a freshly-imported modpack
   *  (parsing/hashing/Modrinth-looking-up a hundred-plus mods) actually takes. */
  async function reload() {
    if (!gamePath) return;
    setLoading(true);
    setError(null);
    setScanProgress(null);
    try {
      await call_module("start_content_scan", { path: gamePath, name });
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const res: any = await call_module("get_content_scan_status", { name });
        if (res?.status === "scanning") {
          setScanProgress({ category: res.category, current: res.current, total: res.total });
        } else if (res?.status === "done") {
          setContent(res.lists);
          break;
        } else if (res?.status === "error") {
          throw new Error(res.error);
        } else if (res?.status !== "idle") {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
      setScanProgress(null);
    }
  }

  useEffect(() => { reload(); }, [gamePath, name]); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleToggle(filename: string) {
    if (!gamePath) return;
    try {
      await call_module("toggle_content_file", { path: gamePath, name, category, filename });
      reload();
    } catch (e) {
      setError(String(e));
    }
  }

  async function handleDelete(filename: string) {
    if (!gamePath) return;
    try {
      await call_module("delete_content_file", { path: gamePath, name, category, filename });
      reload();
    } catch (e) {
      setError(String(e));
    }
  }

  const entries = content?.[category] ?? [];
  const categories: { key: ContentCategory; label: string }[] = [
    { key: "mods", label: t("minecraft.content_manager.mods", "Mods") },
    { key: "resourcepacks", label: t("minecraft.content_manager.resourcepacks", "Resource packs") },
    { key: "shaderpacks", label: t("minecraft.content_manager.shaderpacks", "Shader packs") },
    { key: "datapacks", label: t("minecraft.content_manager.datapacks", "Datapacks") },
  ];
  const scanCategoryLabel = categories.find((c) => c.key === scanProgress?.category)?.label ?? scanProgress?.category;

  return (
    <div className="client-log-panel">
      <div className="client-log-header">
        <span>{t("minecraft.content_manager.title", "Content manager")}</span>
        <button className="client-log-close" onClick={onClose} title={t("minecraft.launch.log_close", "Close")}>
          ×
        </button>
      </div>

      <div className="content-manager-tabs">
        <nav className="pill-nav">
          {categories.map((c) => (
            <button
              key={c.key}
              className={c.key === category ? "active" : ""}
              onClick={() => setCategory(c.key)}
            >
              {c.label}
            </button>
          ))}
        </nav>
        <button className="content-manager-browse-btn" onClick={() => setBrowseOpen(true)}>
          {t("minecraft.content_manager.browse", "Browse content")}
        </button>
      </div>

      {/* Portalled to <body> rather than rendered inline: this panel's own CSS
          (`backdrop-filter`, for readability against the launch page's background) makes it a
          new containing block for `position: fixed` descendants — Modal's fixed-positioned
          overlay would otherwise be confined to this narrow side panel instead of covering the
          whole window. */}
      {browseOpen && createPortal(
        <BrowseContentModal
          onClose={() => setBrowseOpen(false)}
          gamePath={gamePath}
          name={name}
          category={category}
          onInstalled={reload}
          installedProjectIds={new Set(entries.map((e) => e.project_id).filter((id): id is string => !!id))}
        />,
        document.body
      )}

      <div className="content-manager-list">
        {loading && (
          <div className="content-manager-scan">
            <p className="modpack-option-hint">
              {scanProgress && scanProgress.total > 0
                ? t("minecraft.content_manager.scanning", "Parsing {{category}}... {{current}}/{{total}}")
                    .replace("{{category}}", String(scanCategoryLabel ?? ""))
                    .replace("{{current}}", String(scanProgress.current))
                    .replace("{{total}}", String(scanProgress.total))
                : t("minecraft.content_manager.loading", "Loading...")}
            </p>
            {scanProgress && scanProgress.total > 0 && (
              <div className="content-manager-scan-bar">
                <div
                  className="content-manager-scan-bar-fill"
                  style={{ width: `${Math.round((scanProgress.current / scanProgress.total) * 100)}%` }}
                />
              </div>
            )}
          </div>
        )}
        {error && <p className="modpack-error">{error}</p>}
        {!loading && !error && (
          <>
            {entries.map((entry) => (
              <div key={entry.name} className={`modpack-content-row${entry.enabled ? "" : " disabled"}`}>
                {entry.icon_data ? (
                  <img className="modpack-content-icon" src={entry.icon_data} alt="" />
                ) : (
                  <span className="modpack-file-icon">{entry.is_dir ? <FolderIcon /> : <FileIcon />}</span>
                )}
                <span className="modpack-content-name" title={entry.display_name ?? entry.name}>
                  {entry.display_name ?? entry.name}
                </span>
                <div className="modpack-content-meta">
                  {entry.version && <span className="modpack-content-version">{entry.version}</span>}
                  <span className="modpack-content-filename" title={entry.name}>{entry.name}</span>
                </div>
                {!entry.is_dir && <span className="modpack-content-size">{formatFileSize(entry.size)}</span>}
                <div className="modpack-content-actions">
                  {category === "mods" && (
                    <button
                      className={`modpack-content-toggle${entry.enabled ? " on" : ""}`}
                      onClick={() => handleToggle(entry.name)}
                      title={entry.enabled
                        ? t("minecraft.content_manager.disable", "Disable")
                        : t("minecraft.content_manager.enable", "Enable")}
                    >
                      <span className="modpack-content-toggle-knob" />
                    </button>
                  )}
                  <button
                    className="modpack-content-delete"
                    onClick={() => handleDelete(entry.name)}
                    title={t("minecraft.content_manager.delete", "Delete")}
                  >
                    <TrashIcon />
                  </button>
                </div>
              </div>
            ))}
            {entries.length === 0 && (
              <p className="modpack-option-hint">{t("minecraft.content_manager.empty", "Nothing here yet.")}</p>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** What `search_modrinth_content` returns. Icons are plain Modrinth CDN URLs here (not
 *  downloaded/base64'd like installed content's — see the Rust side's `modrinth_browse.rs` for
 *  why) — the webview loads them directly. */
interface BrowseHit {
  project_id: string;
  title: string;
  description: string;
  icon_url?: string;
  downloads: number;
  author: string;
  environment: string[];
  categories: string[];
}

/** Modrinth's own `environment` facet values — a project's actual environment support isn't a
 *  single either/or, e.g. `client_or_server` means neither "client", "server", nor "both
 *  required" — so, like Categories, the filter offers all of them as independently togglable
 *  (OR'd) chips instead of collapsing them into one pick. */
const ENVIRONMENT_VALUES = [
  "client_and_server",
  "client_only",
  "client_only_server_optional",
  "singleplayer_only",
  "server_only",
  "server_only_client_optional",
  "dedicated_server_only",
  "client_or_server",
  "client_or_server_prefers_both",
];

/** `"client_only_server_optional"` -> `"client only server optional"` — `text-transform:
 *  capitalize` in CSS handles the rest. */
function formatEnvironmentValue(v: string): string {
  return v.replace(/_/g, " ");
}

/** Modrinth's `environment` on a hit is every environment *any* version of the project
 *  supports, so it's already a list — this just formats each one and drops `"unknown"`. */
function environmentTagLabels(environment: string[]): string[] {
  return environment.filter((v) => v && v !== "unknown").map(formatEnvironmentValue);
}

const MAX_VISIBLE_TAGS = 5;

/** The Environment tag(s) first, then Modrinth's categories (which is also where loaders show
 *  up — Modrinth has no separate loader field) — capped so a long list doesn't blow out the
 *  row, with the rest folded into a "+N" tag. Shared by the search results row
 *  (`BrowseHit.categories` — a curated, space-limited subset) and the detail modal
 *  (`ProjectDetail.categories` — the full list, room permitting there). */
function BrowseTags({ environment, categories }: { environment: string[]; categories: string[] }) {
  const tags = [...environmentTagLabels(environment), ...categories];
  if (tags.length === 0) return null;
  const visible = tags.slice(0, MAX_VISIBLE_TAGS);
  const extra = tags.length - visible.length;
  return (
    <div className="modpack-browse-tags">
      {visible.map((tag, i) => (
        <span key={i} className="modpack-browse-tag">{tag}</span>
      ))}
      {extra > 0 && <span className="modpack-browse-tag modpack-browse-tag-more">+{extra}</span>}
    </div>
  );
}

/** A collapsible filter group in Browse content's filters sidebar — click the title to hide/
 *  show its content, same interaction as Modrinth's own site. */
function FilterSection({ title, children }: { title: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="modpack-browse-filter-section">
      <button type="button" className="modpack-browse-filter-section-toggle" onClick={() => setOpen((v) => !v)}>
        <span>{title}</span>
        <span className={`modpack-browse-filter-chevron${open ? " open" : ""}`}>▾</span>
      </button>
      {open && <div className="modpack-browse-filter-section-body">{children}</div>}
    </div>
  );
}

/** "Browse content" — searches Modrinth for the active category (mod/resourcepack/shader/
 *  datapack), scoped server-side to the instance's own game version/loader, and installs
 *  whichever result the player picks straight into the matching folder. The list re-fetches
 *  (`onInstalled`) afterward so the new file picks up a real cached name/icon the normal way. */
const PAGE_SIZE_OPTIONS = [5, 10, 20, 50, 100];

/** Builds a compact page-number list with `"..."` gap markers, e.g. `[1, "...", 6, 7, 8, "...", 994]` —
 *  always keeps the first/last page and a small window around the current one visible. */
function getPageNumbers(current: number, total: number): (number | "...")[] {
  if (total <= 7) {
    return Array.from({ length: total }, (_, i) => i + 1);
  }
  const pages: (number | "...")[] = [1];
  if (current > 3) pages.push("...");
  const start = Math.max(2, current - 1);
  const end = Math.min(total - 1, current + 1);
  for (let i = start; i <= end; i++) pages.push(i);
  if (current < total - 2) pages.push("...");
  pages.push(total);
  return pages;
}

function BrowseContentModal({
  onClose, gamePath, name, category, onInstalled, installedProjectIds,
}: {
  onClose: () => void;
  gamePath: string | undefined;
  name: string;
  category: ContentCategory;
  onInstalled: () => void;
  installedProjectIds: Set<string>;
}) {
  const call_module = useCallModule();
  const modrinthIcon = useAssetIcon("minecraft/services/modrinth.png");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<BrowseHit[]>([]);
  const [totalHits, setTotalHits] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [searching, setSearching] = useState(false);
  const [installing, setInstalling] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [detailProjectId, setDetailProjectId] = useState<string | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [sort, setSort] = useState("");
  const [selectedCategories, setSelectedCategories] = useState<Set<string>>(new Set());
  const [availableCategories, setAvailableCategories] = useState<string[]>([]);
  const [categoriesLoading, setCategoriesLoading] = useState(false);
  const [selectedEnvironments, setSelectedEnvironments] = useState<Set<string>>(new Set());

  async function handleSearch(targetPage: number, targetPageSize: number) {
    if (!gamePath) return;
    setSearching(true);
    setError(null);
    try {
      const res: any = await call_module("search_modrinth_content", {
        path: gamePath,
        name,
        category,
        query,
        offset: (targetPage - 1) * targetPageSize,
        limit: targetPageSize,
        sort,
        categories: Array.from(selectedCategories),
        environments: Array.from(selectedEnvironments),
      });
      setResults(Array.isArray(res?.hits) ? res.hits : []);
      setTotalHits(typeof res?.total_hits === "number" ? res.total_hits : 0);
    } catch (e) {
      setError(String(e));
    } finally {
      setSearching(false);
    }
  }

  useEffect(() => {
    handleSearch(page, pageSize);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, pageSize, sort, selectedCategories, selectedEnvironments]);

  function runSearch() {
    if (page === 1) {
      handleSearch(1, pageSize);
    } else {
      setPage(1);
    }
  }

  function toggleCategory(c: string) {
    setSelectedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(c)) next.delete(c); else next.add(c);
      return next;
    });
    setPage(1);
  }

  function changeSort(newSort: string) {
    setSort(newSort);
    setPage(1);
  }

  function toggleEnvironment(v: string) {
    setSelectedEnvironments((prev) => {
      const next = new Set(prev);
      if (next.has(v)) next.delete(v); else next.add(v);
      return next;
    });
    setPage(1);
  }

  const activeFilterCount = selectedCategories.size + selectedEnvironments.size + (sort ? 1 : 0);

  useEffect(() => {
    if (!filtersOpen || !gamePath) return;
    setCategoriesLoading(true);
    call_module("list_modrinth_categories", { category })
      .then((res: any) => setAvailableCategories(Array.isArray(res) ? res : []))
      .catch(console.error)
      .finally(() => setCategoriesLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtersOpen]);

  const pageCount = Math.max(1, Math.ceil(totalHits / pageSize));

  async function handleInstall(projectId: string, title: string) {
    if (!gamePath) return;
    setInstalling(projectId);
    setError(null);
    try {
      await call_module("install_modrinth_content", { path: gamePath, name, category, project_id: projectId, title });
      const jobError = await waitForBackgroundJob(call_module, `${title} (Modrinth)`);
      if (jobError) throw new Error(jobError);
      onInstalled();
    } catch (e) {
      setError(String(e));
    } finally {
      setInstalling(null);
    }
  }

  const categoryLabels: Record<ContentCategory, string> = {
    mods: t("minecraft.content_manager.mods", "Mods"),
    resourcepacks: t("minecraft.content_manager.resourcepacks", "Resource packs"),
    shaderpacks: t("minecraft.content_manager.shaderpacks", "Shader packs"),
    datapacks: t("minecraft.content_manager.datapacks", "Datapacks"),
  };

  const paginationBar = (
    <div className="modpack-browse-pagination">
      <button
        className="modpack-browse-page-arrow"
        onClick={() => setPage((p) => Math.max(1, p - 1))}
        disabled={page <= 1 || searching}
      >
        {t("minecraft.content_manager.prev_page", "Prev")}
      </button>
      <span className="modpack-browse-page-numbers">
        {getPageNumbers(page, pageCount).map((p, i) =>
          p === "..." ? (
            <span key={`ellipsis-${i}`} className="modpack-browse-page-ellipsis">…</span>
          ) : (
            <button
              key={p}
              className={`modpack-browse-page-number${p === page ? " active" : ""}`}
              onClick={() => setPage(p)}
              disabled={searching}
            >
              {p}
            </button>
          )
        )}
      </span>
      <button
        className="modpack-browse-page-arrow"
        onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
        disabled={page >= pageCount || searching}
      >
        {t("minecraft.content_manager.next_page", "Next")}
      </button>
      <div className="modpack-browse-page-size-wrap">
        <select
          className="modpack-browse-page-size"
          value={pageSize}
          onChange={(e) => { setPageSize(Number(e.target.value)); setPage(1); }}
        >
          {PAGE_SIZE_OPTIONS.map((size) => (
            <option key={size} value={size}>
              {size}
            </option>
          ))}
        </select>
        <span className="modpack-browse-page-size-display" aria-hidden="true">
          {t("minecraft.content_manager.view", "View")}: {pageSize}
        </span>
      </div>
    </div>
  );

  return (
    <>
    <Modal
      isOpen
      onClose={onClose}
      title={`${t("minecraft.content_manager.browse", "Browse content")} — ${categoryLabels[category]}`}
      size="large"
    >
      <div className="modpack-browse-layout">
        <div className="option-container modpack-browse-main">
          <nav className="pill-nav modpack-browse-services">
            <button type="button" className="active">
              {modrinthIcon && <img className="pill-nav-icon" src={modrinthIcon} alt="" />}
              Modrinth
            </button>
          </nav>

          <div className="modpack-browse-search">
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") runSearch(); }}
              placeholder={t("minecraft.content_manager.search_placeholder", "Search Modrinth...")}
            />
            <button
              className={filtersOpen ? "active" : ""}
              onClick={() => setFiltersOpen((v) => !v)}
            >
              {t("minecraft.content_manager.filters", "Filters")}
              {activeFilterCount > 0 && (
                <span className="modpack-browse-filters-badge">{activeFilterCount}</span>
              )}
            </button>
          </div>

          {error && <p className="modpack-error">{error}</p>}

          {totalHits > 0 && paginationBar}

          <div className="modpack-browse-results">
            {searching && <p className="modpack-option-hint">{t("minecraft.content_manager.searching", "Searching...")}</p>}
            {!searching && results.length === 0 && (
              <p className="modpack-option-hint">{t("minecraft.content_manager.no_results", "No results.")}</p>
            )}
            {!searching && results.map((hit) => {
              const installed = installedProjectIds.has(hit.project_id);
              return (
              <div
                key={hit.project_id}
                className="modpack-browse-row modpack-browse-row-clickable"
                onClick={() => setDetailProjectId(hit.project_id)}
              >
                {hit.icon_url ? (
                  <img className="modpack-browse-icon" src={hit.icon_url} alt="" />
                ) : (
                  <span className="modpack-browse-icon modpack-file-icon"><FileIcon /></span>
                )}
                <div className="modpack-browse-text">
                  <span className="modpack-browse-title">{hit.title}</span>
                  <span className="modpack-browse-description">{hit.description}</span>
                  <BrowseTags environment={hit.environment} categories={hit.categories} />
                </div>
                <div className="modpack-browse-actions">
                  <button
                    className={`modpack-browse-install${installed ? " installed" : ""}`}
                    onClick={(e) => { e.stopPropagation(); handleInstall(hit.project_id, hit.title); }}
                    disabled={installed || installing !== null}
                  >
                    {installed
                      ? t("minecraft.content_manager.installed", "Installed")
                      : installing === hit.project_id
                        ? t("minecraft.content_manager.installing", "Installing...")
                        : t("minecraft.content_manager.install", "Install")}
                  </button>
                  <span className="modpack-browse-downloads">
                    <DownloadIcon /> {formatCount(hit.downloads)}
                  </span>
                </div>
              </div>
              );
            })}
          </div>

          {totalHits > 0 && paginationBar}
        </div>

        {/* Not a modal of its own, and not docked to the screen edge either — a column that
            appears attached to this modal's own right side, sharing its scroll/close/backdrop
            behavior instead of introducing a second layer of overlay. */}
        {filtersOpen && (
          <div className="modpack-browse-filters-sidebar option-container">
            <div className="modpack-browse-filters-header">
              <span>{t("minecraft.content_manager.filters", "Filters")}</span>
              <button className="client-log-close" onClick={() => setFiltersOpen(false)} title={t("minecraft.launch.log_close", "Close")}>
                ×
              </button>
            </div>

            <FilterSection title={t("minecraft.content_manager.sort_by", "Sort by")}>
              <select value={sort} onChange={(e) => changeSort(e.target.value)}>
                <option value="">{t("minecraft.content_manager.sort_relevance", "Relevance")}</option>
                <option value="downloads">{t("minecraft.content_manager.sort_downloads", "Downloads")}</option>
                <option value="follows">{t("minecraft.content_manager.sort_follows", "Follows")}</option>
                <option value="newest">{t("minecraft.content_manager.sort_newest", "Newest")}</option>
                <option value="updated">{t("minecraft.content_manager.sort_updated", "Recently updated")}</option>
              </select>
            </FilterSection>

            <FilterSection title={t("minecraft.content_manager.environment", "Environment")}>
              <div className="modpack-browse-filter-categories">
                {ENVIRONMENT_VALUES.map((v) => (
                  <button
                    key={v}
                    className={`modpack-browse-filter-chip${selectedEnvironments.has(v) ? " active" : ""}`}
                    onClick={() => toggleEnvironment(v)}
                  >
                    {formatEnvironmentValue(v)}
                  </button>
                ))}
              </div>
            </FilterSection>

            <FilterSection title={t("minecraft.content_manager.categories", "Categories")}>
              {categoriesLoading && <p className="modpack-option-hint">{t("minecraft.content_manager.loading", "Loading...")}</p>}
              {!categoriesLoading && availableCategories.length === 0 && (
                <p className="modpack-option-hint">{t("minecraft.content_manager.no_filters", "No filters for this service.")}</p>
              )}
              {!categoriesLoading && availableCategories.length > 0 && (
                <div className="modpack-browse-filter-categories">
                  {availableCategories.map((c) => (
                    <button
                      key={c}
                      className={`modpack-browse-filter-chip${selectedCategories.has(c) ? " active" : ""}`}
                      onClick={() => toggleCategory(c)}
                    >
                      {c}
                    </button>
                  ))}
                </div>
              )}
            </FilterSection>

            {activeFilterCount > 0 && (
              <button
                className="modpack-browse-filters-clear"
                onClick={() => { setSelectedCategories(new Set()); setSort(""); setSelectedEnvironments(new Set()); setPage(1); }}
              >
                {t("minecraft.content_manager.clear_filters", "Clear filters")}
              </button>
            )}
          </div>
        )}
      </div>
    </Modal>
    {detailProjectId && (
      <ProjectDetailModal
        projectId={detailProjectId}
        category={category}
        gamePath={gamePath}
        name={name}
        installed={installedProjectIds.has(detailProjectId)}
        onClose={() => setDetailProjectId(null)}
        onInstalled={onInstalled}
      />
    )}
    </>
  );
}

/** What `get_modrinth_project` returns — the full project page a search result row's click
 *  opens. There's no way to actually embed Modrinth's own page (`modrinth.com` sends
 *  `X-Frame-Options: DENY`, so an `<iframe>` just refuses to load), so this is a from-scratch
 *  page built from the same underlying data instead. */
interface ProjectDetail {
  project_id: string;
  title: string;
  description: string;
  body: string;
  icon_url?: string;
  downloads: number;
  followers: number;
  categories: string[];
  environment: string[];
  license_name?: string;
  license_url?: string;
  source_url?: string;
  issues_url?: string;
  wiki_url?: string;
  discord_url?: string;
  gallery: { url: string; title?: string }[];
}

/** Renders one run of inline Markdown (bold/code/links/images amid plain text) as React nodes —
 *  never `dangerouslySetInnerHTML`, since `body` is arbitrary third-party text this webview
 *  can't trust the way it trusts this app's own UI. Raw HTML tags (Modrinth READMEs often carry
 *  a few, e.g. badge wrappers) are stripped rather than rendered, for the same reason — inert
 *  text is safe, injected markup isn't. A link's text still shows, just not as a clickable
 *  `<a>`: a real one would navigate this same webview away from the app with nothing to bring
 *  it back. */
function renderMarkdownInline(text: string, keyPrefix: string): React.ReactNode[] {
  const stripped = text.replace(/<[^>]+>/g, "");
  const pattern = /!\[([^\]]*)\]\(([^)]+)\)|\[([^\]]*)\]\(([^)]+)\)|\*\*([^*]+)\*\*|`([^`]+)`/g;
  const nodes: React.ReactNode[] = [];
  let lastIndex = 0;
  let i = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(stripped)) !== null) {
    if (match.index > lastIndex) nodes.push(stripped.slice(lastIndex, match.index));
    if (match[2] !== undefined) {
      nodes.push(<img key={`${keyPrefix}-${i++}`} className="modpack-project-inline-image" src={match[2]} alt={match[1]} />);
    } else if (match[4] !== undefined) {
      nodes.push(<span key={`${keyPrefix}-${i++}`} className="modpack-project-link-text">{match[3]}</span>);
    } else if (match[5] !== undefined) {
      nodes.push(<strong key={`${keyPrefix}-${i++}`}>{match[5]}</strong>);
    } else if (match[6] !== undefined) {
      nodes.push(<code key={`${keyPrefix}-${i++}`}>{match[6]}</code>);
    }
    lastIndex = pattern.lastIndex;
  }
  if (lastIndex < stripped.length) nodes.push(stripped.slice(lastIndex));
  return nodes;
}

/** A small, safe, from-scratch Markdown-ish renderer for `ProjectDetail.body` — covers headers,
 *  paragraphs, `-`/`*` lists, fenced code blocks, image lines, and `---` rules, which is enough
 *  for the common shape of a Modrinth project description without pulling in a full CommonMark
 *  dependency (and without ever trusting raw HTML — see `renderMarkdownInline`). */
function renderMarkdownBody(body: string): React.ReactNode[] {
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  const blocks: React.ReactNode[] = [];
  let listBuffer: string[] = [];
  let paraBuffer: string[] = [];
  let codeBuffer: string[] = [];
  let inCodeFence = false;
  let key = 0;

  const flushList = () => {
    if (listBuffer.length === 0) return;
    const items = listBuffer;
    listBuffer = [];
    blocks.push(
      <ul key={`ul-${key++}`} className="modpack-project-list">
        {items.map((item, i) => <li key={i}>{renderMarkdownInline(item, `li-${key}-${i}`)}</li>)}
      </ul>
    );
  };
  const flushPara = () => {
    if (paraBuffer.length === 0) return;
    const text = paraBuffer.join(" ");
    paraBuffer = [];
    blocks.push(<p key={`p-${key++}`}>{renderMarkdownInline(text, `p-${key}`)}</p>);
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (line.startsWith("```")) {
      if (inCodeFence) {
        blocks.push(<pre key={`code-${key++}`} className="modpack-project-code">{codeBuffer.join("\n")}</pre>);
        codeBuffer = [];
        inCodeFence = false;
      } else {
        flushPara();
        flushList();
        inCodeFence = true;
      }
      continue;
    }
    if (inCodeFence) {
      codeBuffer.push(rawLine);
      continue;
    }

    if (line === "") {
      flushPara();
      flushList();
      continue;
    }

    const headerMatch = /^(#{1,6})\s+(.*)$/.exec(line);
    if (headerMatch) {
      flushPara();
      flushList();
      const level = Math.min(headerMatch[1].length + 2, 6);
      const Tag = `h${level}` as "h3" | "h4" | "h5" | "h6";
      blocks.push(<Tag key={`h-${key++}`} className="modpack-project-heading">{renderMarkdownInline(headerMatch[2], `h-${key}`)}</Tag>);
      continue;
    }

    const imageOnlyMatch = /^!\[([^\]]*)\]\(([^)]+)\)$/.exec(line);
    if (imageOnlyMatch) {
      flushPara();
      flushList();
      blocks.push(<img key={`img-${key++}`} className="modpack-project-image" src={imageOnlyMatch[2]} alt={imageOnlyMatch[1]} />);
      continue;
    }

    if (line.startsWith("- ") || line.startsWith("* ")) {
      flushPara();
      listBuffer.push(line.slice(2));
      continue;
    }

    if (/^-{3,}$/.test(line) || /^\*{3,}$/.test(line)) {
      flushPara();
      flushList();
      blocks.push(<hr key={`hr-${key++}`} />);
      continue;
    }

    flushList();
    paraBuffer.push(line);
  }
  flushPara();
  flushList();
  if (inCodeFence && codeBuffer.length > 0) {
    blocks.push(<pre key={`code-${key++}`} className="modpack-project-code">{codeBuffer.join("\n")}</pre>);
  }
  return blocks;
}

/** The "open a mod" detail page a Browse content row's click opens — see `ProjectDetail`'s doc
 *  comment for why this isn't a literal embedded browser. */
/** `mods` -> `mod`, etc. — the segment Modrinth's own project URLs use, matching the Rust
 *  side's `project_type_for_category`. */
function modrinthProjectTypeSegment(category: ContentCategory): string {
  switch (category) {
    case "resourcepacks":
      return "resourcepack";
    case "shaderpacks":
      return "shader";
    case "datapacks":
      return "datapack";
    default:
      return "mod";
  }
}

function ExternalLinkIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M9 6H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-3" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M14 4h6v6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M20 4 10 14" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ProjectDetailModal({
  projectId, category, gamePath, name, installed, onClose, onInstalled,
}: {
  projectId: string;
  category: ContentCategory;
  gamePath: string | undefined;
  name: string;
  installed: boolean;
  onClose: () => void;
  onInstalled: () => void;
}) {
  const call_module = useCallModule();
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);

  useEffect(() => {
    setLoading(true);
    setError(null);
    call_module("get_modrinth_project", { project_id: projectId })
      .then((res: any) => setDetail(res))
      .catch((e: any) => setError(String(e)))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  async function handleInstall() {
    if (!gamePath || !detail) return;
    setInstalling(true);
    setError(null);
    try {
      await call_module("install_modrinth_content", { path: gamePath, name, category, project_id: projectId, title: detail.title });
      const jobError = await waitForBackgroundJob(call_module, `${detail.title} (Modrinth)`);
      if (jobError) throw new Error(jobError);
      onInstalled();
    } catch (e) {
      setError(String(e));
    } finally {
      setInstalling(false);
    }
  }

  function handleOpenInBrowser() {
    openExternalUrl(`https://modrinth.com/${modrinthProjectTypeSegment(category)}/${projectId}`).catch(console.error);
  }

  return (
    <Modal isOpen onClose={onClose} title={detail?.title ?? t("minecraft.content_manager.loading", "Loading...")} size="large">
      <div className="option-container modpack-project-detail">
        {loading && <p className="modpack-option-hint">{t("minecraft.content_manager.loading", "Loading...")}</p>}
        {error && <p className="modpack-error">{error}</p>}
        {!loading && detail && (
          <>
            <div className="modpack-project-header">
              {detail.icon_url ? (
                <img className="modpack-browse-icon" src={detail.icon_url} alt="" />
              ) : (
                <span className="modpack-browse-icon modpack-file-icon"><FileIcon /></span>
              )}
              <div className="modpack-project-header-text">
                <span className="modpack-browse-title">{detail.title}</span>
                <span className="modpack-browse-description">{detail.description}</span>
                <BrowseTags environment={detail.environment} categories={detail.categories} />
              </div>
              <div className="modpack-browse-actions">
                <button
                  className={`modpack-browse-install${installed ? " installed" : ""}`}
                  onClick={handleInstall}
                  disabled={installed || installing}
                >
                  {installed
                    ? t("minecraft.content_manager.installed", "Installed")
                    : installing
                      ? t("minecraft.content_manager.installing", "Installing...")
                      : t("minecraft.content_manager.install", "Install")}
                </button>
                <span className="modpack-browse-downloads">
                  <DownloadIcon /> {formatCount(detail.downloads)}
                </span>
                <button className="modpack-project-open-browser" onClick={handleOpenInBrowser}>
                  <ExternalLinkIcon /> {t("minecraft.content_manager.open_in_browser", "Open in browser")}
                </button>
              </div>
            </div>

            {detail.gallery.length > 0 && (
              <div className="modpack-project-gallery">
                {detail.gallery.map((g, i) => (
                  <img key={i} className="modpack-project-gallery-image" src={g.url} alt={g.title ?? ""} />
                ))}
              </div>
            )}

            <div className="modpack-project-body">
              {renderMarkdownBody(detail.body)}
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

type SettingsCategory = "general" | "install";

/** Thin divider between an editable-fields block and an actions block within a category. */
function SettingsDivider() {
  return <hr style={{ border: "none", borderTop: "1px solid var(--hr-color)", opacity: 0.25, margin: "16px 0" }} />;
}

function ModpackSettingsModal(
  {
    open, onClose, name, profile, iconData, bannerData, generalRam,
    onProfileChange, onIconChange, onBannerChange, onDeleted, onDuplicated,
  }: {
    open: boolean;
    onClose: () => void;
    name: string;
    profile: ModpackProfile;
    iconData: string | null;
    bannerData: string | null;
    generalRam: number | undefined;
    onProfileChange: (profile: ModpackProfile) => void;
    onIconChange: (iconData: string | null) => void;
    onBannerChange: (bannerData: string | null) => void;
    onDeleted: () => void;
    onDuplicated: (newName: string) => void;
  }
) {
  const call_module = useCallModule();
  const gamePath = useGamePath();
  const [category, setCategory] = useState<SettingsCategory>("general");

  // General — editable fields
  const [displayName, setDisplayName] = useState(profile.display_name);
  const [pickingIcon, setPickingIcon] = useState(false);
  const [pickingBanner, setPickingBanner] = useState(false);

  // General — actions
  const [repairing, setRepairing] = useState(false);
  const [repairMessage, setRepairMessage] = useState<string | null>(null);
  const [duplicateName, setDuplicateName] = useState(`${name}-copy`);
  const [duplicating, setDuplicating] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Install
  const [useCustomRam, setUseCustomRam] = useState(profile.use_custom_ram);
  const [maxRam, setMaxRam] = useState(profile.max_ram);
  const [minRam, setMinRam] = useState(profile.min_ram);
  const [javaPath, setJavaPath] = useState(profile.java_path ?? "");
  const [jvmArgs, setJvmArgs] = useState(profile.jvm_arguments);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setCategory("general");
    setDisplayName(profile.display_name);
    setDuplicateName(`${name}-copy`);
    setUseCustomRam(profile.use_custom_ram);
    setMaxRam(profile.max_ram);
    setMinRam(profile.min_ram);
    setJavaPath(profile.java_path ?? "");
    setJvmArgs(profile.jvm_arguments);
    setRepairMessage(null);
    setConfirmDelete(false);
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // One combined save for every editable field across both categories — all their state
  // stays mounted regardless of which category tab is active, so this is safe to call
  // no matter which one the user was last looking at.
  async function handleSaveAll() {
    if (!gamePath) return;
    setSaving(true);
    setError(null);
    try {
      const trimmedName = displayName.trim();
      if (trimmedName && trimmedName !== profile.display_name) {
        await call_module("rename_modpack", { path: gamePath, name, display_name: trimmedName });
      }
      await call_module("update_modpack_settings", {
        path: gamePath,
        name,
        max_ram: maxRam,
        min_ram: minRam,
        use_custom_ram: useCustomRam,
        java_path: javaPath.trim() ? javaPath.trim() : null,
        jvm_arguments: jvmArgs,
      });
      onProfileChange({
        ...profile,
        display_name: trimmedName || profile.display_name,
        max_ram: maxRam,
        min_ram: minRam,
        use_custom_ram: useCustomRam,
        java_path: javaPath.trim() ? javaPath.trim() : null,
        jvm_arguments: jvmArgs,
      });
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  async function handlePickIcon() {
    if (!gamePath) return;
    setError(null);
    try {
      const picked = await openFileDialog({
        multiple: false,
        filters: [{ name: "Image", extensions: ["png", "jpg", "jpeg", "webp", "gif"] }],
      });
      if (!picked || Array.isArray(picked)) return;
      setPickingIcon(true);
      const res: any = await call_module("set_modpack_icon", { path: gamePath, name, icon_source_path: picked });
      onIconChange(res?.icon_data ?? null);
    } catch (e) {
      setError(String(e));
    } finally {
      setPickingIcon(false);
    }
  }

  async function handlePickBanner() {
    if (!gamePath) return;
    setError(null);
    try {
      const picked = await openFileDialog({
        multiple: false,
        filters: [{ name: "Image", extensions: ["png", "jpg", "jpeg", "webp", "gif"] }],
      });
      if (!picked || Array.isArray(picked)) return;
      setPickingBanner(true);
      const res: any = await call_module("set_modpack_banner", { path: gamePath, name, banner_source_path: picked });
      onBannerChange(res?.banner_data ?? null);
    } catch (e) {
      setError(String(e));
    } finally {
      setPickingBanner(false);
    }
  }

  async function handleRepair() {
    if (!gamePath) return;
    setRepairing(true);
    setRepairMessage(null);
    setError(null);
    try {
      await call_module("create_modpack", {
        path: gamePath,
        name,
        core: profile.core.toLowerCase(),
        version: profile.version_id,
        loader: profile.loader_version,
      });
      setRepairMessage(t("minecraft.modpack_settings.repair_started", "Re-verifying files — watch the progress bar at the bottom."));
    } catch (e) {
      setError(String(e));
    } finally {
      setRepairing(false);
    }
  }

  async function handleDuplicate() {
    if (!gamePath || !duplicateName.trim()) return;
    setDuplicating(true);
    setError(null);
    try {
      await call_module("duplicate_modpack", { path: gamePath, name, new_name: duplicateName.trim() });
      onDuplicated(duplicateName.trim());
    } catch (e) {
      setError(String(e));
    } finally {
      setDuplicating(false);
    }
  }

  async function handleDelete() {
    if (!gamePath) return;
    setDeleting(true);
    setError(null);
    try {
      await call_module("delete_modpack", { path: gamePath, name });
      onDeleted();
    } catch (e) {
      setError(String(e));
      setDeleting(false);
    }
  }

  // minRam (-Xms) has no slider of its own anymore — just kept in sync with maxRam so it's
  // never left above it (it's still sent to update_modpack_settings/persisted, just no longer
  // player-editable).
  function handleMaxRamChange(v: number) {
    setMaxRam(v);
    if (v < minRam) setMinRam(v);
  }

  return (
    <>
      <Modal
        isOpen={open && !confirmDelete}
        onClose={onClose}
        title={t("minecraft.modpack_settings.title", "Modpack settings")}
        size="large"
        layout="categories"
        categories={[
          { id: "general", label: t("minecraft.modpack_settings.general", "General") },
          { id: "install", label: t("minecraft.modpack_settings.install", "Install") },
        ]}
        activeCategory={category}
        onCategoryChange={(id: string | number) => setCategory(id as SettingsCategory)}
        footer={
          <>
            <button onClick={onClose} disabled={saving}>
              {t("minecraft.modpack_settings.close", "Close")}
            </button>
            <button style={{ backgroundColor: "var(--main-color)" }} onClick={handleSaveAll} disabled={saving}>
              {saving ? t("minecraft.modpack_settings.saving", "Saving...") : t("minecraft.modpack_settings.save", "Save")}
            </button>
          </>
        }
      >
        {category === "general" && (
          <div className="option-container">
            <div className="option">
              <div className="modpack-images-row">
                <div>
                  <label>{t("minecraft.modpack_settings.icon_label", "Icon")}</label>
                  <div
                    className="modpack-icon-preview modpack-image-picker"
                    onClick={pickingIcon ? undefined : handlePickIcon}
                    role="button"
                    title={t("minecraft.modpack_settings.icon_change", "Change icon")}
                  >
                    {iconData && <img src={iconData} alt="" />}
                    <div className="modpack-image-picker-overlay">
                      {pickingIcon
                        ? t("minecraft.modpack_settings.icon_uploading", "Uploading...")
                        : t("minecraft.modpack_settings.icon_change", "Change icon")}
                    </div>
                  </div>
                </div>

                <div>
                  <label>{t("minecraft.modpack_settings.banner_label", "Banner")}</label>
                  <div
                    className="modpack-banner-preview modpack-image-picker"
                    onClick={pickingBanner ? undefined : handlePickBanner}
                    role="button"
                    title={t("minecraft.modpack_settings.banner_change", "Change banner")}
                  >
                    {bannerData && <img src={bannerData} alt="" />}
                    <div className="modpack-image-picker-overlay">
                      {pickingBanner
                        ? t("minecraft.modpack_settings.banner_uploading", "Uploading...")
                        : t("minecraft.modpack_settings.banner_change", "Change banner")}
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <div className="option">
              <label>{t("minecraft.modpack_settings.name_label", "Name")}</label>
              <input type="text" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
            </div>

            <SettingsDivider />

            <div className="option">
              <label>{t("minecraft.modpack_settings.repair_label", "Repair")}</label>
              <p className="modpack-option-hint">
                {t("minecraft.modpack_settings.repair_hint", "Re-checks and re-downloads any missing or broken files.")}
              </p>
              <button onClick={handleRepair} disabled={repairing}>
                {repairing
                  ? t("minecraft.modpack_settings.repairing", "Starting...")
                  : t("minecraft.modpack_settings.repair", "Repair / re-verify files")}
              </button>
              {repairMessage && <p className="modpack-option-hint">{repairMessage}</p>}
            </div>

            <div className="option">
              <label>{t("minecraft.modpack_settings.duplicate_label", "Duplicate")}</label>
              <input type="text" value={duplicateName} onChange={(e) => setDuplicateName(e.target.value)} />
              <button onClick={handleDuplicate} disabled={duplicating || !duplicateName.trim()}>
                {duplicating ? t("minecraft.modpack_settings.duplicating", "Duplicating...") : t("minecraft.modpack_settings.duplicate", "Duplicate")}
              </button>
            </div>

            <div className="option">
              <label>{t("minecraft.modpack_settings.delete_label", "Delete instance")}</label>
              <p className="modpack-option-hint">
                {t("minecraft.modpack_settings.delete_hint", "Permanently removes its saves, mods and settings.")}
              </p>
              <button className="modpack-danger-btn" onClick={() => setConfirmDelete(true)} disabled={deleting}>
                {t("minecraft.modpack_settings.delete", "Delete instance")}
              </button>
            </div>
          </div>
        )}

        {category === "install" && (
          <div className="option-container">
            <div className="option">
              <label>{t("minecraft.modpack_settings.java_path_label", "Java path")}</label>
              <BrowseField
                value={javaPath}
                onChange={setJavaPath}
                placeholder={t("minecraft.modpack_settings.java_path_placeholder", "Auto-managed")}
                mode="file"
              />
            </div>

            <div className="option">
              <label>{t("minecraft.modpack_settings.jvm_args_label", "JVM arguments")}</label>
              <input type="text" value={jvmArgs} onChange={(e) => setJvmArgs(e.target.value)} />
            </div>

            <div className="option">
              <label className="modpack-checkbox-label">
                <input
                  type="checkbox"
                  checked={useCustomRam}
                  onChange={(e) => setUseCustomRam(e.target.checked)}
                />
                {t("minecraft.modpack_settings.use_custom_ram", "Use custom RAM for this modpack")}
              </label>
              {!useCustomRam && (
                <p className="modpack-option-hint">
                  {generalRam !== undefined
                    ? t("minecraft.modpack_settings.use_general_ram_hint", `Will use the general RAM allocation at launch: ${generalRam} MB.`)
                    : t("minecraft.modpack_settings.use_general_ram_hint_unknown", "Will use the general RAM allocation from Game settings at launch.")}
                </p>
              )}
            </div>

            <div className="option">
              <label>{t("minecraft.modpack_settings.max_ram_label", "Maximum memory")}</label>
              <SliderField value={maxRam} min={512} max={16384} step={512} unit="MB" disabled={!useCustomRam} onChange={handleMaxRamChange} />
            </div>
          </div>
        )}

        {error && <p className="modpack-error">{error}</p>}
      </Modal>

      <ConfirmModal
        isOpen={open && confirmDelete}
        onCancel={() => setConfirmDelete(false)}
        onConfirm={handleDelete}
        message={t("minecraft.modpack_settings.delete_confirm", `Delete "${profile.display_name}"? This removes all its saves and mods permanently.`)}
        confirmText={t("minecraft.modpack_settings.delete", "Delete instance")}
        variant="danger"
      />
    </>
  );
}

function CreateModpackModal(
  { open, onClose, onCreated }: { open: boolean, onClose: () => void, onCreated: () => void }
) {
  const call_module = useCallModule();
  const gamePath = useGamePath();

  const [menu, setMenu] = useState<"variants" | "custom" | "install">("variants");
  const [name, setName] = useState("");
  const [loader, setLoader] = useState("vanilla");
  const [versions, setVersions] = useState<string[]>([]);
  const [version, setVersion] = useState("");
  const [loadingVersions, setLoadingVersions] = useState(false);
  const [loaderVersions, setLoaderVersions] = useState<string[]>([]);
  const [loaderVersion, setLoaderVersion] = useState("");
  const [loadingLoaderVersions, setLoadingLoaderVersions] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // "Install modpack" — importing a .nihaopack/.mrpack file (the reverse of Share's export).
  const [importSourcePath, setImportSourcePath] = useState<string | null>(null);
  const [importPreview, setImportPreview] = useState<ImportPreview | null>(null);
  const [importName, setImportName] = useState("");
  const [peeking, setPeeking] = useState(false);
  const [installing, setInstalling] = useState(false);

  useEffect(() => {
    if (menu !== "custom") return;
    setLoadingVersions(true);
    call_module("get_versions", { core: loader })
      .then((res: any) => {
        const list: string[] = Array.isArray(res) ? res : [];
        setVersions(list);
        setVersion(list[0] ?? "");
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoadingVersions(false));
  }, [menu, loader]);

  // Loader (build) versions depend on the chosen game version — only relevant for loaders
  // that actually have a separate build number to pick (Fabric, NeoForge); vanilla doesn't.
  useEffect(() => {
    if (menu !== "custom" || !LOADERS_WITH_BUILD_VERSION.includes(loader) || !version) {
      setLoaderVersions([]);
      setLoaderVersion("");
      return;
    }
    setLoadingLoaderVersions(true);
    call_module("get_loader_versions", { core: loader, version })
      .then((res: any) => {
        const list: string[] = Array.isArray(res) ? res : [];
        setLoaderVersions(list);
        setLoaderVersion(list[0] ?? "");
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoadingLoaderVersions(false));
  }, [menu, loader, version]);

  const closeFun = () => {
    setMenu("variants"); setName(""); setError(null);
    setImportSourcePath(null); setImportPreview(null); setImportName("");
    onClose();
  };

  async function handlePickImportFile() {
    const picked = await openFileDialog({
      multiple: false,
      filters: [{ name: "Modpack", extensions: ["nihaopack", "mrpack"] }],
    });
    if (!picked || Array.isArray(picked)) return;
    setError(null);
    setImportPreview(null);
    setPeeking(true);
    setMenu("install");
    try {
      const preview: any = await call_module("peek_modpack_file", { source_path: picked });
      setImportSourcePath(picked);
      setImportPreview(preview);
      setImportName(preview?.name ?? "");
    } catch (e) {
      setError(String(e));
      setMenu("variants");
    } finally {
      setPeeking(false);
    }
  }

  async function handleImport() {
    if (!gamePath || !importSourcePath || !importName.trim()) return;
    setInstalling(true);
    setError(null);
    try {
      await call_module("import_modpack", { path: gamePath, name: importName.trim(), source_path: importSourcePath });
      onCreated();
      closeFun();
    } catch (e) {
      setError(String(e));
    } finally {
      setInstalling(false);
    }
  }

  async function handleCreate() {
    if (!gamePath || !name.trim() || !version) return;
    setCreating(true);
    setError(null);
    try {
      await call_module("create_modpack", {
        path: gamePath,
        name: name.trim(),
        core: loader,
        version,
        loader: LOADERS_WITH_BUILD_VERSION.includes(loader) ? (loaderVersion || null) : null,
      });
      onCreated();
      closeFun();
    } catch (e) {
      setError(String(e));
    } finally {
      setCreating(false);
    }
  }

  return (
    <>
      <Modal
        isOpen={open && menu === "variants"}
        onClose={closeFun}
        title={t("minecraft.create_modpack.title", "Create Modpack")}
        size="small"
      >
        <div className="variant instance" onClick={() => setMenu("custom")}>
          <img src={CUSTOM_INSTANCE} />
          <div>
            <h2>Custom setup</h2>
            <p>Start from scratch by picking a loader and game version.</p>
          </div>

        </div>
        <div className="variant instance" onClick={handlePickImportFile}>
          <img src={PACKAGE} />
          <div>
            <h2>{t("minecraft.create_modpack.install_variant", "Install modpack")}</h2>
            <p>{t("minecraft.create_modpack.install_variant_hint", "Load a modpack file — our own format or Modrinth's .mrpack.")}</p>
          </div>
        </div>
      </Modal>

      <Modal
        isOpen={open && menu === "custom"}
        onClose={closeFun}
        title={t("minecraft.create_modpack.title", "Create Modpack")}
        size="medium"
        footer={
          <>
            <button onClick={() => setMenu("variants")} disabled={creating}>Back</button>
            <button
              style={{ backgroundColor: "var(--main-color)" }}
              onClick={handleCreate}
              disabled={creating || !name.trim() || !version}
            >
              {creating ? t("minecraft.create_modpack.creating", "Creating...") : t("minecraft.create_modpack.create", "Create instance")}
            </button>
          </>
        }
      >
        <div className="option-container">
          <div className="option">
            <label>Name</label>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="option">
            <label>Loader</label>
            <div style={{ display: "flex", flexDirection: "row" }}>
              {LOADERS.map((item) => (
                <button
                  key={item.value}
                  onClick={() => setLoader(item.value)}
                  style={{ backgroundColor: item.value === loader ? "var(--main-color)" : "" }}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>
          <div className="option">
            <label>Game version</label>
            <select value={version} onChange={(e) => setVersion(e.target.value)} disabled={loadingVersions}>
              {loadingVersions && <option>Loading...</option>}
              {!loadingVersions && versions.map((v) => <option key={v} value={v}>{v}</option>)}
            </select>
          </div>
          {LOADERS_WITH_BUILD_VERSION.includes(loader) && (
            <div className="option">
              <label>Loader version</label>
              <select
                value={loaderVersion}
                onChange={(e) => setLoaderVersion(e.target.value)}
                disabled={loadingLoaderVersions || loaderVersions.length === 0}
              >
                {loadingLoaderVersions && <option>Loading...</option>}
                {!loadingLoaderVersions && loaderVersions.length === 0 && <option>No loader versions found</option>}
                {!loadingLoaderVersions && loaderVersions.map((v) => <option key={v} value={v}>{v}</option>)}
              </select>
            </div>
          )}
        </div>
        {error && <p style={{ color: "#ff6b6b", fontSize: "0.85rem" }}>{error}</p>}
      </Modal>

      <Modal
        isOpen={open && menu === "install"}
        onClose={closeFun}
        title={t("minecraft.create_modpack.title", "Create Modpack")}
        size="medium"
        footer={
          <>
            <button onClick={() => setMenu("variants")} disabled={installing}>Back</button>
            <button
              style={{ backgroundColor: "var(--main-color)" }}
              onClick={handleImport}
              disabled={installing || peeking || !importPreview || !importName.trim()}
            >
              {installing
                ? t("minecraft.create_modpack.installing", "Installing...")
                : t("minecraft.create_modpack.install", "Install modpack")}
            </button>
          </>
        }
      >
        <div className="option-container">
          {peeking && (
            <p className="modpack-option-hint">
              {t("minecraft.create_modpack.reading_file", "Reading modpack file...")}
            </p>
          )}
          {importPreview && (
            <>
              <div className="option">
                <label>{t("minecraft.modpack_settings.name_label", "Name")}</label>
                <input type="text" value={importName} onChange={(e) => setImportName(e.target.value)} />
              </div>
              <div className="option">
                <label>{t("minecraft.create_modpack.format_label", "Format")}</label>
                <p className="modpack-option-hint">
                  {importPreview.format === "own"
                    ? t("minecraft.share.own_format", "Our format (.nihaopack)")
                    : t("minecraft.share.mrpack_format", "Modrinth (.mrpack)")}
                </p>
              </div>
              <div className="option">
                <label>{t("minecraft.create_modpack.detected_label", "Detected")}</label>
                <p className="modpack-option-hint">
                  {importPreview.minecraft_version} · {importPreview.loader}
                  {importPreview.loader_version ? ` ${importPreview.loader_version}` : ""}
                </p>
              </div>
            </>
          )}
        </div>
        {error && <p style={{ color: "#ff6b6b", fontSize: "0.85rem" }}>{error}</p>}
      </Modal>
    </>
  );
}
