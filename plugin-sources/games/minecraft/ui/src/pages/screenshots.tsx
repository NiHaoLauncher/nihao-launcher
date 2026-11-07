// The Screenshots page.
import { useNavigate } from "react-router-dom";
import { useEffect, useMemo, useRef, useState } from "react";
import { save as saveFileDialog } from "@tauri-apps/api/dialog";
import { t } from "@shared/components/Translate";
import { Modal, ConfirmModal } from "@shared/index";
import { useCallModule } from "@shared/modules";
import { useBridge } from "@shared";
import PACKAGE from "@shared/assets/package.png";
import TrashIcon from "@shared/assets/icons/trash.svg?react";
import DownloadIcon from "@shared/assets/icons/download.svg?react";
import CopyIcon from "@shared/assets/icons/copy.svg?react";
import ChevronDownIcon from "@shared/assets/icons/chevron-down.svg?react";
import { ModpackEntry, ScreenshotEntry } from "./types";
import { useDismiss, useOnScreen } from "./hooks";
import { LoaderLabel } from "./components";
import { imageToPngBlob, ViewerArrows, ZoomableImage } from "./imageViewer";

/** One grid cell; fetches its image only once it scrolls into view (full-size files, no thumbnails). */
function ScreenshotTile({ shot, selected, onOpen, onMenu }: {
  shot: ScreenshotEntry;
  /** Its context menu is open: keep the hovered look until the menu closes. */
  selected: boolean;
  onOpen: (src: string) => void;
  onMenu: (e: React.MouseEvent, src: string | null) => void;
}) {
  const call_module = useCallModule();
  const ref = useRef<HTMLButtonElement>(null);
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let cancelled = false;
    let latest = 0;
    // Loads while near the screen and drops the (multi-MB) data URI when it scrolls far away.
    const observer = new IntersectionObserver((entries) => {
      const mine = ++latest;
      if (!entries[entries.length - 1].isIntersecting) { setSrc(null); return; }
      call_module("get_screenshot", { instance: shot.instance, file: shot.file })
        .then((uri: any) => { if (!cancelled && mine === latest) setSrc(uri); })
        .catch(() => {});
    }, { rootMargin: "200px" });
    observer.observe(el);
    return () => { cancelled = true; observer.disconnect(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shot.instance, shot.file]);

  return (
    <button
      ref={ref}
      className={`screenshot-tile${selected ? " selected" : ""}`}
      disabled={!src}
      onClick={() => src && onOpen(src)}
      onContextMenu={(e) => { e.preventDefault(); onMenu(e, src); }}
      title={new Date(shot.modified * 1000).toLocaleString()}
    >
      {src && <img src={src} alt="" />}
    </button>
  );
}

/**
 * Right-click menu of a screenshot: its modpack as a mini card, copy to clipboard, save as file,
 * delete.
 */
