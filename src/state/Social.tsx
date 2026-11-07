import { useEffect } from "react";
import { create } from "zustand";
import { invoke } from "@tauri-apps/api/tauri";
import { listen } from "@tauri-apps/api/event";
import { getFriendRequests, getFriends, type Friend } from "../launcher/api";
import { useAuth } from "../context/AuthContext";
import { useApplication } from "./Application";
import { keepIfSame } from "./same";

/** Fallback refresh interval; the server's `presence`/`friend.*` events refresh it sooner. */
const REFRESH_MS = 20000;

/** `playing` = online with a game running; `idle` = online but away; the rest are what they say. */
export type FriendStatus = "online" | "playing" | "idle" | "offline";

export function friendStatus(friend: Friend): FriendStatus {
  return friend.online ? "online" : "offline";
}

/** Counts as "online" for the Social button's badge: connected, whether or not in a game. */
const isOnline = (s: FriendStatus) => s === "online" || s === "playing";

/** The signed-in player's own status, as shown on their avatar: playing a game (a module reported
 *  a session), online (connected to the server), or offline (not connected). */
export function useOwnStatus(): FriendStatus {
  const { status } = useAuth();
  const playing = useApplication((s) => s.playing);
  if (status !== "authenticated") return "offline";
  return playing ? "playing" : "online";
}

interface SocialState {
  /** Whether the friends window (a separate OS window) is open — mirrored from the backend, which
   *  tells the main window whenever it opens or closes. */
  open: boolean;
  setOpen: (open: boolean) => void;
  /** Opens the friends window, or closes it if it is already open. */
  toggle: () => void;
  friends: Friend[];
  /** Incoming friend requests waiting for an answer. */
  incomingCount: number;
  /** Re-fetches the friends list and the request count now. */
  refresh: () => Promise<void>;
  /** Forgets everything (signed out). */
  clear: () => void;
}

export const useSocial = create<SocialState>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
  toggle: () => {
    void invoke(useSocial.getState().open ? "close_social_window" : "open_social_window").catch(console.error);
  },
  friends: [],
  incomingCount: 0,

  async refresh() {
    const [friends, requests] = await Promise.all([
      getFriends().catch((e) => { console.error(e); return null; }),
      getFriendRequests().catch((e) => { console.error(e); return null; }),
    ]);
    set((s) => ({
      friends: friends ? keepIfSame(s.friends, friends) : s.friends,
      incomingCount: requests ? requests.incoming.length : s.incomingCount,
    }));
  },

  clear: () => set({ friends: [], incomingCount: 0 }),
}));

/** The friends currently online — what the Social button shows a count of. */
export const useOnlineFriendCount = (): number =>
  useSocial((s) => s.friends.filter((f) => isOnline(friendStatus(f))).length);

// One poller for the whole app: runs while at least one consumer is mounted and the user is signed
// in.
let users = 0;
let timer: ReturnType<typeof setInterval> | undefined;
let unlisten: Promise<() => void> | undefined;

function start() {
  void useSocial.getState().refresh();
  timer = setInterval(() => void useSocial.getState().refresh(), REFRESH_MS);
  unlisten = listen("server-event", () => void useSocial.getState().refresh());
}

function stop() {
  clearInterval(timer);
  timer = undefined;
  void unlisten?.then((u) => u());
  unlisten = undefined;
  useSocial.getState().clear();
}

/** Keeps the friends data fresh while `active` (signed in) and this is mounted. */
export function useSocialSync(active: boolean) {
  useEffect(() => {
    if (!active) return;
    if (users++ === 0) start();
    return () => {
      if (--users === 0) stop();
    };
  }, [active]);
}

/**
 * Keeps `open` in step with the backend, which reports the friends window opening/closing
 * (including via its own title-bar button). Also asks once now: the window may already exist after
 * a reload.
 */
export function watchSocialWindow() {
  void listen<boolean>("social-window-state", (e) => useSocial.getState().setOpen(e.payload));
  void invoke<boolean>("is_social_window_open").then((open) => useSocial.getState().setOpen(open)).catch(() => {});
}
watchSocialWindow();
