import { create } from "zustand";
import { invoke } from "@tauri-apps/api/tauri";
import { GameConfig, getGameConfig, loadGameSettings } from "../games/GameRegistry";

export type GameUiStatus = "idle" | "loading" | "ready" | "error";

export interface GameEntry {
  config?: GameConfig;
  /** This game's saved values from the general "Game settings" tab (`game.nihao`). */
  settings?: Record<string, any>;
  ui: { status: GameUiStatus; tag?: string; error?: string };
}

interface GamesState {
  /** Ids of the loaded game modules (`null` until first asked for). */
  modules: string[] | null;
  /** The module being developed live (`DEV_MODULE`), if any. */
  devModule: string | null;
  /** Fetches the module list once; every caller shares the result. */
  loadModules: () => Promise<void>;
  games: Record<string, GameEntry>;
  loadConfig: (id: string) => Promise<void>;
  /** Registers the module's custom element (once per session outside dev mode). */
  loadUi: (id: string) => Promise<void>;
  loadSettings: (id: string, path: string | undefined) => Promise<void>;
}

const EMPTY: GameEntry = { ui: { status: "idle" } };

export const useGames = create<GamesState>((set, get) => {
  const patch = (id: string, change: (e: GameEntry) => GameEntry) =>
    set((s) => ({ games: { ...s.games, [id]: change(s.games[id] ?? EMPTY) } }));

  // Latest settings request per game, so a slow load for an old path can't overwrite a newer one.
  const settingsRequest: Record<string, number> = {};
  const uiLoading: Record<string, Promise<void>> = {};

  async function doLoadUi(id: string) {
    try {
      const stableTag = `${id}-ui`;
      const devModule = (await invoke("get_dev_module").catch(() => null)) as string | null;
      const isDev = devModule === id;

      if (!isDev && customElements.get(stableTag)) {
        patch(id, (e) => ({ ...e, ui: { status: "ready", tag: stableTag } }));
        return;
      }

      // Dev: a fresh unique tag per load (a custom element can't be redefined); production reuses
      // a stable tag.
      const tag = isDev ? `${stableTag}-${Date.now()}` : stableTag;
      const uiCode = (await invoke("get_module_ui", { module: id, tag })) as string;

      const script = document.createElement("script");
      script.type = "module";
      script.text = uiCode;
      document.head.appendChild(script);

      await customElements.whenDefined(tag);
      patch(id, (e) => ({ ...e, ui: { status: "ready", tag } }));
    } catch (err) {
      console.error(`Failed to load UI for game ${id}:`, err);
      patch(id, (e) => ({ ...e, ui: { status: "error", error: String(err) } }));
    }
  }

  let modulesLoading: Promise<void> | null = null;

  return {
    modules: null,
    devModule: null,
    games: {},

    loadModules() {
      if (get().modules) return Promise.resolve();
      modulesLoading ??= (async () => {
        const [modules, devModule] = await Promise.all([
          invoke<string[]>("list_modules").catch(() => [] as string[]),
          invoke<string | null>("get_dev_module").catch(() => null),
        ]);
        set({ modules, devModule });
      })().finally(() => { modulesLoading = null; });
      return modulesLoading;
    },

    async loadConfig(id) {
      if (get().games[id]?.config) return;
      const config = await getGameConfig(id);
      patch(id, (e) => ({ ...e, config }));
    },

    loadUi(id) {
      const status = get().games[id]?.ui.status;
      // Dev mode reloads on every visit (picks up a rebuilt UI); everything else loads once.
      if (status === "loading") return uiLoading[id];
      if (status !== "ready") patch(id, (e) => ({ ...e, ui: { status: "loading", tag: e.ui.tag } }));
      const p = doLoadUi(id).finally(() => { delete uiLoading[id]; });
      uiLoading[id] = p;
      return p;
    },

    async loadSettings(id, path) {
      const request = (settingsRequest[id] ?? 0) + 1;
      settingsRequest[id] = request;
      if (!path) {
        patch(id, (e) => ({ ...e, settings: undefined }));
        return;
      }
      const settings = await loadGameSettings(id, path);
      if (settingsRequest[id] !== request) return;
      patch(id, (e) => ({ ...e, settings }));
    },
  };
});
