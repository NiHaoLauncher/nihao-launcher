import type { ReactNode } from "react";
import { create } from "zustand";
import { invoke } from "@tauri-apps/api/tauri";
import { applyTheme } from "@shared/theme/apply";
import { ThemeSlotsContext } from "@shared/theme/slotsContext";
import type { LauncherTheme } from "@shared/theme/types";
import { buildSimpleTheme, simpleTheme } from "../themes/simple";
import { fetchThemeBundle, instantiateTheme, listThemes, type ThemeBundle, type ThemeInfo } from "../themes/external";
import { useClientStore } from "./Client";

/** The theme that ships inside the launcher (everything else is a folder theme). */
export const BUILTIN_THEMES: LauncherTheme[] = [simpleTheme];

interface ThemeState {
  /** The theme in effect right now. */
  theme: LauncherTheme;
  /** The themes found in the `themes/` folder (the built-in ones aren't listed here). */
  available: ThemeInfo[];
  /** Started with `--safe-mode`: the saved theme is ignored and the built-in one is used. */
  safeMode: boolean;
  /** Why the last attempt to apply a theme fell back to the built-in one, if it did. */
  error: string | null;
  setTheme: (theme: LauncherTheme) => void;
  /** Re-reads the `themes/` folder. */
  refresh: () => Promise<void>;
  /**
   * Applies theme `id` (`null`/`"simple"` = built-in). A folder theme only runs if its bundle
   * still hashes to what the user approved (`trusted_themes`); any failure keeps the built-in
   * theme and records `error`. Never throws.
   */
  activate: (id: string | null) => Promise<void>;
  /**
   * Rebuilds the active folder theme with other setting values as a live preview (nothing saved).
   * No-op for the built-in theme or one that failed to load.
   */
  previewSettings: (values: Record<string, unknown>) => void;
  /**
   * Theme card clicked in Settings > Appearance but not saved yet (`null` = none). Kept here
   * because switching theme can remount the tab and drop its local state.
   */
  pendingId: string | null;
  setPendingId: (id: string | null) => void;
  /** Throws away an unsaved preview (the chosen theme and any edited settings): back to what is saved. */
  discardPreview: () => void;
}

/** Settings edited live (previewed) but not saved yet. */
let previewedSettings = false;

/** The bundle behind the folder theme in effect, kept so its settings can be changed live. */
let activeBundle: ThemeBundle | null = null;

/** The id last passed to `activate`; `undefined` until the first time. */
let lastActivated: string | null | undefined;
/** Newer `activate` calls win over older ones that are still loading. */
let activation = 0;

export const useTheme = create<ThemeState>((set) => ({
  theme: simpleTheme,
  available: [],
  safeMode: false,
  error: null,

  setTheme: (theme) => set({ theme }),

  pendingId: null,
  setPendingId: (pendingId) => set({ pendingId }),

  discardPreview() {
    const hadPreview = useTheme.getState().pendingId !== null || previewedSettings;
    previewedSettings = false;
    set({ pendingId: null });
    if (!hadPreview) return;
    const saved = useClientStore.getState().localClient?.interface.theme ?? null;
    void useTheme.getState().activate(saved);
  },

  previewSettings(values) {
    previewedSettings = true;
    if (!activeBundle) {
      if (useTheme.getState().theme.id === simpleTheme.id) set({ theme: buildSimpleTheme(values) });
      return;
    }
    try {
      set({ theme: instantiateTheme(activeBundle, values), error: null });
    } catch (e) {
      console.error("Theme settings could not be applied:", e);
    }
  },

  async refresh() {
    try {
      set({ available: await listThemes() });
    } catch (e) {
      console.error("Could not list themes:", e);
      set({ available: [] });
    }
  },

  async activate(id) {
    const wanted = id && id !== simpleTheme.id ? id : null;
    lastActivated = wanted;
    previewedSettings = false;
    const mine = ++activation;

    if (!wanted) {
      activeBundle = null;
      const saved = useClientStore.getState().localClient?.interface.theme_settings?.[simpleTheme.id];
      set({ theme: buildSimpleTheme(saved), error: null });
      return;
    }
    try {
      const bundle = await fetchThemeBundle(wanted);
      const approved = useClientStore.getState().localClient?.interface.trusted_themes?.[wanted];
      if (approved !== bundle.info.hash) {
        throw new Error(approved ? "the theme file changed since it was approved" : "the theme has not been approved yet");
      }
      const saved = useClientStore.getState().localClient?.interface.theme_settings?.[wanted];
      const theme = instantiateTheme(bundle, saved);
      if (mine === activation) {
        activeBundle = bundle;
        set({ theme, error: null });
      }
    } catch (e) {
      console.error(`Theme "${wanted}" could not be applied:`, e);
      if (mine === activation) {
        activeBundle = null;
        set({ theme: buildSimpleTheme(useClientStore.getState().localClient?.interface.theme_settings?.[simpleTheme.id]), error: `${wanted}: ${e instanceof Error ? e.message : String(e)}` });
      }
    }
  },
}));

// Applied at module load, before React renders, so no frame is drawn with the wrong theme.
applyTheme(useTheme.getState().theme);
useTheme.subscribe((state, prev) => {
  if (state.theme !== prev.theme) applyTheme(state.theme);
});

// The saved theme (`interface.theme`) applies once the profile is known and follows changes; safe
// mode ignores it.
let safeModeKnown = false;
function syncSavedTheme() {
  const state = useTheme.getState();
  if (!safeModeKnown || state.safeMode) return;
  const profile = useClientStore.getState().localClient;
  if (!profile) return;
  const saved = profile.interface.theme ?? null;
  if (saved !== lastActivated) void state.activate(saved);
}
invoke<boolean>("is_safe_mode")
  .catch(() => false)
  .then((safe) => {
    useTheme.setState({ safeMode: safe });
    safeModeKnown = true;
    syncSavedTheme();
  });
useClientStore.subscribe(syncSavedTheme);

const NO_SLOTS = {};

/** Hands the active theme's replacement components to everything below it (the main window, every
 *  modal). Wrap the app once, near the root. */
export function ThemeSlotsProvider({ children }: { children: ReactNode }) {
  const slots = useTheme((s) => s.theme.slots) ?? NO_SLOTS;
  return <ThemeSlotsContext.Provider value={slots}>{children}</ThemeSlotsContext.Provider>;
}
