import { SettingsField } from "./Games";
import { invoke } from "@tauri-apps/api/tauri";

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
}

/** 
 * Modular game config loader.
 * In the new architecture, we get this info from the Rust module.
 */
export async function getGameConfig(gameId: string): Promise<GameConfig> {
  try {
    // We can use the 'call_module' to get specific config if needed,
    // or just 'get_module_ui' if the config is embedded in the UI.
    // For now, let's assume the module can return its config.
    const config = await invoke("call_module", {
      module: gameId,
      method: "get_config",
      args: {}
    }) as GameConfig;

    return config;
  } catch (err) {
    console.error(`Failed to load config for modular game ${gameId}:`, err);
    // Fallback for development if module not yet implementing get_config
    return {
      name: gameId.charAt(0).toUpperCase() + gameId.slice(1),
      banner: "",
      defaultPath: "C:\\Games\\" + gameId
    };
  }
}

/** A module's own settings — lives in `game.nihao` inside its install folder, not in
 *  local.data (see `save_game_settings`/`load_game_settings` on the Rust side). */
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
