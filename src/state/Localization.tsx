import { create } from "zustand";
import { persist } from "zustand/middleware";
import { sessionJSONStorage } from "./storage";
import { invoke } from "@tauri-apps/api/tauri";
import { deepResolveTranslations } from "@shared/components/Translate";
import type { Lang } from "@shared";

interface LocalizationState {
  /**
   * The active dictionary: the launcher's keys plus every loaded module's, merged by the backend's
   * `get_lang`.
   */
  language: Lang | null;
  /**
   * Bumps whenever the dictionary is replaced. `t()`/`T` read a global and subscribe to nothing,
   * so anything showing text subscribes to this to re-render.
   */
  revision: number;
  /** Fetches language `id` from the backend and makes it active. */
  load: (id: string) => Promise<void>;
}

export const useLocalization = create<LocalizationState>()(
  persist(
    (set) => ({
  language: null,
  revision: 0,

  async load(id) {
    console.info(`Initialization language(${id}) ...`);
    try {
      const data = await invoke<Record<string, any>>("get_lang", { id });
      set((s) => ({
        language: deepResolveTranslations({ ...data, id } as Lang),
        revision: s.revision + 1,
      }));
    } catch (e) {
      console.error(`Failed to load language "${id}":`, e);
    }
  },
    }),
    {
      name: "nihao:language",
      // sessionStorage: survives a reload so the first paint is translated; the dictionary is
      // re-fetched on restore so an edited `lang/*.json` isn't stale.
      storage: sessionJSONStorage,
      partialize: (s) => ({ language: s.language }),
      onRehydrateStorage: () => (state) => {
        if (state?.language?.id) state.load(state.language.id);
      },
    },
  ),
);

// `t()`/`T` read `window.__NIHAO_I18N__` because the shared library is also bundled into game
// modules that can't see this store. A store subscription runs inside `set()`, before React
// re-renders readers, so the global is always current. Also runs once for the restored language.
function syncGlobal(language: Lang | null) {
  if (typeof window !== "undefined") window.__NIHAO_I18N__ = language as any;
}
syncGlobal(useLocalization.getState().language);
useLocalization.subscribe((state, prev) => {
  if (state.language !== prev.language) syncGlobal(state.language);
});
