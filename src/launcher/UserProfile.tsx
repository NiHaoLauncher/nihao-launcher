export interface LocalClient {
  client: string | null;
  interface: {
    language: string,
    hide_in_game_running: boolean
  };
  /** Just the install path per module — each module's own settings live in `game.nihao`
   *  inside that path instead (see games/GameRegistry.ts's loadGameSettings/saveGameSettings). */
  games: {
    [key: string]: { path?: string };
  };
  [key: string]: any;
}

export function getLocalClient() {

}