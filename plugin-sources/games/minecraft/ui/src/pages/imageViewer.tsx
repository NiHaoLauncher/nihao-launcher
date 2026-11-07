// Pieces for looking at and saving images (screenshots, a project's gallery).
import { useEffect, useRef, useState } from "react";
import { save as saveFileDialog } from "@tauri-apps/api/dialog";
import { t } from "@shared/components/Translate";
import { useCallModule } from "@shared/modules";
import { useBridge } from "@shared";
import DownloadIcon from "@shared/assets/icons/download.svg?react";
import CopyIcon from "@shared/assets/icons/copy.svg?react";
import { useDismiss, useOnScreen } from "./hooks";

/** PNG of any image `src` (a data URI, or a remote URL fetched first): the clipboard only takes PNG. */
export async function imageToPngBlob(src: string): Promise<Blob> {
  let url = src;
  let objectUrl: string | null = null;
  if (/^https?:/.test(src)) {
    objectUrl = URL.createObjectURL(await (await fetch(src)).blob());
    url = objectUrl;
  }
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    canvas.getContext("2d")!.drawImage(img, 0, 0);
    return await new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject()), "image/png"));
  } finally {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  }
}

const MIN_ZOOM = 1;
const MAX_ZOOM = 8;
const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));

/**
 * A full-size picture you can zoom: the wheel zooms towards the cursor, dragging moves a zoomed
 * picture, a double click toggles between fitting the window and 2.5x, and + - 0 do the same. The
 * buttons show only while zoomed. A different `src` starts fitted again.
 */
export function ZoomableImage({ src, onContextMenu }: { src: string; onContextMenu?: (e: React.MouseEvent) => void }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ zoom: 1, x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; from: { x: number; y: number } } | null>(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => setView({ zoom: 1, x: 0, y: 0 }), [src]);

  /** Zooms to `zoom`, keeping the point at (`cx`, `cy`) from the box's centre where it is. */
  const zoomTo = (zoom: number, cx = 0, cy = 0) => setView((v) => {
    const next = clampZoom(zoom);
    if (next === MIN_ZOOM) return { zoom: 1, x: 0, y: 0 };
    const k = next / v.zoom;
    return { zoom: next, x: cx - (cx - v.x) * k, y: cy - (cy - v.y) * k };
  });

  // Native listener: React's wheel handler is passive and cannot stop the page scrolling.
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = box.getBoundingClientRect();
      setView((v) => {
        const next = clampZoom(v.zoom * Math.exp(-e.deltaY * 0.0015));
        if (next === MIN_ZOOM) return { zoom: 1, x: 0, y: 0 };
        const cx = e.clientX - rect.left - rect.width / 2;
        const cy = e.clientY - rect.top - rect.height / 2;
        const k = next / v.zoom;
        return { zoom: next, x: cx - (cx - v.x) * k, y: cy - (cy - v.y) * k };
      });
    };
    box.addEventListener("wheel", onWheel, { passive: false });
    return () => box.removeEventListener("wheel", onWheel);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "+" || e.key === "=") zoomTo(view.zoom * 1.5);
      if (e.key === "-") zoomTo(view.zoom / 1.5);
      if (e.key === "0") zoomTo(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <div
      ref={boxRef}
      className={`zoom-box${view.zoom > 1 ? " zoomed" : ""}${dragging ? " dragging" : ""}`}
      onMouseDown={(e) => {
        if (e.button !== 0 || view.zoom === 1) return;
        drag.current = { x: e.clientX, y: e.clientY, from: { x: view.x, y: view.y } };
        setDragging(true);
      }}
      onMouseMove={(e) => {
        const d = drag.current;
        if (d) setView((v) => ({ ...v, x: d.from.x + e.clientX - d.x, y: d.from.y + e.clientY - d.y }));
      }}
      onMouseUp={() => { drag.current = null; setDragging(false); }}
      onMouseLeave={() => { drag.current = null; setDragging(false); }}
      onDoubleClick={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        if (view.zoom > 1) zoomTo(1);
        else zoomTo(2.5, e.clientX - rect.left - rect.width / 2, e.clientY - rect.top - rect.height / 2);
      }}
      onContextMenu={onContextMenu}
    >
      <img
        src={src}
        alt=""
        draggable={false}
        style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})` }}
      />
      {view.zoom > 1 && (
        <div className="zoom-controls" onMouseDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
          <button onClick={() => zoomTo(view.zoom / 1.5)} aria-label={t("minecraft.viewer.zoom_out", "Zoom out")}>−</button>
          <button className="zoom-level" onClick={() => zoomTo(1)} title={t("minecraft.screenshots.zoom_reset", "Fit to window")}>{Math.round(view.zoom * 100)}%</button>
          <button onClick={() => zoomTo(view.zoom * 1.5)} disabled={view.zoom >= MAX_ZOOM} aria-label={t("minecraft.viewer.zoom_in", "Zoom in")}>+</button>
        </div>
      )}
    </div>
  );
}

/** Previous/next buttons (and the arrow keys) for a full-size viewer over `count` pictures. */
export function ViewerArrows({ index, count, onGo }: { index: number; count: number; onGo: (index: number) => void }) {
  const go = useRef(onGo);
  go.current = onGo;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft" && index > 0) go.current(index - 1);
      if (e.key === "ArrowRight" && index < count - 1) go.current(index + 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, count]);
  return (
    <>
      {index > 0 && <button className="viewer-arrow viewer-arrow-prev" onClick={() => onGo(index - 1)} aria-label={t("minecraft.viewer.previous", "Previous")}>‹</button>}
      {index < count - 1 && <button className="viewer-arrow viewer-arrow-next" onClick={() => onGo(index + 1)} aria-label={t("minecraft.viewer.next", "Next")}>›</button>}
    </>
  );
}

/** Right-click menu of a modpack gallery picture (a remote URL): copy to clipboard, save as file. */
export function GalleryImageMenu({ x, y, url, service, onClose }: { x: number; y: number; url: string; service: string; onClose: () => void }) {
  const call_module = useCallModule();
  const menuRef = useRef<HTMLDivElement>(null);
  const toast = useBridge((b) => b.toast);
  useDismiss(menuRef, onClose);
  const at = useOnScreen(menuRef, x, y);

  async function copy() {
    try {
      await navigator.clipboard.write([new ClipboardItem({ "image/png": await imageToPngBlob(url) })]);
      toast?.({ message: t("minecraft.market.copy_done", "Image copied to the clipboard."), variant: "success" });
    } catch (e) {
      console.error(e);
      toast?.({ message: t("minecraft.market.copy_failed", "Couldn't copy the image."), variant: "error" });
    }
    onClose();
  }

  async function download() {
    try {
      const dest = await saveFileDialog({ defaultPath: decodeURIComponent(url.split("/").pop() ?? "image.png") });
      if (dest) {
        await call_module("save_remote_image", { service, url, dest_path: dest });
        toast?.({ message: t("minecraft.market.download_done", "Image saved."), variant: "success" });
      }
    } catch (e) {
      console.error(e);
      toast?.({ message: t("minecraft.market.download_failed", "Couldn't save the image."), variant: "error" });
    }
    onClose();
  }

  return (
    <div ref={menuRef} className="modpack-context-menu" style={{ left: at.x, top: at.y }}>
      <button onClick={copy}>
        <CopyIcon width={16} height={16} />
        {t("minecraft.screenshots.copy", "Copy to clipboard")}
      </button>
      <button onClick={download}>
        <DownloadIcon width={16} height={16} />
        {t("minecraft.screenshots.download", "Download")}
      </button>
    </div>
  );
}