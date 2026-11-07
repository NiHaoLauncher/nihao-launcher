// The Launch page of one instance: play, world and server picker, missing files.
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { useCallback, useEffect, useRef, useState } from "react";
import { open as openExternalUrl } from "@tauri-apps/api/shell";
import { t } from "@shared/components/Translate";
import { Modal, ConfirmModal } from "@shared/index";
import { useCallModule } from "@shared/modules";
import { useBridge } from "@shared";
import { ActionsBanner } from "../ActionsBanner";
import TrashIcon from "@shared/assets/icons/trash.svg?react";
import FolderIcon from "@shared/assets/icons/folder.svg?react";
import FileIcon from "@shared/assets/icons/file.svg?react";
import DownloadIcon from "@shared/assets/icons/download.svg?react";
import RefreshIcon from "@shared/assets/icons/refresh.svg?react";
import { ModpackProfile, DownloadedCopy, MissingFile, ModpackEntry, ModpackSource, PlayingStatus, PlayTarget } from "./types";
import { isManaged, formatPlaytime, formatLastPlayed, waitForBackgroundJob, JOINING_SERVER } from "./helpers";
import { useGamePath, useSignedIn, useBackgroundImage, useGeneralRam, useInstallingNames } from "./hooks";
import { LoaderLabel, ServiceLogo, ServiceName, PanelExpandButton } from "./components";
import { SessionSelector } from "./profiles";
import { PlaytimeModal } from "./playtime";
import NIHAO_ICON from "@shared/assets/nihao-icon.png";
import ClockIcon from "@shared/assets/icons/clock.svg?react";
import { CrashModal, LaunchProgressModal, READY_STAGE, detectLaunchStage } from "./launchStatus";
import { ShareModal } from "./share";
import { ContentManagerPanel } from "./content";
import { ModpackSettingsModal } from "./modpackSettings/ModpackSettingsModal";

/** Where the player is, from the vanilla client log (same lines on Fabric/NeoForge): `Sound engine
 *  started` = title screen reached, `Connecting to` = joining a server, `Starting integrated
 *  minecraft server` = opening a world, `Stopping server` = world closed, back to the menu. */
function detectPlayingStatus(log: string[]): PlayingStatus | undefined {
  for (let i = log.length - 1; i >= 0; i--) {
    const l = log[i];
    if (JOINING_SERVER.test(l)) return "multiplayer";
    if (l.includes("Starting integrated minecraft server")) return "singleplayer";
    if (l.includes("]: Stopping server") || l.includes("Stopping singleplayer server") || l.includes("Sound engine started")) return "menu";
  }
  return undefined;
}

/**
 * The files a modpack needs but couldn't be downloaded for the player (`profile.missing_files`):
 * their authors keep them off third-party downloads and no other service has them. Each has a
 * button that starts its download in the browser; "Check" then looks in the instance and in the
 * Downloads folder (copying what it finds in), and when everything is in, offers to delete the
 * copies from Downloads.
 */
