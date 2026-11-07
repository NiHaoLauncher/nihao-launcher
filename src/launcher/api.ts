// Client for the NiHaoLauncher server (DOCUMENTATION/server). Calls go through the Rust backend
// (`server_api.rs`), which holds the one WebSocket; the webview never talks to the server.

import { invoke } from "@tauri-apps/api";
import { listen } from "@tauri-apps/api/event";

export interface AuthUser {
  login: string;
  displayname: string;
  avatar?: string | null;
  description?: string | null;
}

// Credentials never reach the frontend: the Rust backend holds the refresh token.

/** Emails `email` a one-time sign-in code; resolves with how many seconds it stays valid. */
export async function requestCode(email: string): Promise<number> {
  return invoke<number>("server_request_code", { email });
}

/** Trades the emailed code for a session. Going online is separate (`openConnectionStream`). */
export async function verifyCode(email: string, code: string): Promise<AuthUser> {
  return invoke<AuthUser>("server_verify_code", { email, code });
}

export async function logout(): Promise<void> {
  await invoke("server_logout");
}

/** Friendship with this profile's owner; only present on someone else's profile. */
export type Friendship = "none" | "friends" | "request_sent" | "request_received";

/** Shape of `profile.me` and `profile.get`; `online` and `friendship` come only with someone else's. */
export interface Profile {
  login: string;
  displayname: string;
  avatar?: string | null;
  description?: string | null;
  online?: boolean;
  friendship?: Friendship;
}

export async function getProfile(): Promise<Profile> {
  return invoke<Profile>("server_get_profile", {});
}

export async function getUserProfile(login: string): Promise<Profile> {
  return invoke<Profile>("server_get_user_profile", { login });
}

export async function updateProfile(displayname: string | null,
  description: string | null
): Promise<AuthUser> {
  return invoke<AuthUser>("server_update_profile", { displayname, description });
}

/** `filePath` is a local path from a file picker; returns the new avatar's URL. */
export async function uploadAvatar(filePath: string): Promise<string> {
  return invoke<string>("server_upload_avatar", { filePath });
}

export interface Friend {
  login: string;
  displayname: string;
  avatar?: string | null;
  online: boolean;
}

export async function getFriends(): Promise<Friend[]> {
  return invoke<Friend[]>("server_get_friends", {});
}

export async function sendFriendRequest(login: string): Promise<void> {
  await invoke("server_send_friend_request", { login });
}

export async function acceptFriendRequest(login: string): Promise<void> {
  await invoke("server_accept_friend_request", { login });
}

export async function declineFriendRequest(login: string): Promise<void> {
  await invoke("server_decline_friend_request", { login });
}

/**
 * A pending request, `outgoing` (sent) or `incoming` (received). The server has no way to cancel
 * an outgoing one.
 */
export interface FriendRequest {
  login: string;
  displayname: string;
  avatar?: string | null;
  created_at?: string | null;
}

export interface FriendRequestsResponse {
  incoming: FriendRequest[];
  outgoing: FriendRequest[];
}

export async function getFriendRequests(): Promise<FriendRequestsResponse> {
  return invoke<FriendRequestsResponse>("server_get_friend_requests", {});
}

/** Cheap reachability probe (see `server_check_alive`). */
export async function checkServerAlive(): Promise<boolean> {
  return invoke<boolean>("server_check_alive");
}

export interface StreamHandlers {
  onAuth: (user: AuthUser) => void;
  /** The server refuses the session, this build or this version: show the sign-in form. */
  onUnauthorized: (message: string) => void;
  /** The connect request itself never got a response — the server isn't reachable at all. */
  onUnreachable: () => void;
  /** A connection that did successfully open later ended (closed cleanly or dropped mid-session). */
  onClosed: () => void;
}

type ConnectionEventPayload =
  | { kind: "Auth"; user: AuthUser }
  | { kind: "Unauthorized"; message: string }
  | { kind: "Unreachable" }
  | { kind: "Closed" };

/**
 * Handle returned by `openConnectionStream`. `detach` and `disconnect` are separate so a reconnect
 * can't kill the connection it just opened.
 */
export interface StreamHandle {
  /**
   * Stops listening locally only (no `server_disconnect_stream`). Use right before opening a
   * replacement connection: the Rust side already aborts the old one, and a separate disconnect
   * could race and kill the new one.
   */
  detach: () => void;
  /** Stops listening AND tells the backend to actually end the connection — use this when nothing
   *  is about to replace it (the provider unmounting). */
  disconnect: () => void;
}

/**
 * Opens the connection on the Rust side and relays its state through the `connection-event` Tauri
 * event. Server pushes (`presence`, `friend.*`) arrive as the app-wide `server-event`.
 */
export function openConnectionStream(handlers: StreamHandlers): StreamHandle {
  let stopped = false;

  const unlistenPromise = listen<ConnectionEventPayload>("connection-event", (event) => {
    if (stopped) return;
    const payload = event.payload;
    switch (payload.kind) {
      case "Auth":
        handlers.onAuth(payload.user);
        break;
      case "Unauthorized":
        handlers.onUnauthorized(payload.message);
        break;
      case "Unreachable":
        handlers.onUnreachable();
        break;
      case "Closed":
        handlers.onClosed();
        break;
    }
  });

  unlistenPromise
    .then(() => {
      if (!stopped) invoke("server_connect_stream").catch(() => {});
    })
    .catch((e) => console.error("Failed to listen for connection events:", e));

  const detach = () => {
    stopped = true;
    unlistenPromise.then((unlisten) => unlisten()).catch(() => {});
  };

  return {
    detach,
    disconnect: () => {
      detach();
      invoke("server_disconnect_stream").catch(() => {});
    },
  };
}
