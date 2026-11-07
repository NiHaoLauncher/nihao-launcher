// Hooks shared by the pages: the game path, who is signed in, instances, install progress.
import { useEffect, useRef, useState, useLayoutEffect } from "react";
import { useCallModule } from "@shared/modules";
import { useBridge } from "@shared";
import { ModpackEntry } from "./types";
import { overallPercent } from "./helpers";

/** The configured install path from Settings, falling back to the plugin's own default. */
export function useGamePath(): string | undefined {
  const call_module = useCallModule();
  const gamePath = useBridge((b) => b.gamePath);
  const [fallback, setFallback] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (gamePath) return;
    call_module("get_config", {})
      .then((cfg: any) => setFallback(cfg?.defaultPath))
      .catch(console.error);
  }, [gamePath]);

  return gamePath ?? fallback;
}

/**
 * Whether the launcher account is signed in (needed for the module's own session-authenticated
 * endpoints, see `library::online_modpacks`).
 */
export function useSignedIn(): boolean {
  const signedIn = useBridge((b) => b.signedIn);
  return !!signedIn;
}

/**
 * `GET /minecraft/modpacks/permissions`: `minecraft.modpacks.view`/`.create` aren't granted to
 * non-developers by default (see API.md), so the UI hides the Public tab and "Publish to NiHao" up
 * front instead of showing a raw 403.
 */
export function useModpackPermissions(): { canView: boolean; canCreate: boolean } {
  const call_module = useCallModule();
  const signedIn = useSignedIn();
  const [permissions, setPermissions] = useState({ canView: false, canCreate: false });

  useEffect(() => {
    if (!signedIn) {
      setPermissions({ canView: false, canCreate: false });
      return;
    }
    let cancelled = false;
    call_module("get_modpack_permissions", {})
      .then((res: any) => {
        if (!cancelled) setPermissions({ canView: !!res?.can_view, canCreate: !!res?.can_create });
      })
      .catch(() => { if (!cancelled) setPermissions({ canView: false, canCreate: false }); });
    return () => { cancelled = true; };
  }, [signedIn]);

  return permissions;
}

/**
 * The plugin's background image as a base64 data URI from `get_config()`, not via the `nihao://`
 * protocol: Tauri 1.x's custom-protocol path is unreliable for larger files on Windows/WebView2
 * (see `asset_data_uri` in lib.rs).
 */
export function useBackgroundImage(): string | undefined {
  const call_module = useCallModule();
  const [background, setBackground] = useState<string | undefined>(undefined);

  useEffect(() => {
    call_module("get_config", {})
      .then((cfg: any) => setBackground(cfg?.background))
      .catch(console.error);
  }, []);

  return background;
}

/**
 * Any other embedded asset (`get_asset` in lib.rs) as a base64 data URI. A plain `import
 * "./assets/..."` breaks in dev mode, where the UI is `import()`-ed from the Vite dev server into
 * the launcher window and the URL resolves against the launcher's origin. `path` is relative to
 * `ui/src/assets/`.
 */
