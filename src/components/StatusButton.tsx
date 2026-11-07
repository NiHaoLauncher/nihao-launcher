import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { invoke } from "@tauri-apps/api/tauri";
import { ConfirmModal, t } from "@shared";
import UpdateIcon from "@shared/assets/icons/update.svg?react";
import DownloadIcon from "@shared/assets/icons/download.svg?react";
import CloudIcon from "@shared/assets/icons/cloud.svg?react";
import GamepadIcon from "@shared/assets/icons/gamepad.svg?react";
import RefreshIcon from "@shared/assets/icons/refresh.svg?react";
import CheckIcon from "@shared/assets/icons/check.svg?react";
import WarningIcon from "@shared/assets/icons/warning.svg?react";
import InfoIcon from "@shared/assets/icons/info.svg?react";
import ActivityIcon from "@shared/assets/icons/activity.svg?react";
import BellIcon from "@shared/assets/icons/bell.svg?react";
import { useToast } from "../context/ToastContext";
import { useService } from "../state/Service";
import { useAuth } from "../context/AuthContext";
import { useGames } from "../state/Games";
import { useApplication } from "../state/Application";
import { useInstalls, computeOverallPercent } from "../hooks/useInstallStatus";
import { startUpdateChecks, useUpdate } from "../state/Update";
import { useStatus } from "../state/Status";
import "./StatusButton.css";

type Tone = "ok" | "warn" | "bad";

/** The server's version (from `/health`), `null` while unknown or unreachable. */
function useServerVersion(reachable: boolean) {
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    if (!reachable) {
      setVersion(null);
      return;
    }
    invoke<string | null>("server_version").then(setVersion).catch(() => setVersion(null));
  }, [reachable]);
  return version;
}

const installIcons = new Map<string, string>();

/** The icon of the instance an install job is about, from the module's optional `get_install_icon`
 *  (cached once found: a job that has just started may not have its icon on disk yet). */
async function installIcon(module: string, name: string): Promise<string | undefined> {
  const known = installIcons.get(name);
  if (known) return known;
  const icon = await invoke("call_module", { module, method: "get_install_icon", args: { name } }).catch(() => null);
  if (typeof icon !== "string") return undefined;
  installIcons.set(name, icon);
  return icon;
}

