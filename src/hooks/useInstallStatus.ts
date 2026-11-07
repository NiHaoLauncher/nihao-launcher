import { useEffect } from "react";
import { create } from "zustand";
import { keepIfSame } from "../state/same";
import { invoke } from "@tauri-apps/api/tauri";

/**
 * Coarse job kind a module can tag its `.progress` entries with, stable across modules unlike the
 * free-text `etap`/`status`. `"deleting"` and `"update"` are reserved; `"unknown"` covers anything
 * that is neither download nor upload. A missing or unrecognized value is treated as unknown.
 */
export type InstallJobType = "download" | "upload" | "deleting" | "repair" | "update" | "unknown";

export interface InstallProgressEntry {
  name: string;
  etap: string;
  current_etaps: number;
  total_etaps: number;
  current_file: number;
  total_files: number;
  status: string;
  filename: string;
  type?: InstallJobType;
}

export interface InstallEntry {
  module: string;
  progress: InstallProgressEntry;
}

/** Progress within the *current* etap (e.g. file N/M of the "Library" step), 0-100. */
export function computeEtapPercent(p: InstallProgressEntry): number {
  if (p.total_files > 0) {
    return Math.max(0, Math.min(100, Math.round((p.current_file / p.total_files) * 100)));
  }
  return p.status === "extract" || p.status === "skip" ? 100 : 30;
}

/** Overall progress across every etap (Java/Library/Native/Assets/Client), 0-100. */
export function computeOverallPercent(p: InstallProgressEntry): number {
  if (p.total_etaps <= 0) return 0;
  const etapFraction = computeEtapPercent(p) / 100;
  const overall = (Math.max(0, p.current_etaps - 1) + etapFraction) / p.total_etaps;
  return Math.max(0, Math.min(100, Math.round(overall * 100)));
}

interface InstallsState {
  installs: InstallEntry[];
}

export const useInstalls = create<InstallsState>(() => ({ installs: [] }));

const POLL_MS = 1500;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let polledModules: string[] = [];

async function pollOnce(modules: string[]) {
  const results = await Promise.all(modules.map((mod) =>
    invoke("call_module", { module: mod, method: "get_install_status", args: {} })
      .then((res: any) => ({
        module: mod,
        entries: (Array.isArray(res?.installing) ? res.installing : []) as InstallProgressEntry[],
      }))
      .catch(() => ({ module: mod, entries: [] as InstallProgressEntry[] }))
  ));
  if (modules !== polledModules) return;
  const next = results.flatMap(({ module, entries }) => entries.map((progress) => ({ module, progress })));
  // Same content -> same reference -> zustand notifies nobody, no component re-renders.
  useInstalls.setState((s) => ({ installs: keepIfSame(s.installs, next) }));
}

/** (Re)starts the single app-wide poller for these modules (or stops it for an empty list). */
function setPolledModules(modules: string[]) {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  polledModules = modules;
  if (modules.length === 0) {
    useInstalls.setState((s) => ({ installs: keepIfSame(s.installs, []) }));
    return;
  }
  const tick = () => { if (!document.hidden) pollOnce(modules); };
  tick();
  pollTimer = setInterval(tick, POLL_MS);
}

/**
 * Background installs in progress across loaded modules (those without `get_install_status` are
 * skipped). One app-wide poller; the list changes identity only when its content does (see
 * `keepIfSame`).
 */
export function useInstallStatus(modules: string[]): InstallEntry[] {
  const key = modules.join("\n");
  useEffect(() => {
    setPolledModules(modules);
    return () => setPolledModules([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return useInstalls((s) => s.installs);
}