export function useAssetIcon(path: string): string | undefined {
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

/**
 * Loader icons (`assets/minecraft/loaders/<id>.svg`), fetched once per loader via `get_asset`.
 * Unknown loaders resolve to undefined.
 */
export const loaderIconCache = new Map<string, Promise<string | undefined>>();

/** The general "Game settings" RAM allocation — used at launch for instances that have
 *  "use custom RAM" turned off, and shown as a hint while that toggle is off. */
export function useGeneralRam(): number | undefined {
  const call_module = useCallModule();
  const gameSettings = useBridge((b) => b.gameSettings);
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

export function useInstances(gamePath: string | undefined) {
  const call_module = useCallModule();
  const [instances, setInstances] = useState<ModpackEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const loadedOnce = useRef(false);

  // "Loading..." only on the first fetch; later reloads keep the grid visible.
  const reload = () => {
    if (!gamePath) return;
    if (!loadedOnce.current) setLoading(true);
    call_module("get_modpacks", {})
      .then((res: any) => { loadedOnce.current = true; setInstances(Array.isArray(res) ? res : []); })
      .catch(console.error)
      .finally(() => setLoading(false));
  };

  useEffect(reload, [gamePath]);

  const refresh = () => {
    if (!gamePath) return;
    call_module("get_modpacks", {}).then((res: any) => setInstances(Array.isArray(res) ? res : [])).catch(console.error);
  };

  return { instances, loading, reload, refresh };
}

/** Closes a context menu on a click outside it or on Escape. */
/** Where a menu opened at (`x`, `y`) goes so it stays inside the window: measured before it is painted. */
export function useOnScreen(ref: React.RefObject<HTMLElement | null>, x: number, y: number) {
  const [at, setAt] = useState({ x, y });
  useLayoutEffect(() => {
    const box = ref.current?.getBoundingClientRect();
    if (!box) return;
    setAt({
      x: Math.max(8, Math.min(x, window.innerWidth - box.width - 8)),
      y: Math.max(8, Math.min(y, window.innerHeight - box.height - 8)),
    });
  }, [x, y]);
  return at;
}

export function useDismiss(ref: React.RefObject<HTMLElement | null>, onClose: () => void) {
  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);
}

/**
 * Instances with a background job (install/import/repair) running now, with their overall progress
 * 0-100 (same `get_install_status` as the bottom bar). Calls `onFinished` when one stops so the
 * list picks up the result.
 */
export function useInstallingNames(onFinished: () => void): Map<string, number> {
  const call_module = useCallModule();
  const toast = useBridge((b) => b.toast);
  const [jobs, setJobs] = useState<Map<string, number>>(new Map());
  const finishedRef = useRef(onFinished);
  finishedRef.current = onFinished;
  /** Jobs seen running at the last poll: one that vanished with the error named after it failed. */
  const seenRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    let stopped = false;
    const tick = async () => {
      if (document.hidden) return;
      try {
        const res: any = await call_module("get_install_status", {});
        if (stopped) return;
        const next = new Map<string, number>(
          (Array.isArray(res?.installing) ? res.installing : []).map((p: any): [string, number] => [String(p?.name), overallPercent(p)])
        );
        for (const name of seenRef.current) {
          if (!next.has(name) && res?.lastError?.name === name) {
            toast?.({ message: `${name}: ${String(res.lastError.error ?? "Install failed.")}`, variant: "error" });
          }
        }
        seenRef.current = new Set(next.keys());
        setJobs((prev) => {
          if (prev.size === next.size && [...prev].every(([n, v]) => next.get(n) === v)) return prev;
          if ([...prev.keys()].some((n) => !next.has(n))) finishedRef.current();
          return next;
        });
      } catch { /* module not ready yet */ }
    };
    tick();
    const id = setInterval(tick, 1500);
    return () => { stopped = true; clearInterval(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return jobs;
}

/**
 * Which pack ids this account owns among those it can see; picks the "you own this" crown over the
 * cloud badge on a downloaded tile (`ModpackBadge`). Empty (not an error) when signed out, without
 * `minecraft.modpacks.view`, or when the fetch fails.
 */
export function useOwnedPackIds(): { ownedIds: Set<string>; catalogIds: Set<string> | null } {
  const call_module = useCallModule();
  const signedIn = useSignedIn();
  const [ownedIds, setOwnedIds] = useState<Set<string>>(new Set());
  // Every pack id the server still lists for this account; `null` = unknown (signed out / fetch failed).
  const [catalogIds, setCatalogIds] = useState<Set<string> | null>(null);
  useEffect(() => {
    if (!signedIn) { setOwnedIds(new Set()); setCatalogIds(null); return; }
    let cancelled = false;
    call_module("list_online_modpacks", { images: false })
      .then((res: any) => {
        if (cancelled) return;
        const owned = Array.isArray(res) ? res.filter((mp: any) => mp?.is_owner).map((mp: any) => mp.id) : [];
        setOwnedIds(new Set(owned));
        setCatalogIds(Array.isArray(res) ? new Set(res.map((mp: any) => mp.id)) : null);
      })
      .catch(() => { if (!cancelled) { setOwnedIds(new Set()); setCatalogIds(null); } });
    return () => { cancelled = true; };
  }, [signedIn]);
  return { ownedIds, catalogIds };
}