function MissingFilesModal({ name, files, onClose, onChanged, onLaunchAnyway }: {
  name: string;
  files: MissingFile[];
  onClose: () => void;
  onChanged: (remaining: MissingFile[]) => void;
  onLaunchAnyway: () => void;
}) {
  const call_module = useCallModule();
  const toast = useBridge((b) => b.toast);
  const [checking, setChecking] = useState(false);
  /** What checks so far took from Downloads: offered for deletion once nothing is missing. */
  const [copied, setCopied] = useState<DownloadedCopy[]>([]);
  const [notice, setNotice] = useState<{ text: string; warn?: boolean } | null>(null);
  const [askCleanup, setAskCleanup] = useState(false);

  async function check() {
    setChecking(true);
    setNotice(null);
    try {
      const res: any = await call_module("check_missing_files", { name });
      const left: MissingFile[] = Array.isArray(res?.missing) ? res.missing : files;
      const taken: DownloadedCopy[] = Array.isArray(res?.copied) ? res.copied : [];
      const wrong: string[] = Array.isArray(res?.wrong_build) ? res.wrong_build : [];
      const all = [...copied, ...taken];
      setCopied(all);
      onChanged(left);
      if (left.length === 0) {
        if (all.length > 0) {
          setAskCleanup(true);
        } else {
          toast?.({ message: t("minecraft.launch.missing_all_done", "All files are in place."), variant: "success" });
          onClose();
        }
      } else if (taken.length > 0) {
        setNotice({ text: t("minecraft.launch.missing_found", "Found {n} in your Downloads folder and added to the instance.").replace("{n}", String(taken.length)) });
      } else if (wrong.length > 0) {
        setNotice({ text: t("minecraft.launch.missing_wrong_build", "{files} in Downloads is another version than the pack needs.").replace("{files}", wrong.join(", ")), warn: true });
      } else {
        setNotice({ text: t("minecraft.launch.missing_none", "Nothing new found in the instance or in your Downloads folder."), warn: true });
      }
    } catch (e) {
      console.error(e);
      setNotice({ text: String(e), warn: true });
    } finally {
      setChecking(false);
    }
  }

  async function cleanUp() {
    setAskCleanup(false);
    try {
      const deleted = await call_module("delete_downloaded_files", { name, files: copied });
      toast?.({ message: t("minecraft.launch.missing_cleaned", "Deleted {n} from Downloads.").replace("{n}", String(deleted)), variant: "success" });
    } catch (e) {
      console.error(e);
    }
    onClose();
  }

  if (askCleanup) {
    return (
      <ConfirmModal
        isOpen
        onCancel={onClose}
        onConfirm={cleanUp}
        message={t("minecraft.launch.missing_cleanup", "Delete the {n} file(s) you downloaded from your Downloads folder? They are already in the instance.").replace("{n}", String(copied.length))}
        confirmText={t("minecraft.launch.missing_cleanup_delete", "Delete")}
        cancelText={t("minecraft.launch.missing_cleanup_keep", "Keep")}
        variant="danger"
        icon={<TrashIcon />}
        confirmIcon={<TrashIcon />}
      />
    );
  }

  return (
    <Modal isOpen onClose={onClose} title={t("minecraft.launch.missing_title", "Missing mods")} size="medium">
      <div className="missing-body">
        <p className="missing-hint">
          {t("minecraft.launch.missing_hint", "Their authors don't allow downloading these outside CurseForge. Press Download on each (the download starts on its page), then Check: files found in your Downloads folder are added to the instance for you.")}
        </p>
        {notice && <p className={`missing-notice${notice.warn ? " warn" : ""}`}>{notice.text}</p>}
        <ul className="missing-list">
          {files.map((f) => (
            <li key={f.path} className="missing-item">
              <span className="missing-item-icon"><FileIcon width={18} height={18} /></span>
              <span className="missing-item-text">
                <strong title={f.name}>{f.name}</strong>
                <small title={f.path}>{f.path.split("/").pop()}</small>
              </span>
              {/* Older profiles stored the file's page, which only shows the file; `/download/` starts it. */}
              <button type="button" className="missing-btn primary" onClick={() => openExternalUrl(f.page_url.replace(/\/files\/(\d+)$/, "/download/$1")).catch(console.error)}>
                <DownloadIcon width={16} height={16} /> {t("minecraft.launch.missing_download", "Download")}
              </button>
            </li>
          ))}
        </ul>
        <div className="missing-footer">
          <button type="button" className="missing-btn" onClick={() => call_module("open_modpack_folder", { name }).catch(console.error)}>
            <FolderIcon width={16} height={16} /> {t("minecraft.modpacks_list.menu_open_folder", "Open folder")}
          </button>
          <span className="missing-footer-spacer" />
          <button type="button" className="missing-btn ghost" onClick={onLaunchAnyway}>
            {t("minecraft.launch.missing_launch_anyway", "Launch anyway")}
          </button>
          <button type="button" className="missing-btn primary" disabled={checking} onClick={check}>
            <RefreshIcon width={16} height={16} /> {t("minecraft.launch.missing_check", "Check")}
          </button>
        </div>
      </div>
    </Modal>
  );
}

