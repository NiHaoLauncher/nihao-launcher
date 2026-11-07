import { create } from "zustand";
import { invoke } from "@tauri-apps/api/tauri";
import { PlayingActivity } from "@shared";

/** What the user is doing in the launcher right now, derived from the two sources below:
 *  `playing` wins over `browsing`, which wins over `idle` (just sitting in the launcher). */
export type ActivityKind = "idle" | "browsing" | "playing";

export interface PlayingState extends PlayingActivity {
  /** Display name of the game being played. */
  game: string;
}

interface ApplicationState {
  /** Display name of the game section currently open (`/gm/:gameId`), if any. */
  browsingGame: string | null;
  /** An actual play session reported by a module, if any. */
  playing: PlayingState | null;
  /** The AFK modal is up: input no longer counts as activity until its button is pressed. */
  afk: boolean;
  setAfk: (afk: boolean) => void;
  setBrowsing: (game: string | null) => void;
  setPlaying: (playing: PlayingState | null) => void;
}

export const useApplication = create<ApplicationState>((set) => ({
  browsingGame: null,
  playing: null,
  afk: false,
  setAfk: (afk) => set({ afk }),
  setBrowsing: (browsingGame) => set({ browsingGame }),
  setPlaying: (playing) => set({ playing }),
}));

export function getActivityKind(s: Pick<ApplicationState, "browsingGame" | "playing">): ActivityKind {
  if (s.playing) return "playing";
  if (s.browsingGame) return "browsing";
  return "idle";
}

/** Selector hook for components that just need the coarse activity. */
export const useActivityKind = () => useApplication(getActivityKind);

// The single place activity reaches Discord Rich Presence (`discord_presence.rs`); Rust resolves
// playing-over-browsing precedence, so each source is forwarded independently.
useApplication.subscribe((state, prev) => {
  if (state.browsingGame !== prev.browsingGame) {
    invoke("discord_presence_set_browsing", { game: state.browsingGame }).catch(() => {});
  }
  if (state.playing !== prev.playing) {
    const p = state.playing;
    invoke("discord_presence_set_playing", {
      game: p?.game ?? null,
      detail: p?.detail ?? null,
      nickname: p?.nickname ?? null,
      joinLabel: p?.joinButton?.label ?? null,
      joinUrl: p?.joinButton?.url ?? null,
      status: p?.status ?? null,
      largeImage: p?.largeImage ?? null,
      largeText: p?.largeText ?? null,
      linkLabel: p?.linkButton?.label ?? null,
      linkUrl: p?.linkButton?.url ?? null,
    }).catch(() => {});
  }
});
