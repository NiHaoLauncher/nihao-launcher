// My modpacks: the list, its tiles and their menu.
import { useNavigate } from "react-router-dom";
import { useEffect, useRef, useState } from "react";
import { t, T } from "@shared/components/Translate";
import { ConfirmModal } from "@shared/index";
import { useCallModule } from "@shared/modules";
import { useBridge } from "@shared";
import PACKAGE from "@shared/assets/package.png";
import NIHAO_ICON from "@shared/assets/nihao-icon.png";
import ShareIcon from "@shared/assets/icons/share.svg?react";
import SettingsIcon from "@shared/assets/icons/settings.svg?react";
import PlayIcon from "@shared/assets/icons/play.svg?react";
import TrashIcon from "@shared/assets/icons/trash.svg?react";
import FolderIcon from "@shared/assets/icons/folder.svg?react";
import DownloadIcon from "@shared/assets/icons/download.svg?react";
import CrownIcon from "@shared/assets/icons/crown.svg?react";
import { ModpackEntry, TileMenuTarget, OnlineModpack } from "./types";
import { isManaged } from "./helpers";
import { useGamePath, useSignedIn, useModpackPermissions, useBackgroundImage, useInstances, useDismiss, useInstallingNames, useOwnedPackIds } from "./hooks";
import { LoaderLabel, ServiceLogo, ModpackBadge } from "./components";
import { CreateModpackModal } from "./createModpack";

