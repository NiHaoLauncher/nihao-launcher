import { create } from "zustand";
import { invoke } from "@tauri-apps/api/tauri";
import { listen } from "@tauri-apps/api/event";

/** A release (`UpdateInfo` in updater.rs). */
export interface UpdateInfo {
  version: string;
  description: string;
}

interface UpdateState {
  /** The newer release, or `null` when this build is the latest (or the check failed). */
  available: UpdateInfo | null;
  /** When the last check succeeded (ms), `null` before the first. */
  checkedAt: number | null;
  /** Download/unpack progress 0-100 while installing, otherwise `null`. */
  progress: number | null;
  check: () => Promise<void>;
  install: () => Promise<void>;
}

export const useUpdate = create<UpdateState>((set, get) => ({
  available: null,
  checkedAt: null,
  progress: null,
  async check() {
    try {
      set({ available: await invoke<UpdateInfo | null>("check_for_update", {}), checkedAt: Date.now() });
    } catch (e) {
      console.warn(`Update check failed: ${e}`);
    }
  },
  /** Downloads and installs the update, then restarts the launcher; throws when it fails. */
  async install() {
    if (!get().available || get().progress !== null) return;
    set({ progress: 0 });
    const unlisten = await listen<{ current: number; total: number }>("update-progress", (e) =>
      set({ progress: e.payload.total ? Math.round((e.payload.current / e.payload.total) * 100) : 0 }),
    );
    try {
      await invoke("install_update", {});
    } catch (e) {
      set({ progress: null });
      throw e;
    } finally {
      unlisten();
    }
    await invoke("relaunch_app", {});
  },
}));

const RECHECK_MS = 30 * 60 * 1000;
let timer: ReturnType<typeof setInterval> | undefined;

/** Starts the periodic update check (once). */
export function startUpdateChecks() {
  if (timer) return;
  void useUpdate.getState().check();
  timer = setInterval(() => void useUpdate.getState().check(), RECHECK_MS);
}
