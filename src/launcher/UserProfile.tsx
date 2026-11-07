export interface LocalClient {
  /** Whether a NiHao account is attached. The account's refresh token itself is held by the
   *  backend and never sent to the frontend. */
  linked: boolean;
  /**
   * Nickname entered at first-run onboarding: the account-wide default for a module's first local
   * profile. Bridged to modules as `LauncherBridge.defaultNickname`.
   */
  nickname?: string;
  interface: {
    language: string,
    hide_in_game_running: boolean,
    /**
     * Keep a Discord Rich Presence connection alive; synced to the Rust side from
     * `ClientContext.setLocalClient` on every load/change.
     */
    discord_presence_enabled: boolean,
    /** Master switch for every interface animation. Absent (older profile) means on. */
    animations_enabled?: boolean,
    /** Id of the active theme (`themes/<id>/` next to the exe); absent/null = the built-in one. */
    theme?: string | null,
    /** Theme id -> SHA-256 of the bundle the user approved to run. */
    trusted_themes?: Record<string, string>,
    /** Theme id -> that theme's own settings (key -> value). */
    theme_settings?: Record<string, Record<string, string | number | boolean>>
  };
  /**
   * Install path per module; each module's own settings live in `game.nihao` inside that path (see
   * `loadGameSettings`).
   */
  games: {
    [key: string]: { path?: string };
  };
  [key: string]: any;
}

export function getLocalClient() {

}