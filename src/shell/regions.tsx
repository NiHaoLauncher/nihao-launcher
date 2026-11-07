import { useEffect, useLayoutEffect, useRef } from "react";
import { useMatch, useNavigate } from "react-router-dom";
import { appWindow } from "@tauri-apps/api/window";
import { t } from "@shared";
import type { QuickPanelItem } from "@shared";
import "../layout/MainLayout.css";
import GameLibraryIcon from "../assets/libraryGames.png";
import InstallIndicator from "../components/InstallIndicator";
import { computeEtapPercent, computeOverallPercent, useInstallStatus } from "../hooks/useInstallStatus";
import { useAuth } from "../context/AuthContext";
import { useClient } from "../context/ClientContext";
import { useLoginModal } from "../hooks/useLoginModal";
import { useGames } from "../state/Games";
import { useOnlineFriendCount, useOwnStatus, useSocial, useSocialSync } from "../state/Social";
import { useGameQuickItems } from "../state/QuickPanel";

/**
 * Working parts of the main window; each is a ready element that brings its own data. Handed to
 * the `Shell` slot as `ShellRegions`.
 */

const NO_MODULES: string[] = [];

/** Makes sure the module list, and each module's config (name/icon/banner), is loaded. */
function useModules() {
  const modules = useGames((s) => s.modules) ?? NO_MODULES;
  const devModule = useGames((s) => s.devModule);
  const games = useGames((s) => s.games);
  useEffect(() => {
    useGames.getState().loadModules();
  }, []);
  useEffect(() => {
    modules.forEach((mod) => useGames.getState().loadConfig(mod).catch(console.error));
  }, [modules]);
  return { modules, devModule, configOf: (mod: string) => games[mod]?.config };
}

/**
 * One button of a game's quick panel. An inline `<svg>` icon's `viewBox` is cropped to what is
 * drawn (`getBBox`) so any icon fills the button.
 */
function QuickPanelButton({ item }: { item: QuickPanelItem }) {
  const ref = useRef<HTMLButtonElement>(null);

  useLayoutEffect(() => {
    const svg = ref.current?.querySelector("svg");
    if (!svg) return;
    try {
      const box = svg.getBBox();
      if (box.width > 0 && box.height > 0) {
        svg.setAttribute("viewBox", `${box.x} ${box.y} ${box.width} ${box.height}`);
        svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
      }
    } catch {
    }
  }, [item.icon]);

  return (
    <button
      ref={ref}
      type="button"
      className={`quick-item${item.active ? " active" : ""}`}
      title={item.label}
      aria-label={item.label}
      disabled={item.disabled}
      onClick={item.onClick}
    >
      {typeof item.icon === "string"
        ? <img src={item.icon} alt="" />
        : item.icon ?? item.label.substring(0, 2).toUpperCase()}
    </button>
  );
}

/** The quick panel: game tiles, library, profile, plus the open game's own buttons. */
export function QuickPanelsRegion() {
  const navigate = useNavigate();
  const { modules, devModule, configOf } = useModules();
  const openGameId = useMatch("/gm/:gameId/*")?.params.gameId;
  const onLibrary = useMatch("/library") !== null;
  const gameQuickItems = useGameQuickItems(openGameId);

  return (
    <div className="quick-panels">
      <div className="quick-panel">
        {modules.map(mod => {
          const cfg = configOf(mod);
          const badge = cfg?.icon ?? cfg?.banner;
          return (
            <div
              className={`hyperlink${mod === openGameId ? " active" : ""}`}
              key={mod}
              onClick={() => navigate(`/gm/${mod}`)}
              style={{
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                borderRadius: "8px",
                overflow: "hidden",
                backgroundColor: mod === devModule ? "rgba(0, 255, 0, 0.2)" : "rgba(255,255,255,0.1)",
                fontSize: "12px",
                fontWeight: "bold",
                color: "white",
                position: "relative",
                border: mod === devModule ? "1px solid #00ff00" : "none",
                boxShadow: mod === devModule ? "0 0 10px rgba(0, 255, 0, 0.3)" : "none"
              }}
              title={(cfg?.name ?? mod) + (mod === devModule ? " (Development Mode)" : "")}
            >
              {badge ? (
                <img src={badge} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
              ) : (
                mod.substring(0, 2).toUpperCase()
              )}
              {mod === devModule && (
                <div style={{
                  position: "absolute",
                  top: "-5px",
                  right: "-5px",
                  backgroundColor: "#00ff00",
                  color: "black",
                  fontSize: "8px",
                  padding: "1px 3px",
                  borderRadius: "4px",
                  fontWeight: "900"
                }}>
                  DEV
                </div>
              )}
            </div>
          );
        })}
        <img
          className={`hyperlink${onLibrary ? " active" : ""}`}
          src={GameLibraryIcon}
          onClick={() => navigate("/library")}
          style={{cursor: "pointer"}}
          title={t("title_library", "Your library")}
        />
      </div>
      {gameQuickItems.length > 0 && (
        <div className="quick-panel game-quick-panel">
          {gameQuickItems.map((item) => <QuickPanelButton key={item.id} item={item} />)}
        </div>
      )}
    </div>
  );
}