function ScreenshotContextMenu({ x, y, shot, src, pack, onClose, onDeleted }: {
  x: number;
  y: number;
  shot: ScreenshotEntry;
  src: string | null;
  pack: ModpackEntry | undefined;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const navigate = useNavigate();
  const call_module = useCallModule();
  const menuRef = useRef<HTMLDivElement>(null);
  const toast = useBridge((b) => b.toast);
  const [confirmDelete, setConfirmDelete] = useState(false);
  useDismiss(menuRef, onClose);
  const at = useOnScreen(menuRef, x, y);

  async function copy() {
    try {
      await navigator.clipboard.write([new ClipboardItem({ "image/png": await imageToPngBlob(src!) })]);
      toast?.({ message: t("minecraft.screenshots.copy_done", "Screenshot copied to the clipboard."), variant: "success" });
    } catch (e) {
      console.error(e);
      toast?.({ message: t("minecraft.screenshots.copy_failed", "Couldn't copy the screenshot."), variant: "error" });
    }
    onClose();
  }

  async function download() {
    try {
      const dest = await saveFileDialog({ defaultPath: shot.file });
      if (dest) {
        await call_module("save_screenshot_as", { instance: shot.instance, file: shot.file, dest_path: dest });
        toast?.({ message: t("minecraft.screenshots.download_done", "Screenshot saved."), variant: "success" });
      }
    } catch (e) {
      console.error(e);
      toast?.({ message: t("minecraft.screenshots.download_failed", "Couldn't save the screenshot."), variant: "error" });
    }
    onClose();
  }

  async function remove() {
    try {
      await call_module("delete_screenshot", { instance: shot.instance, file: shot.file });
      onDeleted();
      toast?.({ message: t("minecraft.screenshots.delete_done", "Screenshot deleted."), variant: "success" });
    } catch (e) {
      console.error(e);
      toast?.({ message: `${t("minecraft.screenshots.delete_failed", "Couldn't delete the screenshot.")} ${String(e)}`, variant: "error" });
    }
    onClose();
  }

  if (confirmDelete) {
    return (
      <ConfirmModal
        isOpen
        onCancel={() => { setConfirmDelete(false); onClose(); }}
        onConfirm={remove}
        message={t("minecraft.screenshots.delete_confirm", "Delete this screenshot permanently?")}
        confirmText={t("minecraft.screenshots.delete", "Delete")}
        variant="danger"
        icon={<TrashIcon />}
        confirmIcon={<TrashIcon />}
      />
    );
  }

  return (
    <div ref={menuRef} className="modpack-context-menu" style={{ left: at.x, top: at.y }}>
      <button
        className={`screenshot-menu-pack${pack?.banner_data ? " has-banner" : ""}`}
        style={pack?.banner_data ? {
          backgroundImage: `linear-gradient(90deg, color-mix(in srgb, var(--nh-shade) 78%, transparent), color-mix(in srgb, var(--nh-shade) 30%, transparent)), url(${pack.banner_data})`,
        } : undefined}
        disabled={!pack}
        onClick={() => {
          navigate("/play", { state: { name: pack!.name, profile: pack!.profile, icon_data: pack!.icon_data, banner_data: pack!.banner_data } });
          onClose();
        }}
      >
        <img src={pack?.icon_data ?? PACKAGE} alt="" />
        <span>
          <strong>{pack?.profile.display_name || shot.instance}</strong>
          {pack && <small><LoaderLabel loader={pack.profile.core} /> · {pack.profile.version_id}</small>}
        </span>
      </button>
      <div className="screenshot-menu-time">{new Date(shot.modified * 1000).toLocaleString()}</div>
      <hr />
      <button onClick={copy} disabled={!src}>
        <CopyIcon width={16} height={16} />
        {t("minecraft.screenshots.copy", "Copy to clipboard")}
      </button>
      <button onClick={download}>
        <DownloadIcon width={16} height={16} />
        {t("minecraft.screenshots.download", "Download")}
      </button>
      <hr />
      <button className="danger" onClick={() => setConfirmDelete(true)}>
        <TrashIcon width={16} height={16} />
        {t("minecraft.screenshots.delete", "Delete")}
      </button>
    </div>
  );
}

/** The quick panel's Screenshots button opens this page: every instance's `screenshots/` folder,
 *  newest first. Clicking a picture shows it full size in a modal. */
export function ScreenshotsPage() {
  const call_module = useCallModule();
  const [shots, setShots] = useState<ScreenshotEntry[] | null>(null);
  const [viewing, setViewing] = useState<{ shot: ScreenshotEntry; src: string } | null>(null);
  const [packs, setPacks] = useState<Record<string, ModpackEntry>>({});
  const [menu, setMenu] = useState<{ x: number; y: number; shot: ScreenshotEntry; src: string | null } | null>(null);

  useEffect(() => {
    call_module("list_screenshots", {})
      .then((res: any) => setShots(Array.isArray(res) ? res : []))
      .catch(() => setShots([]));
    call_module("get_modpacks", {})
      .then((res: any) => setPacks(Object.fromEntries((Array.isArray(res) ? res : []).map((p: ModpackEntry) => [p.name, p]))))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Modpacks to show (by instance folder); none picked means all. */
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [newestFirst, setNewestFirst] = useState(true);

  /** Each modpack that has screenshots, with how many, most screenshots first. */
  const counts = useMemo(() => {
    const byPack = new Map<string, number>();
    for (const s of shots ?? []) byPack.set(s.instance, (byPack.get(s.instance) ?? 0) + 1);
    return [...byPack].sort((a, b) => b[1] - a[1]);
  }, [shots]);

  const visible = useMemo(() => {
    const list = (shots ?? []).filter((s) => picked.size === 0 || picked.has(s.instance));
    return list.sort((a, b) => (newestFirst ? b.modified - a.modified : a.modified - b.modified));
  }, [shots, picked, newestFirst]);

  const togglePack = (instance: string) => setPicked((prev) => {
    const next = new Set(prev);
    if (!next.delete(instance)) next.add(instance);
    return next;
  });

  const viewingIndex = viewing ? visible.indexOf(viewing.shot) : -1;
  /** Shows the neighbouring screenshot (its file is read on demand, like a tile's). */
  const goTo = (i: number) => {
    const shot = visible[i];
    if (!shot) return;
    call_module("get_screenshot", { instance: shot.instance, file: shot.file })
      .then((src: any) => setViewing({ shot, src }))
      .catch(() => {});
  };

  return (
    <div className="screenshots-page">
      {shots && shots.length === 0 ? (
        <p>{t("minecraft.screenshots.empty", "No screenshots yet \u2014 press F2 in game.")}</p>
      ) : (
        <>
        <div className="screenshot-toolbar">
          <div className="screenshot-filters">
            <button className={`screenshot-chip${picked.size === 0 ? " active" : ""}`} onClick={() => setPicked(new Set())}>
              {t("minecraft.screenshots.all", "All")} <small>{shots?.length ?? 0}</small>
            </button>
            {counts.map(([instance, count]) => (
              <button key={instance} className={`screenshot-chip${picked.has(instance) ? " active" : ""}`} onClick={() => togglePack(instance)}>
                <img src={packs[instance]?.icon_data ?? PACKAGE} alt="" />
                {packs[instance]?.profile.display_name || instance} <small>{count}</small>
              </button>
            ))}
          </div>
          <button className="screenshot-sort" onClick={() => setNewestFirst((v) => !v)}>
            <ChevronDownIcon width={14} height={14} style={{ transform: newestFirst ? undefined : "rotate(180deg)" }} />
            {newestFirst ? t("minecraft.screenshots.newest_first", "Newest first") : t("minecraft.screenshots.oldest_first", "Oldest first")}
          </button>
        </div>
        <div className="screenshot-grid">
          {visible.map((s) => (
            <ScreenshotTile
              key={`${s.instance}/${s.file}`}
              shot={s}
              selected={menu?.shot === s}
              onOpen={(src) => setViewing({ shot: s, src })}
              onMenu={(e, src) => setMenu({ x: e.clientX, y: e.clientY, shot: s, src })}
            />
          ))}
        </div>
        </>
      )}
      <Modal isOpen={viewing !== null} onClose={() => setViewing(null)} title="" size="full" headerless>
        {viewing && (
          <ZoomableImage
            src={viewing.src}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu({ x: e.clientX, y: e.clientY, shot: viewing.shot, src: viewing.src });
            }}
          />
        )}
        {viewing && viewingIndex >= 0 && <ViewerArrows index={viewingIndex} count={visible.length} onGo={goTo} />}
      </Modal>
      {menu && (
        <ScreenshotContextMenu
          {...menu}
          pack={packs[menu.shot.instance]}
          onClose={() => setMenu(null)}
          onDeleted={() => {
            setShots((prev) => (prev ?? []).filter((s) => s !== menu.shot));
            if (viewing?.shot === menu.shot) setViewing(null);
          }}
        />
      )}
    </div>
  );
}
