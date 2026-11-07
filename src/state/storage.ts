import { createJSONStorage, StateStorage } from "zustand/middleware";

/** Web storage can throw (blocked site data) or be missing — a persisted store must degrade to
 *  plain in-memory state then, never break the app. */
function safe(getStorage: () => Storage): StateStorage {
  return {
    getItem: (name) => { try { return getStorage().getItem(name); } catch { return null; } },
    setItem: (name, value) => { try { getStorage().setItem(name, value); } catch { /* ignore */ } },
    removeItem: (name) => { try { getStorage().removeItem(name); } catch { /* ignore */ } },
  };
}

/** Survives a page reload (F5, dev hot reload) but not closing the app — for state that is only
 *  a cache of what the backend already owns and gets re-synced from it on startup. */
export const sessionJSONStorage = createJSONStorage(() => safe(() => sessionStorage));

/** Survives app restarts — for harmless UI preferences/caches only. Never put credentials here:
 *  those are held by the backend (see `server_api.rs`). */
export const localJSONStorage = createJSONStorage(() => safe(() => localStorage));