/**
 * Left end of the top bar when there is no session, only for a client that was linked once: a
 * Sign in button once the server answers but wants authorisation. (Connection state is the status
 * button's job.)
 */
export function AccountStateRegion() {
  const { status } = useAuth();
  const { localClient } = useClient();
  const openLoginModal = useLoginModal();
  if (!localClient?.linked) return null;

  if (status === "anonymous") {
    return (
      <button type="button" className="account-signin" onClick={() => openLoginModal()}>
        {t("button_login", "Sign in")}
      </button>
    );
  }
  return null;
}

export function SocialToggleRegion() {
  const { status } = useAuth();
  const signedIn = status === "authenticated";
  const open = useSocial((s) => s.open);
  const online = useOnlineFriendCount();
  // Keeps friends data fresh while the panel is closed (the badge needs it).
  useSocialSync(signedIn);
  if (!signedIn) return null;
  const label = online > 0 ? `Social — ${online} online` : "Social";
  return (
    <button
      type="button"
      className={`social-toggle${open ? " active" : ""}`}
      onClick={() => useSocial.getState().toggle()}
      title={label}
      aria-label={label}
      aria-pressed={open}
    >
      <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true">
        <path d="M16 11a3 3 0 1 0-3-3 3 3 0 0 0 3 3zm-8 0a3 3 0 1 0-3-3 3 3 0 0 0 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5C15 14.17 10.33 13 8 13zm8 0c-.29 0-.62.02-.97.05A4.2 4.2 0 0 1 17 16.5V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z" />
      </svg>
      {online > 0 && <span className="social-toggle-badge">{online > 99 ? "99+" : online}</span>}
    </button>
  );
}

/**
 * The signed-in player's avatar in the top bar, shown only while the friends panel is closed.
 * Click: profile.
 */
export function PlayerAvatarRegion() {
  const navigate = useNavigate();
  const { status, user } = useAuth();
  const own = useOwnStatus();
  if (status !== "authenticated" || !user) return null;
  const label = own === "playing" ? "Playing" : own === "online" ? "Online" : "Offline";
  return (
    <button
      type="button"
      className={`player-avatar social-status-${own}`}
      onClick={() => navigate("/profile")}
      title={`${user.displayname} — ${label}`}
      aria-label={`${user.displayname} — ${label}`}
    >
      {user.avatar
        ? <img src={user.avatar} alt="" />
        : <span>{user.displayname.trim().slice(0, 2).toUpperCase() || "?"}</span>}
    </button>
  );
}


/**
 * Install progress line: one install as a full bar, others as mini spinners (see
 * InstallIndicator). Empty when idle.
 */
export function ProgressRegion() {
  const { modules, configOf } = useModules();
  const installs = useInstallStatus(modules);
  const activeInstall = installs[0] ?? null;
  const otherInstalls = installs.slice(1);

  return (
    <div className={`progress${activeInstall ? " visible" : ""}`}>
      {activeInstall && (
        <div className="progress-content">
          <div className="progress-header" style={otherInstalls.length > 0 ? {paddingRight: `${otherInstalls.length * 20 + 12}px`} : undefined}>
            <span className="progress-name">{activeInstall.progress.name}</span>
            {(() => {
              const cfg = configOf(activeInstall.module);
              const badge = cfg?.icon ?? cfg?.banner;
              return badge ? (
                <img className="progress-game" src={badge} title={cfg?.name ?? activeInstall.module} alt="" />
              ) : (
                <span className="progress-game progress-game-fallback" title={cfg?.name ?? activeInstall.module}>
                  {activeInstall.module.substring(0, 2).toUpperCase()}
                </span>
              );
            })()}
            <span className="progress-stage">
              {activeInstall.progress.etap} ({activeInstall.progress.current_etaps}/{activeInstall.progress.total_etaps}) · {activeInstall.progress.status}
              {activeInstall.progress.filename ? ` — ${activeInstall.progress.filename}` : ""}
            </span>
          </div>
          <div className="line" style={{width: `${computeOverallPercent(activeInstall.progress)}%`}}/>
          <div className="details-line" style={{width: `${computeEtapPercent(activeInstall.progress)}%`}}/>
          <InstallIndicator installs={otherInstalls} />
        </div>
      )}
    </div>
  );
}

/**
 * Invisible 25px click-through strip along the top edge; a press that moves a few pixels becomes a
 * window drag.
 */
export function DragRegion() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const r = ref.current?.getBoundingClientRect();
      if (e.button !== 0 || !r || e.clientY < r.top || e.clientY > r.bottom || e.clientX < r.left || e.clientX > r.right) return;
      const { clientX: x0, clientY: y0 } = e;
      const stop = () => { removeEventListener("mousemove", onMove); removeEventListener("mouseup", stop); };
      const onMove = (m: MouseEvent) => {
        if (Math.hypot(m.clientX - x0, m.clientY - y0) < 4) return;
        stop();
        appWindow.startDragging();
      };
      addEventListener("mousemove", onMove);
      addEventListener("mouseup", stop);
    };
    addEventListener("mousedown", onDown, true);
    return () => removeEventListener("mousedown", onDown, true);
  }, []);
  return <div ref={ref} style={{position:"absolute",top:"0",left:"0",zIndex:"999", width:"100%", height:"25px", pointerE