import { createContext, useContext, useEffect, useRef, useState, ReactNode } from "react";
import { invoke } from "@tauri-apps/api";
import { useClient } from "./ClientContext";
import {
  AuthTokens,
  AuthUser,
  changePassword as apiChangePassword,
  checkServerAlive,
  login as apiLogin,
  logout as apiLogout,
  openConnectionStream,
} from "../launcher/api";

export type AuthStatus = "connecting" | "authenticated" | "anonymous" | "unavailable";

/** How long to wait before silently retrying a reconnect after the server was unreachable. */
const RECONNECT_RETRY_MS = 4000;

interface AuthContextType {
  status: AuthStatus;
  user: AuthUser | null;
  /** The current refresh token, kept here (not just on disk) so onboarding can persist it
   *  itself once the local profile is created — see `finalSetupF` in initialization.tsx. */
  refreshToken: string | null;
  error: string | null;
  login: (loginId: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  changePassword: (currentPassword: string, newPassword: string) => Promise<void>;
  /** Re-attempts connecting/probing right now — for a screen that wants a fresh, visible
   *  "connecting" attempt of its own rather than showing a verdict from an earlier check
   *  that may have run silently long before this screen was ever shown. */
  retry: () => void;
  /** Forces a fresh reconnect right now, even if already authenticated — unlike `retry()`,
   *  which is a no-op while authenticated/connecting (it's meant for a "connecting..." screen
   *  before a session exists). Used by a manual "refresh connection" action in Settings. */
  reconnect: () => void;
  /** Gives up on reconnecting with the stored token for now — stops the silent retry loop
   *  started by `connectWithRefreshToken` so the caller (a "connecting..." screen with a
   *  Skip button) can move on and let the user continue offline. */
  skipConnecting: () => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const { localClient, setLocalClient, localClientLoaded } = useClient();
  const [status, setStatus] = useState<AuthStatus>("connecting");
  const [user, setUser] = useState<AuthUser | null>(null);
  const [refreshToken, setRefreshToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sessionTokenRef = useRef<string | null>(null);
  const closeStreamRef = useRef<(() => void) | null>(null);
  const attemptedRef = useRef(false);
  const retryTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const skippedRef = useRef(false);

  function clearScheduledRetry() {
    if (retryTimeoutRef.current) {
      clearTimeout(retryTimeoutRef.current);
      retryTimeoutRef.current = null;
    }
  }

  function applyTokens(tokens: AuthTokens, currentLocalClient: typeof localClient) {
    sessionTokenRef.current = tokens.session_token;
    setUser(tokens.user);
    setRefreshToken(tokens.refresh_token);
    setStatus("authenticated");
    setError(null);

    // Only persist to disk once a local profile exists — during onboarding, before it does,
    // `finalSetupF` picks up `refreshToken` from this context and saves it itself.
    if (currentLocalClient) {
      const updated = { ...currentLocalClient, client: tokens.refresh_token };
      setLocalClient(updated);
      invoke("save_local_data", { data: updated }).catch((e) =>
        console.error("Failed to persist refresh token:", e)
      );
    }
  }

  function connectWithRefreshToken(token: string, currentLocalClient: typeof localClient) {
    closeStreamRef.current?.();
    clearScheduledRetry();
    setStatus("connecting");
    closeStreamRef.current = openConnectionStream(token, {
      onAuth: (tokens) => applyTokens(tokens, currentLocalClient),
      onUnauthorized: (message) => {
        sessionTokenRef.current = null;
        setUser(null);
        setRefreshToken(null);
        setStatus("anonymous");
        setError(message);
      },
      // The server never answered at all — distinct from onUnauthorized (server answered
      // "no") so the login form isn't shown for a server that isn't even reachable. This is
      // specifically the "reconnecting with an already-known account" path, so keep quietly
      // retrying with the same token (it was never consumed — the server never responded)
      // until it works or the user gives up via skipConnecting().
      onUnreachable: () => {
        sessionTokenRef.current = null;
        setUser(null);
        setStatus("unavailable");
        if (!skippedRef.current) {
          retryTimeoutRef.current = setTimeout(() => {
            if (!skippedRef.current) connectWithRefreshToken(token, currentLocalClient);
          }, RECONNECT_RETRY_MS);
        }
      },
      onClosed: () => {
        sessionTokenRef.current = null;
        setUser(null);
        setStatus("anonymous");
      },
    });
  }

  // No stored token to try — the login form is only worth showing if the server is actually
  // reachable, so probe it first instead of assuming "anonymous" outright.
  async function probeServer() {
    setStatus("connecting");
    const alive = await checkServerAlive();
    setStatus(alive ? "anonymous" : "unavailable");
  }

  function attemptConnect(currentLocalClient: typeof localClient) {
    if (currentLocalClient?.client) {
      connectWithRefreshToken(currentLocalClient.client, currentLocalClient);
    } else {
      probeServer();
    }
  }

  useEffect(() => {
    if (attemptedRef.current) return;
    // Waits for the *check* to finish, not for a profile to exist — `localClient` staying
    // null is ambiguous otherwise (still being read from disk vs. genuinely no profile yet,
    // which during first-run onboarding can last minutes). See markLocalClientLoaded callers.
    if (!localClientLoaded) return;
    attemptedRef.current = true;
    attemptConnect(localClient);

    return () => {
      closeStreamRef.current?.();
      clearScheduledRetry();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [localClientLoaded, localClient]);

  function retry() {
    if (status === "authenticated" || status === "connecting") return;
    skippedRef.current = false;
    attemptConnect(localClient);
  }

  function reconnect() {
    skippedRef.current = false;
    attemptConnect(localClient);
  }

  function skipConnecting() {
    skippedRef.current = true;
    clearScheduledRetry();
    setStatus((prev) => (prev === "authenticated" ? prev : "unavailable"));
  }

  async function login(loginId: string, password: string) {
    setStatus("connecting");
    setError(null);
    try {
      const tokens = await apiLogin(loginId, password);
      applyTokens(tokens, localClient);
    } catch (e) {
      setStatus("anonymous");
      setError(e instanceof Error ? e.message : String(e));
      throw e;
    }
  }

  async function changePassword(currentPassword: string, newPassword: string) {
    if (!sessionTokenRef.current) throw new Error("Not signed in");
    await apiChangePassword(sessionTokenRef.current, currentPassword, newPassword);
  }

  async function logout() {
    closeStreamRef.current?.();
    closeStreamRef.current = null;
    clearScheduledRetry();
    if (sessionTokenRef.current) {
      await apiLogout(sessionTokenRef.current);
    }
    sessionTokenRef.current = null;
    setUser(null);
    setRefreshToken(null);
    setStatus("anonymous");
  }

  return (
    <AuthContext.Provider
      value={{ status, user, refreshToken, error, login, logout, changePassword, retry, reconnect, skipConnecting }}
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
