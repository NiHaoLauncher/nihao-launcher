// Client for the NiHaoLauncher server — see API.md. All calls go through the Rust
// backend (see src-tauri/src/server_api.rs), not a browser fetch: the app's own origin
// (http://localhost:1420 in dev, tauri://localhost in prod) is cross-origin from the
// server's, and a plain fetch/EventSource gets blocked by CORS unless the server opts in.
// Going through Tauri commands sidesteps that entirely — it isn't a browser request.

import { invoke } from "@tauri-apps/api";
import { listen } from "@tauri-apps/api/event";

export interface AuthUser {
  login: string;
  displayname: string;
  role?: string;
  /** Full URL, already resolved against the server's origin on the Rust side — see `resolve_avatar` in server_api.rs. */
  avatar?: string | null;
}

export interface AuthTokens {
  session_token: string;
  refresh_token: string;
  user: AuthUser;
}

export async function login(loginId: string, password: string): Promise<AuthTokens> {
  return invoke<AuthTokens>("server_login", { loginId, password });
}

export async function logout(sessionToken: string): Promise<void> {
  await invoke("server_logout", { sessionToken });
}

export async function getSession(sessionToken: string): Promise<AuthUser> {
  return invoke<AuthUser>("server_get_session", { sessionToken });
}

export async function changePassword(
  sessionToken: string,
  currentPassword: string,
  newPassword: string
): Promise<void> {
  await invoke("server_change_password", { sessionToken, currentPassword, newPassword });
}

/** Cheap reachability probe — see server_check_alive on the Rust side for what counts as "alive". */
export async function checkServerAlive(): Promise<boolean> {
  return invoke<boolean>("server_check_alive");
}

export interface StreamHandlers {
  onAuth: (tokens: AuthTokens) => void;
  onUnauthorized: (message: string) => void;
  /** The connect request itself never got a response — the server isn't reachable at all. */
  onUnreachable: () => void;
  /** A stream that did successfully open later ended (drained cleanly or dropped mid-session). */
  onClosed: () => void;
}

type ConnectionEventPayload =
  | { kind: "Auth"; session_token: string; refresh_token: string; user: AuthUser }
  | { kind: "Unauthorized"; message: string }
  | { kind: "Unreachable" }
  | { kind: "Closed" };

/**
 * Starts `GET /connection/stream?token=<refresh_token>` on the Rust side and relays what
 * happens back via the `connection-event` Tauri event, since the SSE body itself never
 * touches the webview. Returns a function that stops listening and tells the backend to
 * abort the stream.
 */
export function openConnectionStream(refreshToken: string, handlers: StreamHandlers): () => void {
  let stopped = false;

  const unlistenPromise = listen<ConnectionEventPayload>("connection-event", (event) => {
    if (stopped) return;
    const payload = event.payload;
    switch (payload.kind) {
      case "Auth":
        handlers.onAuth({
          session_token: payload.session_token,
          refresh_token: payload.refresh_token,
          user: payload.user,
        });
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
      if (!stopped) invoke("server_connect_stream", { refreshToken }).catch(() => {});
    })
    .catch((e) => console.error("Failed to listen for connection events:", e));

  return () => {
    stopped = true;
    unlistenPromise.then((unlisten) => unlisten()).catch(() => {});
    invoke("server_disconnect_stream").catch(() => {});
  };
}
