import { createContext, useContext, useEffect, useRef, useState, ReactNode } from "react";
import { useClient } from "./ClientContext";
import {
  AuthUser,
  checkServerAlive,
  logout as apiLogout,
  openConnectionStream,
  requestCode as apiRequestCode,
  StreamHandle,
  verifyCode as apiVerifyCode,
} from "../launcher/api";
import { useService } from "../state/Service";

/**
 * `idle`: no attempt made. A client never linked to an account does not contact the server on its
 * own, only when the user asks (Refresh, the network step).
 */
export type AuthStatus = "idle" | "connecting" | "authenticated" | "anonymous" | "unavailable";

interface AuthContextType {
  status: AuthStatus;
  user: AuthUser | null;
  error: string | null;
  /** Emails a one-time code; resolves with how many seconds it stays valid. */
  requestCode: (email: string) => Promise<number>;
  /** Trades the emailed code for a session and goes online; resolves once the code is accepted. */
  verifyCode: (email: string, code: string) => Promise<void>;
  logout: () => Promise<void>;
  /**
   * Re-attempts connecting/probing now, so a screen can show a fresh, visible attempt instead of
   * an earlier silent verdict.
   */
  retry: () => void;
  /**
   * Forces a fresh reconnect even when already authenticated (unlike `retry()`, a no-op while
   * authenticated/connecting). Used by Settings' manual refresh.
   */
  reconnect: () => void;
  /**
   * Stops the connection's silent retry loop (`run_stream_loop` in `server_api.rs`) so a
   * "connecting..." screen can let the user continue offline.
   */
  skipConnecting: () => void;
  /**
   * Patches locally known fields of the current user after an edit made elsewhere, so readers of
   * `user` don't show stale data until the next `auth` event.
   */
  patchUser: (patch: Partial<Pick<AuthUser, "displayname" | "avatar" | "description">>) => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const { localClient, setLocalClient, localClientLoaded } = useClient();
  const [status, setStatus] = useState<AuthStatus>("connecting");
  const [user, setUser] = useState<AuthUser | null>(null);
  const [error, setError] = useState<string | null>(null);
  const closeStreamRef = useRef<StreamHandle | null>(null);
  const attemptedRef = useRef(false);
  // Ref so the one-shot connect effect reads the current `localClient` without depending on it:
  // `applyTokens` replaces it on every `auth` event, and a dependency would tear down the fresh
  // connection.
  const localClientRef = useRef(localClient);
  localClientRef.current = localClient;

  function applyAuth(authUser: AuthUser, currentLocalClient: typeof localClient) {
    setUser(authUser);
    setStatus("authenticated");
    setError(null);

    if (currentLocalClient && !currentLocalClient.linked) {
      setLocalClient({ ...currentLocalClient, linked: true });
    }
  }

  // The Rust stream (`run_stream_loop` in `server_api.rs`) owns the reconnect lifecycle: it
  // retries on its own until success, dead credentials or an explicit stop (`skipConnecting`,
  // `logout`, a newer connect).
  function connectStream(currentLocalClient: typeof localClient) {
    // `.detach()`, not `.disconnect()`: `server_connect_stream` already aborts the old stream, and
    // a separate disconnect `invoke()` would race the new connect (see `StreamHandle`).
    closeStreamRef.current?.detach();
    setStatus("connecting");
    const markDisconnected = () => {
      setUser(null);
      setStatus("unavailable");
    };
    closeStreamRef.current = openConnectionStream({
      onAuth: (authUser) => applyAuth(authUser, currentLocalClient),
      // Not proof the server is up: the backend also reports it for local reasons (no saved
      // session, no client key), so ask `/health` before showing the sign-in form.
      onUnauthorized: (message) => {
        setUser(null);
        setError(message);
        void probeServer();
      },
      onUnreachable: markDisconnected,
      // A stream that opened and later ended is always a transient drop (a user logout calls
      // `.disconnect()` first), so same handling as `onUnreachable`.
      onClosed: markDisconnected,
    });
  }

  async function probeServer() {
    setStatus("connecting");
    const alive = await checkServerAlive();
    setStatus(alive ? "anonymous" : "unavailable");
  }

  /**
   * `userRequested` false is the automatic startup attempt: a never-linked client stays `idle`
   * instead of probing the server.
   */
  function attemptConnect(currentLocalClient: typeof localClient, userRequested = true) {
    if (currentLocalClient?.linked) {
      connectStream(currentLocalClient);
    } else if (userRequested) {
      probeServer();
    } else {
      setStatus("idle");
    }
  }

  useEffect(() => {
    useService.getState().sync({ status, user });
  }, [status, user]);

  useEffect(() => {
    if (attemptedRef.current) return;
    // Waits for the check to finish: `localClient` null is ambiguous (still loading vs. no profile
    // yet, which can last minutes during onboarding).
    if (!localClientLoaded) return;
    attemptedRef.current = true;
    attemptConnect(localClientRef.current, false);

    return () => {
      closeStreamRef.current?.disconnect();
    };
    // Deliberately not depending on `localClient` (see `localClientRef`): runs once, when
    // `localClientLoaded` first becomes true.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [localClientLoaded]);

  function retry() {
    if (status === "authenticated" || status === "connecting") return;
    attemptConnect(localClient);
  }

  function reconnect() {
    attemptConnect(localClient);
  }

  function skipConnecting() {
    closeStreamRef.current?.disconnect();
    setStatus((prev) => (prev === "authenticated" ? prev : "unavailable"));
  }

  function patchUser(patch: Partial<Pick<AuthUser, "displayname" | "avatar" | "description">>) {
    setUser((prev) => (prev ? { ...prev, ...patch } : prev));
  }

  async function requestCode(email: string) {
    setError(null);
    try {
      return await apiRequestCode(email);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      throw e;
    }
  }

  async function verifyCode(email: string, code: string) {
    setError(null);
    try {
      await apiVerifyCode(email, code);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      throw e;
    }
    // The code is good; going online is the connection's job, and its `Auth` event does the rest.
    connectStream(localClient);
  }

  async function logout() {
    // Before the connection is dropped: `session.logout` travels on it.
    await apiLogout();
    closeStreamRef.current?.detach();
    closeStreamRef.current = null;
    setUser(null);
    setStatus("anonymous");
    if (localClient?.linked) setLocalClient({ ...localClient, linked: false });
  }

  return (
    <AuthContext.Provider
      value={{ status, user, error, requestCode, verifyCode, logout, retry, reconnect, skipConnecting, patchUser }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return ctx;
}
