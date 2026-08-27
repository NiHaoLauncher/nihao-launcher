import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/tauri";

export interface InstallProgressEntry {
  name: string;
  etap: string;
  current_etaps: number;
  total_etaps: number;
  current_file: number;
  total_files: number;
  status: string;
  filename: string;
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

/**
 * Polls every loaded module's `get_install_status` for background installs in progress.
 * Modules that don't implement it just fail the call, which is silently ignored — not
 * every module is expected to support this.
 */
export function useInstallStatus(modules: string[]): InstallEntry[] {
  const [installs, setInstalls] = useState<InstallEntry[]>([]);

  useEffect(() => {
    if (modules.length === 0) {
      setInstalls([]);
      return;
    }
    let cancelled = false;

    const poll = async () => {
      const results = await Promise.all(modules.map((mod) =>
        invoke("call_module", { module: mod, method: "get_install_status", args: {} })
          .then((res: any) => ({
            module: mod,
            entries: (Array.isArray(res?.installing) ? res.installing : []) as InstallProgressEntry[],
          }))
          .catch(() => ({ module: mod, entries: [] as InstallProgressEntry[] }))
      ));
      if (cancelled) return;
      setInstalls(results.flatMap(({ module, entries }) => entries.map((progress) => ({ module, progress }))));
    };

    poll();
    const interval = setInterval(poll, 1500);
    return () => { cancelled = true; clearInterval(interval); };
  }, [modules]);

  return installs;
}