export function ModpacksList() {
  const [activeTab, setActiveTab] = useState("all");
  const [createModpackModalOpen, setCreateModpackModalOpen] = useState(false);
  const gamePath = useGamePath();
  const signedIn = useSignedIn();
  const { canView } = useModpackPermissions();
  const { instances, loading, reload, refresh } = useInstances(gamePath);

  const tabs = [
    { key: "all", label: t("minecraft.modpacks_list.allInstanceLabel", "All Instance") },
    // `GET /minecraft/modpacks` needs a session token and `minecraft.modpacks.view`; without both
    // the tab is unclickable rather than showing a "no permission" message.
    { key: "public", label: t("minecraft.modpacks_list.publicInstanceLabel", "Public"), disabled: !signedIn || !canView },
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
              key={tab.key}
              disabled={tab.disabled ?? false}
              onClick={() => setActiveTab(tab.key)}
              title={
                tab.disabled
                  ? !signedIn
                    ? t("minecraft.modpacks_list.public_signin_required", "Sign in to your NiHao account to see public modpacks.")
                    : t("minecraft.modpacks_list.public_no_permission", "Your account doesn't have permission to view public modpacks.")
                  : undefined
              }
              style={{
                padding: "8px 16px",
                borderRadius: "50px",
                border: "none",
                backgroundColor: activeTab === tab.key ? "var(--main-color)" : "transparent",
                color: tab.disabled ? "var(--text-disabled-color)" : "var(--text-color)",
                fontSize: "14px",
                fontWeight: 600,
                cursor: tab.disabled ? "not-allowed" : "pointer",
                opacity: tab.disabled ? 0.5 : 1,
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
          style={{ marginLeft: "10px", backgroundColor: "var(--main-color)" }}
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
        {activeTab === "all" && (
          <InstancesGrid instances={instances} loading={loading} gamePath={gamePath} reload={reload} refresh={refresh} />
        )}
        {/*
         * "Custom" excludes everything tied to a service: what was downloaded from Public only shows
         * under "Public" (see `ModpackProfile.downloaded`), and one installed from Modrinth or
         * CurseForge under "All Instance" until it is detached.
         */}
        {activeTab === "custom" && (
          <InstancesGrid instances={instances.filter((i) => !isManaged(i.profile))} loading={loading} gamePath={gamePath} reload={reload} refresh={refresh} />
        )}
        {activeTab === "public" && (
          <ModpacksContent instances={instances} gamePath={gamePath} onDownloaded={reload} />
        )}
        <CreateModpackModal
          open={createModpackModalOpen}
          onClose={() => setCreateModpackModalOpen(false)}
          onCreated={reload}
        />
      </div>
    </>
  )
}

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
  const toast = useBridge((b) => b.toast);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  useDismiss(menuRef, onClose);

  function goToPlay(extra?: { openSettings?: boolean; openShare?: boolean }) {
    navigate("/play", { state: { ...target, ...extra } });
    onClose();
  }

  async function handleOpenFolder() {
    if (!gamePath) return;
    try {
      await call_module("open_modpack_folder", { name: target.name });
    } catch (e) {
      console.error(e);
    }
    onClose();
  }

  async function handleDelete() {
    if (!gamePath) return;
    setDeleting(true);
    try {
      await call_module("delete_modpack", { name: target.name });
      onDeleted();
      toast?.({ message: t("minecraft.modpacks_list.delete_done", "Modpack deleted."), variant: "success" });
    } catch (e) {
      console.error(e);
      toast?.({ message: `${t("minecraft.modpacks_list.delete_failed", "Couldn't delete the modpack.")} ${String(e)}`, variant: "error" });
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
        message={t("minecraft.modpacks_list.delete_confirm", "Delete \"{name}\"? This removes all its saves and mods permanently.").replace("{name}", target.profile.display_name)}
        confirmText={t("minecraft.modpack_settings.delete", "Delete instance")}
        variant="danger"
        icon={<TrashIcon />}
        confirmIcon={<TrashIcon />}
      />
    );
  }

  return (
    <div ref={menuRef} className="modpack-context-menu" style={{ left: x, top: y }}>
      <button onClick={() => goToPlay()}>
        <PlayIcon width={16} height={16} />
        {t("minecraft.modpacks_list.menu_play", "Play")}
      </button>
      <button onClick={() => goToPlay({ openSettings: true })}>
        <SettingsIcon width={18} height={18} />
        {t("minecraft.modpack_settings.title", "Modpack settings")}
      </button>
      <button onClick={() => goToPlay({ openShare: true })}>
        <ShareIcon width={18} height={18} />
        {t("minecraft.share.title", "Share modpack")}
      </button>
      <button onClick={handleOpenFolder}>
        <FolderIcon width={18} height={18} />
        {t("minecraft.modpacks_list.menu_open_folder", "Open folder")}
      </button>
      <hr />
      <button className="danger" onClick={() => setConfirmDelete(true)} disabled={deleting}>
        <TrashIcon width={16} height={16} />
        {t("minecraft.modpack_settings.delete", "Delete instance")}
      </button>
    </div>
  );
}

/**
 * Tiles: banner dimmed/grayscale at rest, full colour on hover. Each instance can set its own
 * banner (Modpack settings → General), else the plugin's shared background image is used. Sized so
 * ~4 fit per row at the default window width.
 */
function InstancesGrid({
  instances, loading, gamePath, reload, refresh,
}: {
  instances: ModpackEntry[];
  loading: boolean;
  gamePath: string | undefined;
  reload: () => void;
  refresh: () => void;
}) {
  const navigate = useNavigate();
  const defaultBackground = useBackgroundImage();
  const { ownedIds, catalogIds } = useOwnedPackIds();
  const [menu, setMenu] = useState<{ x: number; y: number; target: TileMenuTarget } | null>(null);
  const installing = useInstallingNames(refresh);

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
      {instances.map(({ name, profile, icon_data, banner_data, nihao_client }) => {
        const background = banner_data ?? defaultBackground;
        return (
          <div
            key={name}
            className={`modpack-tile${installing.has(name) ? " installing" : ""}`}
            onClick={() => navigate("/play", { state: { name, profile, icon_data, banner_data } })}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu({ x: e.clientX, y: e.clientY, target: { name, profile, icon_data, banner_data } });
            }}
          >
            <div className="modpack-tile-background">
              {background && <img src={background} alt="" />}
            </div>
            {installing.has(name) && (
              <div className="modpack-tile-installing" title={t("minecraft.modpacks_list.installing", "Installing...")}>
                <DownloadIcon />
              </div>
            )}
            <ModpackBadge profile={profile} ownedIds={ownedIds} catalogIds={catalogIds} />
            {profile.source && (
              <span className="modpack-tile-badge modpack-tile-badge-service" title={`${profile.source.name} · ${profile.source.version_number}`}>
                <ServiceLogo service={profile.source.service} />
              </span>
            )}
            {nihao_client && (
              <span className="modpack-tile-badge modpack-tile-badge-nihao" title={t("minecraft.modpacks_list.badge_nihao_client", "Has NiHao Client")}><img src={NIHAO_ICON} alt="" /></span>
            )}
            {installing.has(name) && <div className="modpack-tile-progress" style={{ width: `${installing.get(name)}%` }} />}
            <div className="modpack-tile-info">
              <img className="modpack-tile-icon" src={icon_data ?? PACKAGE} alt="" />
              <div className="modpack-tile-text">
                <h2>{profile.display_name}</h2>
                <p><LoaderLabel loader={profile.core} /> · {profile.version_id}</p>
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

/**
 * "Public" tab: NiHao's hosted modpack catalog (`GET /minecraft/modpacks`, the module's own
 * server, not Modrinth). Two kinds of tile: downloaded instances (`profile.downloaded`, matched by
 * `profile.pack.id`) behave like normal tiles and go to `/play` (they never show under "Custom");
 * catalog entries not downloaded yet open `/play` in preview mode (Download instead of Launch),
 * while the corner download button installs immediately. Installing goes through
 * `install_online_modpack`.
 */
function ModpacksContent({
  instances, gamePath, onDownloaded,
}: {
  instances: ModpackEntry[];
  gamePath: string | undefined;
  onDownloaded: () => void;
}) {
  const call_module = useCallModule();
  const navigate = useNavigate();
  const defaultBackground = useBackgroundImage();
  const signedIn = useSignedIn();
  const [modpacks, setModpacks] = useState<OnlineModpack[]>([]);
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [downloadErrors, setDownloadErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!signedIn) return;
    let cancelled = false;
    setLoading(true);
    setListError(null);
    call_module("list_online_modpacks", {})
      .then((res: any) => { if (!cancelled) setModpacks(Array.isArray(res) ? res : []); })
      .catch((e) => { if (!cancelled) setListError(String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [signedIn]);

  if (!signedIn) {
    return (
      <div style={{ padding: "20px", color: "var(--text-color, white)" }}>
        {t("minecraft.modpacks_list.public_signin_required", "Sign in to your NiHao account to see public modpacks.")}
      </div>
    );
  }
  if (loading) {
    return <div style={{ padding: "20px", color: "var(--text-color, white)" }}>
      <T k="minecraft.modpacks_list.loading" alt="Loading..." />
    </div>;
  }
  if (listError) {
    return <div style={{ padding: "20px", color: "var(--nh-danger)" }}>{listError}</div>;
  }

  const downloadedInstances = instances.filter((i) => i.profile.downloaded);
  const downloadedIds = new Set(
    downloadedInstances.map((i) => i.profile.pack?.id).filter((id): id is string => !!id)
  );
  const notYetInstalled = modpacks.filter((mp) => !downloadedIds.has(mp.id));
  const ownedIds = new Set(modpacks.filter((mp) => mp.is_owner).map((mp) => mp.id));

  if (downloadedInstances.length === 0 && notYetInstalled.length === 0) {
    return (
      <div style={{ padding: "20px", color: "var(--text-color, white)" }}>
        {t("minecraft.modpacks_list.public_empty", "No public modpacks yet.")}
      </div>
    );
  }

  async function handleDownload(id: string, name: string) {
    if (!gamePath || !signedIn) return;
    setDownloading(id);
    setDownloadErrors((prev) => { const next = { ...prev }; delete next[id]; return next; });
    try {
      // `install_online_modpack` returns only after the manifest and icon/banner are fetched and
      // the profile is saved, so one refresh has everything.
      await call_module("install_online_modpack", { name, id });
      onDownloaded();
    } catch (e) {
      setDownloadErrors((prev) => ({ ...prev, [id]: String(e) }));
    } finally {
      setDownloading(null);
    }
  }

  return (
    <div className="modpack-tiles">
      {downloadedInstances.map(({ name, profile, icon_data, banner_data }) => {
        const background = banner_data ?? defaultBackground;
        return (
          <div
            key={name}
            className="modpack-tile"
            onClick={() => navigate("/play", { state: { name, profile, icon_data, banner_data } })}
          >
            <div className="modpack-tile-background">
              {background && <img src={background} alt="" />}
            </div>
            <ModpackBadge profile={profile} ownedIds={ownedIds} catalogIds={new Set(modpacks.map((mp) => mp.id))} />
            <div className="modpack-tile-info">
              <img className="modpack-tile-icon" src={icon_data ?? PACKAGE} alt="" />
              <div className="modpack-tile-text">
                <h2>{profile.display_name}</h2>
                <p><LoaderLabel loader={profile.core} /> · {profile.version_id}</p>
              </div>
            </div>
          </div>
        );
      })}

      {notYetInstalled.map((mp) => (
        <div
          key={mp.id}
          className="modpack-tile"
          onClick={() => navigate("/play", {
            state: {
              publicPreview: true,
              publicId: mp.id,
              packName: mp.name,
              icon_data: mp.icon_data_uri ?? null,
              banner_data: mp.banner_data_uri ?? null,
            },
          })}
        >
          <div className="modpack-tile-background">
            {mp.banner_data_uri && <img src={mp.banner_data_uri} alt="" />}
          </div>
          {/*
           * Not downloaded yet, so no cloud badge, but ownership is still worth flagging (see
           * `ModpackBadge`).
           */}
          {mp.is_owner && (
            <span
              className="modpack-tile-badge modpack-tile-badge-owner"
              title={t("minecraft.modpacks_list.badge_owned", "You own this pack")}
            >
              <CrownIcon width={13} height={13} />
            </span>
          )}
          <div className="modpack-tile-info">
            <img className="modpack-tile-icon" src={mp.icon_data_uri ?? PACKAGE} alt="" />
            <div className="modpack-tile-text">
              <h2>{mp.name}</h2>
              <p>{mp.visibility === "invite" ? t("minecraft.modpacks_list.public_invite_only", "Invite-only") : t("minecraft.modpacks_list.public_public", "Public")}</p>
            </div>
          </div>
          <button
            className="modpack-tile-download"
            disabled={downloading === mp.id}
            title={t("minecraft.modpacks_list.public_download", "Download")}
            onClick={(e) => { e.stopPropagation(); handleDownload(mp.id, mp.name); }}
          >
            <DownloadIcon width={12} height={12} />
          </button>
          {downloadErrors[mp.id] && (
            <p className="modpack-tile-error">{downloadErrors[mp.id]}</p>
          )}
        </div>
      ))}
    </div>
  );
}
