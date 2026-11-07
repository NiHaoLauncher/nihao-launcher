import "./App.css";
import { hideBoot } from "./boot";

import { useEffect } from "react";
import { Route, Routes, useLocation, useNavigate, useParams } from "react-router-dom";
import { invoke } from "@tauri-apps/api/tauri";
import { listen } from "@tauri-apps/api/event";
import MainLayout from "./layout/MainLayout";import { LibraryPage } from "./launcher";
import { HomePage } from "./launcher/HomePage";
import ProfilePage from "./launcher/ProfilePage";
import { InitPage } from "./initialization";
import UninstallPage from "./launcher/UninstallPage";
import { SettingsModalHost } from "./components/settings/useSettingsModal";
import { AfkModal } from "./components/AfkModal";

import { useClient } from "./context/ClientContext";
import { useLocalization } from "./state/Localization";
import { useApplication } from "./state/Application";
import { GameModuleRenderer } from "./games/GameLoader.tsx";

interface RawDeepLink {
  kind: string;
  segments: string[];
}

/**
 * `nihaolauncher://<gameId>/<kind>/<segment>/...` (see deeplink.rs): Rust only parses and queues
 * the URL, routing is this hook's job. `segments[0]` is the target game id, stripped before the
 * rest goes down via `pendingDeepLink`. Handles a cold-start link (asked for once on mount) and a
 * warm one (forwarded by `tauri-plugin-single-instance`).
 */
function useDeepLinkRouting() {
  const navigate = useNavigate();
  const { setPendingDeepLink } = useClient();

  useEffect(() => {
    function route(link: RawDeepLink) {
      const [gameId, ...rest] = link.segments;
      if (!gameId) return;
      navigate(`/gm/${gameId}`);
      setPendingDeepLink({ gameId, kind: link.kind, segments: rest });
    }

    invoke<RawDeepLink | null>("take_pending_deep_link").then((link) => { if (link) route(link); }).catch(() => {});
    const unlisten = listen<RawDeepLink>("deep-link", (event) => route(event.payload));
    return () => { unlisten.then((f) => f()); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

/**
 * At most every 30s on any mouse/keyboard input: resets Discord presence's AFK timer (see
 * `discord_presence.rs`). Mounted at the app root to cover every route, including `/` and `/init`.
 */
function useDiscordActivityPulse() {
  useEffect(() => {
    let lastSent = 0;
    const THROTTLE_MS = 30_000;
    function pulse() {
      // While the AFK modal is up, only its button ends the AFK state.
      if (useApplication.getState().afk) return;
      const now = Date.now();
      if (now - lastSent < THROTTLE_MS) return;
      lastSent = now;
      invoke("discord_presence_notify_active").catch(() => {});
    }
    window.addEventListener("mousemove", pulse);
    window.addEventListener("mousedown", pulse);
    window.addEventListener("keydown", pulse);
    return () => {
      window.removeEventListener("mousemove", pulse);
      window.removeEventListener("mousedown", pulse);
      window.removeEventListener("keydown", pulse);
    };
  }, []);
}

/** The friends window asks the main window to go somewhere (a friend's profile): the backend brings
 *  this window to the front and sends the route as a `navigate` event. */
function useBackendNavigation() {
  const navigate = useNavigate();
  useEffect(() => {
    const unlisten = listen<string>("navigate", (e) => {
      if (typeof e.payload === "string" && e.payload.startsWith("/")) navigate(e.payload);
    });
    return () => { unlisten.then((f) => f()); };
  }, [navigate]);
}

export default function App() {
  useDiscordActivityPulse();
  useBackendNavigation();
  useDeepLinkRouting();
  // `/` and `/init` hand the start icon over to the loading screen; every other first page just drops it.
  const { pathname } = useLocation();
  useEffect(() => {
    if (pathname !== "/" && pathname !== "/init") hideBoot();
  }, [pathname]);
  // `t()`/`T` read a global, not React state: re-rendering the root is what makes every page
  // pick up a changed language without a reload (no remount, so page state survives).
  useLocalization((s) => s.revision);

  return (
    <>
    <SettingsModalHost />
    <AfkModal />
    <Routes>
      <Route path="/" element={<ProgramSelfAlive />} />
      <Route path="/init" element={<InitPage />} />
      <Route path="/uninstall" element={<UninstallPage />} />
      <Route element={<MainLayout />}>
        <Route path="/home" element={<HomePage />} />
        <Route path="/library" element={<LibraryPage />} />
        <Route path="/profile/:login?" element={<ProfilePage />} />
        <Route path="/gm/:gameId/*" element={<GamePage/>} />
      </Route>
    </Routes>
    </>
  )
}
function ProgramSelfAlive() {
  const { localClient } = useClient();
  // The uninstaller starts the launcher with `--uninstall`: that goes to the uninstall page, not the
  // usual start (which would also look for an update and sign in).
  useEffect(() => {
    invoke<boolean>("is_uninstall_mode")
      .catch(() => false)
      .then((uninstalling) => {
        document.location = uninstalling ? "/uninstall" : localClient == null ? "/init" : "/home";
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Blank on purpose: the next page opens with the icon, and a text here would flash before it.
  return null;
}

function GamePage() {
  const { gameId } = useParams<{ gameId: string }>();
  const location = useLocation();

  if (!gameId) {
    return <div>Error: Game ID is missing</div>;
  }

  // The module keeps its own in-memory router, so re-clicking the open game remounts it (fresh `location.key`) to land on its main page.
  return <GameModuleRenderer key={location.key} gameId={gameId} />;
}