/** Icons of the running installs, by job name. */
function useInstallIcons(installs: { module: string; name: string }[]) {
  const [icons, setIcons] = useState<Record<string, string>>({});
  const key = installs.map((i) => i.name).join("\n");
  useEffect(() => {
    installs.forEach(async (i) => {
      const icon = await installIcon(i.module, i.name);
      if (icon) setIcons((prev) => (prev[i.name] === icon ? prev : { ...prev, [i.name]: icon }));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return icons;
}

/** Turns what happens in the launcher into notifications: a found update, the server coming and
 *  going, a finished install. */
function useNoticeFeed(connection: string, installs: { module: string; name: string }[]) {
  const games = useGames((s) => s.games);
  const push = useStatus((s) => s.push);
  const available = useUpdate((s) => s.available);
  const prevConnection = useRef(connection);
  const prevInstalls = useRef(installs);

  useEffect(() => {
    if (available) push("info", `${t("status.update_found", "Launcher update found")}: v${available.version}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [available?.version]);

  useEffect(() => {
    const was = prevConnection.current;
    prevConnection.current = connection;
    if (connection === "unavailable" && was !== "unavailable") push("error", t("status.server_lost", "Lost connection to the server"));
    if (connection === "authenticated" && was === "unavailable") push("ok", t("status.server_back", "Connected to the server"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection]);

  useEffect(() => {
    for (const done of prevInstalls.current) {
      if (!installs.some((i) => i.name === done.name)) {
        installIcon(done.module, done.name).then((icon) =>
          push("ok", t("status.installed", "Installed"), { title: done.name, icon: icon ?? games[done.module]?.config?.icon }),
        );
      }
    }
    prevInstalls.current = installs;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [installs.map((i) => i.name).join("\n")]);
}

const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** "just now" / "5 min ago" / "2 h ago" for a moment `at`, seen from `now`. */
function ago(at: number, now: number): string {
  const min = Math.floor((now - at) / 60000);
  if (min < 1) return t("status.just_now", "just now");
  if (min < 60) return `${min} ${t("status.min_ago", "min ago")}`;
  return `${Math.floor(min / 60)} ${t("status.h_ago", "h ago")}`;
}

/** "42 min" / "1 h 5 min" for a span in ms. */
function duration(ms: number): string {
  const min = Math.max(0, Math.floor(ms / 60000));
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${min % 60} min`;
}

/**
 * The top bar's status button: shows the most important thing (an update, a lost server, an
 * install, a running game, else the connection) and opens a panel with the details and the
 * notifications of this run.
 */
export default function StatusButton() {
  const { showToast } = useToast();
  const connection = useService((s) => s.status);
  const user = useService((s) => s.user);
  const playing = useApplication((s) => s.playing);
  const installs = useInstalls((s) => s.installs);
  const { available, progress, install, check, checkedAt } = useUpdate();
  const { retry } = useAuth();
  const games = useGames((s) => s.games);
  const installList = installs.map((i) => ({ module: i.module, name: i.progress.name }));
  const icons = useInstallIcons(installList);
  const [checking, setChecking] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [playSince, setPlaySince] = useState<number | null>(null);
  const { notices, clear } = useStatus();
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const serverVersion = useServerVersion(connection === "authenticated" || connection === "anonymous");

  useEffect(startUpdateChecks, []);
  useEffect(() => { setPlaySince(playing ? Date.now() : null); }, [playing?.game, playing?.detail]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!open) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(timer);
  }, [open]);
  useNoticeFeed(connection, installList);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  const offline = connection === "unavailable";
  const tone: Tone = offline ? "bad" : connection === "authenticated" ? "ok" : "warn";
  const installPercent = installs[0] ? computeOverallPercent(installs[0].progress) : null;
  const percent = progress ?? installPercent;

  const connectionText = {
    authenticated: `${t("status.connected", "Connected")}${user?.displayname ? ` · ${user.displayname}` : ""}`,
    anonymous: t("status.not_signed_in", "Not signed in"),
    unavailable: t("status.unreachable", "Server unreachable"),
    connecting: t("status.connecting", "Connecting…"),
    idle: t("status.not_connected", "Not connected"),
  }[connection];

  async function recheck() {
    setChecking(true);
    await check();
    setChecking(false);
  }

  const overall: { tone: Tone | "info"; text: string } =
    offline ? { tone: "bad", text: t("status.unreachable", "Server unreachable") }
    : available ? { tone: "info", text: t("status.update_available", "Update available") }
    : installs.length > 0 ? { tone: "info", text: t("status.installing", "Installing") }
    : playing ? { tone: "info", text: t("status.game_running", "Game running") }
    : connection === "authenticated" ? { tone: "ok", text: t("status.all_good", "All good") }
    : { tone: "warn", text: connectionText };

  async function handleUpdate() {
    setConfirm(false);
    try {
      await install();
    } catch (e) {
      showToast({ message: `${t("update.failed_short", "The update failed")}: ${e}`, variant: "error", duration: 10000 });
    }
  }

  // What is happening now (an install, a game) covers the standing state (an update, the connection); the dot keeps that state.
  const face = percent !== null ? "ring" : playing ? "game" : available ? "update" : offline ? "offline" : "net";
  const dot = offline ? "bad" : available ? "info" : tone;

  return (
    <div className="status-root" ref={rootRef}>
      <button
        type="button"
        className={`status-btn status-${face}${open ? " open" : ""}`}
        style={percent !== null ? ({ "--status-pct": `${percent}%` } as CSSProperties) : undefined}
        onClick={() => setOpen((o) => !o)}
        title={t("status.title", "Status")}
      >
        {face === "update" && <UpdateIcon width={20} height={20} />}
        {face === "ring" && <span className="status-pct">{percent}</span>}
        {face === "game" && <GamepadIcon width={20} height={20} />}
        {(face === "net" || face === "offline") && <CloudIcon width={20} height={20} />}
        <span className={`status-dot status-dot-${dot}`} />
      </button>

      {open && (
        <div className="status-panel">
          <div className="status-head">
            <div className="status-head-main">
              <b className="status-title"><ActivityIcon width={18} height={18} /> {t("status.title", "Status")}</b>
              <span className={`status-chip status-chip-${overall.tone}`}>{overall.text}</span>
            </div>
            {serverVersion && <small>{t("status.server_version", "Server")} v{serverVersion}</small>}
          </div>

          <div className="status-cards">
            <div className="status-item">
              <span className={`status-ic ${available ? "status-ic-acc" : "status-ic-ok"}`}><UpdateIcon width={18} height={18} /></span>
              <div className="status-tx">
                <b>{available ? `${t("status.update_available", "Update available")} v${available.version}` : t("status.up_to_date", "Launcher is up to date")}</b>
                <span>
                  {available
                    ? t("status.update_restart", "The launcher restarts afterwards")
                    : checkedAt ? `${t("status.checked", "Checked")} ${ago(checkedAt, now)}` : t("status.not_checked", "Not checked yet")}
                </span>
              </div>
              {available ? (
                <button type="button" className="status-pill" disabled={progress !== null} onClick={() => setConfirm(true)}>
                  {progress !== null ? `${progress}%` : t("update.button", "Update")}
                </button>
              ) : (
                <button type="button" className={`status-icon-btn${checking ? " spinning" : ""}`} title={t("status.check_now", "Check now")} disabled={checking} onClick={recheck}>
                  <RefreshIcon width={16} height={16} />
                </button>
              )}
            </div>

            <div className="status-item">
              <span className={`status-ic status-ic-${tone}`}><CloudIcon width={18} height={18} /></span>
              <div className="status-tx">
                <b>NiHao service</b>
                <span>{connectionText}</span>
              </div>
              {offline && <button type="button" className="status-pill" onClick={retry}>{t("status.retry", "Retry")}</button>}
            </div>

            {installs.map(({ module, progress: p }) => {
              const pct = computeOverallPercent(p);
              const icon = icons[p.name] ?? games[module]?.config?.icon;
              return (
                <div className="status-item" key={`${module}-${p.name}`}>
                  <span className="status-ic status-ic-acc">{icon ? <img src={icon} alt="" /> : <DownloadIcon width={18} height={18} />}</span>
                  <div className="status-tx">
                    <b>{p.name}</b>
                    <span>{t("status.step", "Step")} {p.current_etaps}/{p.total_etaps} · {p.etap}{p.total_files > 0 ? ` (${p.current_file}/${p.total_files})` : ""}</span>
                    {p.filename && <span className="status-file">{p.filename}</span>}
                    <div className="status-bar"><i style={{ width: `${pct}%` }} /></div>
                  </div>
                  <b className="status-pct-big">{pct}%</b>
                </div>
              );
            })}

            {playing && (
              <div className="status-item">
                <span className="status-ic status-ic-acc"><GamepadIcon width={18} height={18} /></span>
                <div className="status-tx">
                  <b>{playing.game}</b>
                  <span>{[playing.detail, playSince ? `${t("status.playing_for", "playing for")} ${duration(now - playSince)}` : null].filter(Boolean).join(" · ")}</span>
                </div>
              </div>
            )}
          </div>

          <div className="status-sec">
            <span className="status-title"><BellIcon width={14} height={14} /> {t("status.notices", "Notifications")}</span>
            {notices.length > 0 && <button type="button" className="status-clear" onClick={clear}>{t("status.clear", "Clear all")}</button>}
          </div>
          {notices.length === 0 && <div className="status-empty">{t("status.no_notices", "Nothing yet")}</div>}
          {notices.map((n) => (
            <div className="status-notice" key={n.id}>
              <span className="status-na">
                {n.icon && <img src={n.icon} alt="" />}
                <span className={`status-nd status-nd-${n.kind}`}>
                  {n.kind === "ok" ? <CheckIcon width={11} height={11} /> : n.kind === "error" ? <WarningIcon width={11} height={11} /> : <InfoIcon width={11} height={11} />}
                </span>
              </span>
              <span className="status-nt">
                <b>{n.title ?? n.text}</b>
                {n.title && <span>{n.text}</span>}
              </span>
              <time title={clock(n.at)}>{ago(n.at, now)}</time>
            </div>
          ))}
        </div>
      )}

      <ConfirmModal
        isOpen={confirm}
        onCancel={() => setConfirm(false)}
        onConfirm={handleUpdate}
        icon={<UpdateIcon />}
        confirmIcon={<UpdateIcon />}
        message={`${t("update.confirm", "Update the launcher to")} v${available?.version ?? ""}? ${t("update.confirm_restart", "It will restart afterwards.")}`}
        confirmText={t("update.button", "Update")}
      />
    </div>
  );
}
