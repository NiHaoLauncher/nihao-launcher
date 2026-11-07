import { SettingsField } from "./Games";
import { invoke } from "@tauri-apps/api/tauri";

/** What a module says about itself in Settings > About. */
export interface GameAbout {
  version?: string;
  description?: string;
  links?: { label: string; url: string }[];
  /** Parts shipped with the module (e.g. a game mod), listed inside its card. */
  components?: (GameAbout & { name: string })[];
}

export interface GameConfig {
  name: string;
  /** Small square badge — mainbar tile, games menu thumbnails. Falls back to `banner` (and
   *  then to text initials) for a plugin that hasn't added a dedicated icon yet. */
  icon?: string;
  banner: string;
  /** Full-page backdrop, e.g. the plugin's own launch screen. Optional — not every plugin needs one. */
  background?: string;
  defaultPath: string;
  settingsFields?: SettingsField[];
  /**
   * Whether this module manages its own named local ("offline") profiles (`game.nihao`'s
   * `profiles`/`default_profile_id`). If set, Game settings shows a "Player profiles" button that
   * navigates to `/gm/<id>` with a `pendingDeepLink` of kind `"open-profile-manager"`; the UI
   * itself belongs to the module. Opt-in.
   */
  hasProfileManager?: boolean;
  /**
   * Whether this module talks to its own server (e.g. Minecraft's). If set, Settings > Online
   * Service shows a status row polling its `check_service_status` (see `OnlineServiceTab.tsx`).
   * Opt-in.
   */
  hasOnlineService?: boolean;
  /** Shown under the launcher's own info in Settings > About. Optional. */
  about?: GameAbout;
}

/** Loads a module's config via its `get_config`. */
export async function getGameConfig(gameId: string): Promise<GameConfig> {
  try {
    const config = await invoke("call_module", {
      module: gameId,
      method: "get_config",
      args: {}
    }) as GameConfig;

    return config;
  } catch (err) {
    console.error(`Failed to load config for modular game ${gameId}:`, err);
    // Fallback when the module has no `get_config` yet.
    return {
      name: gameId.charAt(0).toUpperCase() + gameId.slice(1),
      banner: "",
      defaultPath: "C:\\Games\\" + gameId
    };
  }
}

/** A module's own settings; stored in `game.nihao` in its install folder, not in local.data. */
export async function loadGameSettings(gameId: string, path: string): Promise<Record<string, any>> {
  try {
    return await invoke("load_game_settings", { path }) as Record<string, any>;
  } catch (err) {
    console.error(`Failed to load settings for ${gameId}:`, err);
    return {};
  }
}

export async function saveGameSettings(path: string, settings: Record<string, any>): Promise<void> {
  await invoke("save_game_settings", { path, settings });
}