export function MinecraftLaunch() {
  const call_module = useCallModule();
  const navigate = useNavigate();
  const [playtimeOpen, setPlaytimeOpen] = useState(false);
  const [crash, setCrash] = useState<{ log: string[]; exitCode: number | null } | null>(null);
  const [progressDismissed, setProgressDismissed] = useState(false);
  /** Set by `handleClose`, so a game the player closed themselves is never reported as a crash. */
  const closedByUser = useRef(false);
  const launcherHidden = useRef(false);
  const gamePath = useGamePath();
  const generalRam = useGeneralRam();
  const signedIn = useSignedIn();
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
    /**
     * Set by a "Public" tile with no downloaded instance (`ModpacksContent`): opens `/play` as a
     * not-yet-installed preview (Download instead of Launch, no ActionsBanner/Share/Settings).
     * `publicId` is the catalog id to install; `packName` is the header title and the new
     * instance's directory name.
     */
    publicPreview?: boolean;
    publicId?: string;
    packName?: string;
  } | null;
  const isPreview = !!state?.publicPreview;
  const [launching, setLaunching] = useState(false);
  const [running, setRunning] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [sidePanel, setSidePanel] = useState<"none" | "console" | "content">("none");
  const [panelExpanded, setPanelExpanded] = useState(false);
  useEffect(() => { if (sidePanel === "none") setPanelExpanded(false); }, [sidePanel]);
  const [playTarget, setPlayTarget] = useState<PlayTarget | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  // Opened after mount (false -> true), the same path as the banner buttons, rather than mounted
  // already open.
  useEffect(() => {
    if (state?.openSettings) setSettingsOpen(true);
    if (state?.openShare) setShareOpen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [missingOpen, setMissingOpen] = useState(false);
  const [profile, setProfile] = useState(state?.profile);
  /** Files the pack needs that are still to be downloaded by hand: Launch asks for them first. */
  const missingCount = profile?.missing_files?.length ?? 0;
  // The nickname to launch under, synced from `SessionSelector` via `onSessionChange`; "Player" is
  // only the placeholder until its first callback.
  const [sessionNickname, setSessionNickname] = useState("Player");
  const [sessionProfileId, setSessionProfileId] = useState<string | null>(null);
  const handleSessionChange = useCallback((nickname: string, profileId: string) => {
    setSessionNickname(nickname);
    setSessionProfileId(profileId);
  }, []);
  const [iconData, setIconData] = useState(state?.icon_data ?? null);
  const [bannerData, setBannerData] = useState(state?.banner_data ?? null);
  const background = bannerData ?? defaultBackground;
  const [error, setError] = useState<string | null>(null);
  // NiHao Client in this instance and the build that fits it; `null` until asked.
  const [nihao, setNihao] = useState<{ installed: boolean; installed_version: string | null; build: { version: string; host: string } | null; update: boolean } | null>(null);
  const [installingNihao, setInstallingNihao] = useState(false);
  const refreshNihao = () => {
    if (!state?.name) return;
    call_module("get_nihao_client_status", { name: state.name }).then((res: any) => setNihao(res)).catch(() => setNihao(null));
  };
  useEffect(refreshNihao, [state?.name]);
  async function handleInstallNihao() {
    if (!state?.name) return;
    setInstallingNihao(true);
    setError(null);
    try {
      await call_module("install_nihao_client", { name: state.name });
      refreshNihao();
    } catch (e) {
      setError(String(e));
    } finally {
      setInstallingNihao(false);
    }
  }
  // A repair or version switch changes the profile on disk (version, loader, missing files).
  const installing = useInstallingNames(() => {
    call_module("get_modpacks", {})
      .then((list: any) => {
        const found: ModpackEntry | undefined = Array.isArray(list) ? list.find((entry: ModpackEntry) => entry.name === state?.name) : undefined;
        if (!found) return;
        setProfile(found.profile);
        setIconData(found.icon_data);
        setBannerData(found.banner_data);
        refreshNihao();
      })
      .catch(console.error);
  });
  const busy = !!state?.name && installing.has(state.name);
  const logRef = useRef<HTMLDivElement>(null);
  const reportPlayingActivity = useBridge((b) => b.reportPlayingActivity);
  const setLauncherHidden = useBridge((b) => b.setLauncherHidden);

  // Poll the running process's stdout/stderr (the plugin boundary can't push a live log); also
  // detects the game exiting on its own.
  useEffect(() => {
    const name = state?.name;
    if (!running || !name) return;
    let cancelled = false;

    const poll = async () => {
      try {
        const res: any = await call_module("get_launch_log", { name });
        if (cancelled) return;
        const next: string[] = Array.isArray(res?.log) ? res.log : [];
        setLog((prev) => (prev.length === next.length && prev[prev.length - 1] === next[next.length - 1] ? prev : next));
        if (!res?.running) {
          setRunning(false);
          // Non-zero exit, or gone before the game came up at all.
          const code: number | null = typeof res?.exit_code === "number" ? res.exit_code : null;
          // A missing code (killed by a signal) is a crash too, not only a non-zero one.
          if (!closedByUser.current && (code !== 0 || detectLaunchStage(next, true) < READY_STAGE)) {
            setCrash({ log: next, exitCode: code });
          }
        }
      } catch {
        if (!cancelled) setRunning(false);
      }
    };

    poll();
    const interval = setInterval(poll, 800);
    return () => { cancelled = true; clearInterval(interval); };
  }, [running, state?.name]);

  const stage = detectLaunchStage(log, running);
  const gameUp = running && stage === READY_STAGE;

  // "Hide launcher while game is running" (the bridge checks the setting): minimize once the game is
  // up, bring the launcher back when it exits, and also if this page goes away so it can't stay hidden.
  useEffect(() => {
    if (gameUp && !launcherHidden.current) {
      launcherHidden.current = true;
      setLauncherHidden?.(true);
    } else if (!running && launcherHidden.current) {
      launcherHidden.current = false;
      setLauncherHidden?.(false);
    }
  }, [gameUp, running]);
  useEffect(() => () => {
    if (launcherHidden.current) setLauncherHidden?.(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reports the play session to Discord presence, taking over from the "Browsing Minecraft" state
  // `GameLoader.tsx` reports. Best-effort from the game log: the last marker wins, the previous
  // answer is kept when the capped log holds none; leaving a multiplayer server logs nothing, so
  // it stays "multiplayer" until the next marker.
  const lastStatus = useRef<PlayingStatus | undefined>(undefined);
  if (!running) lastStatus.current = undefined;
  else lastStatus.current = detectPlayingStatus(log) ?? lastStatus.current;
  const playingStatus = lastStatus.current;

  useEffect(() => {
    if (!running) {
      reportPlayingActivity?.(null);
      return;
    }
    let cancelled = false;
    const report = (source: ModpackSource | null | undefined) => {
      if (cancelled) return;
      reportPlayingActivity?.({
        status: playingStatus,
        detail: profile?.display_name ?? state?.packName ?? state?.name ?? "",
        nickname: sessionNickname,
        // Only a pack downloaded from "Public" has anything a friend could join.
        joinButton: profile?.downloaded && profile?.pack?.id
          ? { label: t("minecraft.launch.play_together", "Play together"), url: `nihaolauncher://play-together/minecraft/${profile.pack.id}` }
          : undefined,
        // A pack from a third-party service: its public icon as the large image, plus a link to its page.
        largeImage: source?.icon_url?.startsWith("https://") ? source.icon_url : undefined,
        largeText: source?.name,
        linkButton: source?.url?.startsWith("https://")
          ? { label: t("minecraft.launch.view_on_service", "View on {{service}}").replace("{{service}}", source.service), url: source.url }
          : undefined,
      });
    };
    report(profile?.source);
    // A pack installed before `source.icon_url`/`url` were stored gets them filled in; on failure
    // the fields stay unset and the next launch retries.
    if (profile?.source && (!profile.source.icon_url || !profile.source.url) && state?.name) {
      call_module("refresh_modpack_source", { name: state.name })
        .then((fresh: any) => fresh && report(fresh))
        .catch(console.error);
    }
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, playingStatus]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [log]);

  if (!state?.name && !isPreview) {
    return <Navigate to="/" replace />;
  }

  async function handleDownloadPreview() {
    if (!gamePath || !signedIn || !state?.publicId) return;
    const localName = (state.packName ?? state.publicId).trim();
    setDownloading(true);
    setError(null);
    try {
      await call_module("install_online_modpack", { name: localName, id: state.publicId });
      const jobError = await waitForBackgroundJob(call_module, localName);
      if (jobError) throw new Error(jobError);
      const list: any = await call_module("get_modpacks", {});
      const installed = Array.isArray(list) ? list.find((entry: any) => entry.name === localName) : null;
      navigate("/play", {
        replace: true,
        state: { name: localName, profile: installed?.profile, icon_data: installed?.icon_data, banner_data: installed?.banner_data },
      });
    } catch (e) {
      setError(String(e));
    } finally {
      setDownloading(false);
    }
  }

  async function handleLaunch() {
    if (!gamePath || !state?.name) return;
    setLaunching(true);
    setError(null);
    setLog([]);
    setCrash(null);
    setProgressDismissed(false);
    closedByUser.current = false;
    setSidePanel("console");
    try {
      // "Use custom RAM" off means the general Game settings RAM is used; decided on the Rust side
      // (reads game.nihao), so it is right even if `generalRam` hasn't loaded yet.
      await call_module("play_modpack", {
        name: state.name,
        nickname: sessionNickname,
        profile_id: sessionProfileId,
        world: playTarget?.kind === "world" ? playTarget.value : null,
        server: playTarget?.kind === "server" ? playTarget.value : null,
      });
      setRunning(true);
    } catch (e) {
      setError(String(e));
    } finally {
      setLaunching(false);
    }
  }

  async function handleClose() {
    if (!state?.name) return;
    closedByUser.current = true;
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
      await call_module("open_modpack_folder", { name: state.name });
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
      <div className="launch-scrim" />
      {!isPreview && (
        <ActionsBanner
          visible={!logPanelOpen}
          onOpenConsole={() => setSidePanel((p) => (p === "console" ? "none" : "console"))}
          onOpenFolder={handleOpenFolder}
          onShare={() => setShareOpen(true)}
          // A pack tied to a service has its file set dictated by it, so its content is shown
          // read-only (see `ContentManagerPanel`).
          onOpenContent={() => setSidePanel((p) => (p === "content" ? "none" : "content"))}
          onOpenSettings={() => setSettingsOpen(true)}
        />
      )}
      {!isPreview && (
        <ShareModal
          open={shareOpen}
          onClose={() => setShareOpen(false)}
          gamePath={gamePath}
          name={state.name!}
          profile={profile}
          onPublished={(pack) => setProfile((prev) => (prev ? { ...prev, pack } : prev))}
        />
      )}
      {profile && (
        <ModpackSettingsModal
          open={settingsOpen}
          onClose={() => setSettingsOpen(false)}
          name={state.name!}
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
      {profile && state?.name && missingOpen && (
        <MissingFilesModal
          name={state.name}
          files={profile.missing_files ?? []}
          onClose={() => setMissingOpen(false)}
          onChanged={(left) => setProfile((prev) => (prev ? { ...prev, missing_files: left } : prev))}
          onLaunchAnyway={() => { setMissingOpen(false); handleLaunch(); }}
        />
      )}
      {(launching || running) && !gameUp && !progressDismissed && (
        <LaunchProgressModal stage={stage} log={log} onKill={handleClose} onClose={() => setProgressDismissed(true)} />
      )}
      {crash && state?.name && (
        <CrashModal name={state.name} profile={profile} log={crash.log} exitCode={crash.exitCode} onClose={() => setCrash(null)} />
      )}
      {playtimeOpen && profile && <PlaytimeModal name={state!.name!} profile={profile} onClose={() => setPlaytimeOpen(false)} />}
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
        <div style={{ display: "flex", flex: 1, minHeight: 0, gap: "20px", position: panelExpanded ? undefined : "relative" }}>
          <div className="launch-head">
            <div className="launch-title">
              {iconData && <img src={iconData} alt="" className="launch-title-icon" />}
              <h1>{profile?.display_name ?? state.packName ?? state.name}</h1>
            </div>
            {profile && (
              <div className="launch-chips">
                {profile.source && (
                  <button type="button" className="launch-chip launch-chip-btn" title={profile.source.name}
                    onClick={() => navigate(`/market/${profile.source!.service}/${profile.source!.project_id}`)}>
                    <ServiceLogo service={profile.source.service} className="launch-chip-logo" />
                    <span className="launch-chip-text">
                      <b><ServiceName service={profile.source.service} /></b>
                      <small>{profile.source.version_number}</small>
                    </span>
                  </button>
                )}
                <span className="launch-chip">
                  <LoaderLabel loader={profile.core} label="" />
                  <span className="launch-chip-text">
                    <b>{profile.core}</b>
                    <small>{[profile.version_id, profile.loader_version].filter(Boolean).join(" · ")}</small>
                  </span>
                </span>
                <button type="button" className="launch-chip launch-chip-btn" onClick={() => setPlaytimeOpen(true)}>
                  <ClockIcon className="launch-chip-logo" />
                  <span className="launch-chip-text">
                    <b>{t("minecraft.launch.playtime", "Playtime")}</b>
                    <small>{formatPlaytime(profile.play_secs)}</small>
                  </span>
                </button>
                <span className="launch-chip">
                  <span className="launch-chip-text">
                    <b>{t("minecraft.launch.last_played", "Last played")}</b>
                    <small>{profile.last_played ? formatLastPlayed(profile.last_played) : t("minecraft.launch.never", "Never")}</small>
                  </span>
                </span>
              </div>
            )}
          </div>
          {logPanelOpen && <div className={`launch-panel-slot${panelExpanded ? " launch-panel-slot-expanded" : ""}`}>
            {sidePanel === "console" && (
              <div className={`client-log-panel${panelExpanded ? " client-log-panel-expanded" : ""}`}>
                <div className="client-log-header">
                  <span>{t("minecraft.launch.log_title", "Client log")}</span>
                  <span className="client-log-header-actions">
                    <PanelExpandButton expanded={panelExpanded} onToggle={() => setPanelExpanded((v) => !v)} />
                    <button
                      className="client-log-close"
                      onClick={() => setSidePanel("none")}
                      title={t("minecraft.launch.log_close", "Close log")}
                    >
                      ×
                    </button>
                  </span>
                </div>
                <div ref={logRef} className="client-log">
                  {log.length === 0 && <div className="client-log-line client-log-empty">{t("minecraft.launch.client_log_empty", "Waiting for client output...")}</div>}
                  {log.map((line, i) => <div key={i} className="client-log-line">{line}</div>)}
                </div>
              </div>
            )}
            {sidePanel === "content" && (
              <ContentManagerPanel
                onClose={() => setSidePanel("none")}
                gamePath={gamePath}
                name={state.name!}
                expanded={panelExpanded}
                onToggleExpand={() => setPanelExpanded((v) => !v)}
                readOnly={!!profile && isManaged(profile)}
              />
            )}
          </div>}
        </div>
        <div style={{
          width: "100%",
          flexShrink: 0,
        }}>
          {!isPreview && state?.name && (
            <PlayTargetsBar
              name={state.name}
              versionId={profile?.version_id}
              disabled={launching || running}
              target={playTarget}
              onChange={setPlayTarget}
            />
          )}
          {!isPreview && nihao && !nihao.installed && nihao.build && !profile?.downloaded && (
            <div className="launch-nihao-notice">
              <img src={NIHAO_ICON} alt="" />
              <span>{t("minecraft.launch.nihao_client_missing", "Your skin won't be visible in the game. Want it? Install NiHao Client.")}</span>
              <button type="button" onClick={handleInstallNihao} disabled={installingNihao || launching || running || busy}>
                {installingNihao ? t("minecraft.launch.nihao_client_installing", "Installing...") : t("minecraft.launch.nihao_client_install", "Install")}
              </button>
            </div>
          )}
          <div style={{ display: "flex", alignItems: "stretch", gap: "10px" }}>
            {isPreview ? (
              <button
                className="modpack-play-btn"
                onClick={handleDownloadPreview}
                disabled={downloading || !gamePath || !signedIn}
                title={!signedIn ? t("minecraft.modpacks_list.public_signin_required", "Sign in to your NiHao account to see public modpacks.") : undefined}>
                {downloading
                  ? t("minecraft.modpacks_list.public_downloading", "Downloading...")
                  : t("minecraft.modpacks_list.public_download", "Download")}
              </button>
            ) : (
              <>
                <button
                  className={`modpack-play-btn${missingCount > 0 && !running ? " warn" : ""}`}
                  onClick={running ? handleClose : missingCount > 0 ? () => setMissingOpen(true) : handleLaunch}
                  disabled={launching || busy || (!running && !gamePath)}>
                  {!running && !launching && (missingCount > 0
                    ? <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true"><path d="M12 2 1 21h22L12 2zm1 15h-2v-2h2v2zm0-4h-2V9h2v4z" /></svg>
                    : <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true"><path d="m7 4 13 8-13 8z" /></svg>)}
                  {launching
                    ? t("minecraft.launch.launching", "Launching...")
                    : running
                      ? t("minecraft.launch.close", "Close")
                      : missingCount > 0
                        ? `${t("minecraft.launch.missing_button", "Missing mods")} (${missingCount})`
                        : t("minecraft.launch.button", "Launch")}
                </button>
                <SessionSelector gamePath={gamePath} disabled={launching || running} onSessionChange={handleSessionChange} />
                {nihao?.installed && (
                  <span className={`launch-chip launch-nihao-chip${nihao.update ? " has-update" : ""}`} title={t("minecraft.launch.nihao_client_on_hint", "Ely.by skins and the screenshot gallery work in this modpack.")}>
                    <img className="launch-chip-logo" src={NIHAO_ICON} alt="" />
                    <span className="launch-chip-text">
                      <b>{t("minecraft.launch.nihao_client", "NiHao Client")}</b>
                      <small>
                        {nihao.update && nihao.build
                          ? `${nihao.installed_version ?? ""} → ${nihao.build.version}`
                          : nihao.installed_version ?? t("minecraft.launch.nihao_client_on", "Installed")}
                      </small>
                    </span>
                    {nihao.update && (
                      <button
                        type="button"
                        className="launch-nihao-update"
                        disabled={installingNihao || launching || running || busy}
                        title={t("minecraft.launch.nihao_client_update_hint", "A newer NiHao Client is out for this modpack")}
                        onClick={handleInstallNihao}
                      >
                        <RefreshIcon width={14} height={14} />
                        {installingNihao ? t("minecraft.launch.nihao_client_updating", "Updating...") : t("minecraft.launch.nihao_client_update", "Update")}
                      </button>
                    )}
                  </span>
                )}
              </>
            )}
          </div>
          {error && <p style={{ color: "var(--nh-danger)", fontSize: "0.85rem" }}>{error}</p>}
        </div>
      </div>
    </div>
  )
}

/** The strip above Launch listing the instance's worlds and servers; picking one (click again to
 *  unpick) makes the next launch join it directly. Worlds need Minecraft 1.20+ (`--quickPlay`),
 *  servers work on any version. Renders nothing while there is nothing to pick. */
function PlayTargetsBar({ name, versionId, disabled, target, onChange }: {
  name: string;
  versionId?: string;
  disabled: boolean;
  target: PlayTarget | null;
  onChange: (t: PlayTarget | null) => void;
}) {
  const call_module = useCallModule();
  type ServerEntry = { name: string; ip: string; icon: string | null };
  const [list, setList] = useState<{ worlds: { folder: string; icon: string | null }[]; servers: ServerEntry[] }>({ worlds: [], servers: [] });
  // Per server address: missing = still pinging, else whether it answered (+ player count).
  const [status, setStatus] = useState<Record<string, { online: boolean; players?: number; max?: number }>>({});

  useEffect(() => {
    if (disabled) return;
    let cancelled = false;
    call_module("list_play_targets", { name })
      .then((res: any) => {
        if (cancelled) return;
        const next = { worlds: res?.worlds ?? [], servers: res?.servers ?? [] };
        setList(next);
        const exists = target?.kind === "world" ? next.worlds.some((w: any) => w.folder === target.value) : next.servers.some((s: any) => s.ip === target?.value);
        if (target && !exists) onChange(null);
        setStatus({});
        next.servers.forEach((s: ServerEntry) => {
          call_module("ping_server", { address: s.ip })
            .then((r: any) => { if (!cancelled) setStatus((prev) => ({ ...prev, [s.ip]: r })); })
            .catch(() => { if (!cancelled) setStatus((prev) => ({ ...prev, [s.ip]: { online: false } })); });
        });
      })
      .catch(() => {});
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, disabled]);

  // Same rule as `supports_quick_play` (Rust): before 1.20 only servers can be joined.
  const [major, minor] = (versionId ?? "").split(".").map((p) => parseInt(p, 10));
  const worlds = major === 1 && minor < 20 ? [] : list.worlds;
  if (worlds.length === 0 && list.servers.length === 0) return null;

  const chip = (kind: PlayTarget["kind"], value: string, label: string, key: string, icon: string | null) => {
    const active = target?.kind === kind && target.value === value;
    return (
      <button
        key={key}
        className={`play-target${active ? " active" : ""}`}
        disabled={disabled}
        title={kind === "server" ? `${value}${status[value]?.online ? ` · ${status[value].players}/${status[value].max}` : ""}` : label}
        onClick={() => onChange(active ? null : { kind, value })}
      >
        <span className="play-target-icon">
          {icon ? <img src={icon} alt="" /> : kind === "world" ? "🌍" : "🖧"}
          {kind === "server" && status[value] && (
            <i className={`play-target-dot ${status[value].online ? "online" : "offline"}`} />
          )}
        </span>
        <span className="play-target-name">{label}</span>
      </button>
    );
  };

  return (
    <div className="play-targets">
      {worlds.map((w) => chip("world", w.folder, w.folder, `w:${w.folder}`, w.icon))}
      {list.servers.map((s, i) => chip("server", s.ip, s.name, `s:${i