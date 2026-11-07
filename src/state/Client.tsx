import { create } from "zustand";
import { persist } from "zustand/middleware";
import { invoke } from "@tauri-apps/api/tauri";
import type { LocalClient } from "../launcher/UserProfile";
import { sessionJSONStorage } from "./storage";

export interface PendingDeepLink {
  gameId: string;
  kind: string;
  segments: string[];
  /** What the sender already has to hand (a home banner's modpack), so the game page need not look it up. */
  data?: unknown;
}

interface ClientState {
  /** The launcher profile from `local.data` (owned by the backend). */
  localClient: LocalClient | null;
  /**
   * True once it is known whether a local profile exists; `localClient` null alone is ambiguous
   * (still loading vs. none yet).
   */
  localClientLoaded: boolean;
  /**
   * A `nihaolauncher://<gameId>/<kind>/...` deep link resolved by `App.tsx` that the target game's
   * `GameLoader` has not picked up yet (see `deeplink.rs`).
   */
  pendingDeepLink: PendingDeepLink | null;

  setLocalClient: (localClient: LocalClient | null) => void;
  markLocalClientLoaded: () => void;
  setPendingDeepLink: (link: PendingDeepLink | null) => void;
  /** Re-reads `local.data` from the backend (the source of truth). */
  hydrate: () => Promise<void>;
}

export const useClientStore = create<ClientState>()(
  persist(
    (set) => ({
      localClient: null,
      localClientLoaded: false,
      pendingDeepLink: null,

      setLocalClient: (localClient) => set({ localClient }),
      markLocalClientLoaded: () => set({ localClientLoaded: true }),
      setPendingDeepLink: (pendingDeepLink) => set({ pendingDeepLink }),

      async hydrate() {
        try {
          const profile = await invoke<LocalClient>("init_local_data", {});
          set({ localClient: profile, localClientLoaded: true });
        } catch (e) {
          console.info(`Error init localdata: ${e}`);
          set({ localClient: null, localClientLoaded: true });
        }
      },
    }),
    {
      name: "nihao:client",
      // sessionStorage: survives a reload but not the app, so what's found at startup always means
      // a mid-session reload, never a fresh launch (where `InitPage` must run its own startup
      // flow).
      storage: sessionJSONStorage,
      // Display cache for the first paint after a reload; `hydrate()` restores the profile from
      // the backend (source of truth).
      partialize: (s) => ({ localClient: s.localClient }),
      onRehydrateStorage: () => (state) => {
        if (state?.localClient) state.hydrate();
      },
    },
  ),
);

// Every `local.data` load/change passes through here; keeps the Rust-side Discord presence in sync
// with `interface.discord_presence_enabled`.
useClientStore.subscribe((state, prev) => {
  const enabled = !!state.localClient?.interface.discord_presence_enabled;
  if (state.localClient !== prev.localClient) {
    invoke("discord_presence_set_enabled", { enabled }).catch(() => {});
  }
});

/**
 * Master animations switch (Settings > General). CSS handles it via `<html
 * data-animations="off">`; JS-driven animation (timers, remounting layers) reads this hook and
 * skips.
 */
export const useAnimationsEnabled = (): boolean =>
  useClientStore((s) => s.localClient?.interface.animations_enabled !== false);

function applyAnimationsSetting(enabled: boolean) {
  document.documentElement.dataset.animations = enabled ? "on" : "off";
}
applyAnimationsSetting(useClientStore.getState().localClient?.interface.animations_enabled !== false);
useClientStore.subscribe((state, prev) => {
  const on = state.localClient?.interface.animations_enabled !== false;
  if (on !== (prev.localClient?.interface.animations_enabled !== false)) applyAnimationsSetting(on);
});

/** Same shape the old `ClientContext` exposed, so existing call sites keep working unchanged. */
export function useClient() {
  return useClientStore();
}
