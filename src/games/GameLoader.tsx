import { useEffect, useMemo, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { appWindow } from "@tauri-apps/api/window";
import { useModal } from "../context/ModalContext";
import { useToast } from "../context/ToastContext";
import { useClient } from "../context/ClientContext";
import { useApplication } from "../state/Application";
import { useGames } from "../state/Games";
import { useLocalization } from "../state/Localization";
import { useQuickPanel } from "../state/QuickPanel";
import { useService } from "../state/Service";
import { BridgeActions, createGameBridge } from "./bridge";

/** Mounts a game module's UI: its whole page, or (`view="home"`) just the banner the launcher's main page shows. */
export function GameModuleRenderer({ gameId, view = "page" }: { gameId: string; view?: "page" | "home" }) {
  const navigate = useNavigate();
  const { openModal, closeModal, confirm } = useModal();
  const { showToast } = useToast();
  const { localClient, pendingDeepLink, setPendingDeepLink } = useClient();
  const languageId = useLocalization((s) => s.language?.id);
  const languageRevision = useLocalization((s) => s.revision);
  // Only whether signed in: the backend holds the token and pushes it to the module's backend
  // (`set_current_session_token`).
  const signedIn = useService((s) => s.status === "authenticated");
  const game = useGames((s) => s.games[gameId]);
  const { loadConfig, loadUi, loadSettings } = useGames.getState();
  const gamePath = localClient?.games?.[gameId]?.path;
  const gameName = game?.config?.name ?? gameId;

  // Forwards a deep link `App.tsx` resolved for this game to the module via the bridge. The host's
  // copy stays until the module says it handled it (`consumeDeepLink`): the module's first render
  // comes after this component's effects, so clearing right away would hand it nothing. Leaving
  // the page clears it, so it is not left over for the next game.
  const deepLinkForThisModule = view === "page" && pendingDeepLink?.gameId === gameId ? pendingDeepLink : null;
  const bridgeDeepLink = useMemo(
    () => (deepLinkForThisModule
      ? { kind: deepLinkForThisModule.kind, segments: deepLinkForThisModule.segments, data: deepLinkForThisModule.data }
      : null),
    [deepLinkForThisModule],
  );
  useEffect(() => {
    if (view !== "page") return;
    return () => setPendingDeepLink(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameId, view]);

  useEffect(() => { loadConfig(gameId).catch(() => {}); }, [gameId]);
  useEffect(() => { loadUi(gameId); }, [gameId]);
  useEffect(() => { loadSettings(gameId, gamePath).catch(() => {}); }, [gameId, gamePath]);

  // Reports "browsing this game's section" while the page is open; a module's own
  // `reportPlayingActivity` takes precedence. Cleanup keyed on `gameId` so it fires only on
  // leaving.
  useEffect(() => {
    if (view === "page") useApplication.getState().setBrowsing(gameName);
  }, [gameName, view]);
  useEffect(() => {
    if (view !== "page") return;
    return () => {
      useApplication.getState().setBrowsing(null);
      useQuickPanel.getState().clear(gameId);
    };
  }, [gameId, view]);

  // Host functions the bridge forwards to, re-assigned every render; the bridge's wrappers read
  // through this ref so the bridge never changes.
  const actionsRef = useRef<BridgeActions>(null as unknown as BridgeActions);
  actionsRef.current = {
    openModal,
    closeModal,
    confirm,
    toast: showToast,
    setQuickPanel: (items) => { if (view === "page") useQuickPanel.getState().setItems(gameId, items); },
    consumeDeepLink: () => setPendingDeepLink(null),
    openGame: (link) => {
      setPendingDeepLink(link ? { gameId, ...link } : null);
      navigate(`/gm/${gameId}`);
    },
    setLanguage: (id) => { useLocalization.getState().load(id); },
    reportPlayingActivity: (activity) => {
      useApplication.getState().setPlaying(activity ? { ...activity, game: gameName } : null);
    },
    // Minimized, not hidden: it stays in the taskbar, so a launcher that never gets the "restore"
    // call can still be brought back.
    setLauncherHidden: (hidden) => {
      if (!hidden) {
        appWindow.unminimize().then(() => appWindow.setFocus()).catch(console.error);
      } else if (localClient?.interface.hide_in_game_running !== false) {
        appWindow.minimize().catch(console.error);
      }
    },
  };

  const data = {
    language: languageId || "en",
    languageRevision,
    gamePath,
    gameSettings: game?.settings,
    signedIn,
    defaultNickname: localClient?.nickname,
    pendingDeepLink: bridgeDeepLink,
    view,
  };

  // One bridge per module for the component's whole life on this `gameId` — see `BridgeStore`.
  const bridge = useMemo(
    () => createGameBridge(gameId, () => actionsRef.current, data),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [gameId],
  );
  useEffect(() => { bridge.update(data); });

  if (game?.ui.status === "error") {
    return <div style={{padding: "20px", color: "red"}}>Error loading module: {game.ui.error}</div>;
  }

  const tagName = game?.ui.tag;
  if (game?.ui.status !== "ready" || !tagName) {
    return <div style={{padding: "20px"}}>Loading modular interface...</div>;
  }

  const TagName = tagName as any;

  return (
    <TagName
      ref={(el: any) => {
        if (el && el.launcherBridgeStore !== bridge.store) el.launcherBridgeStore = bridge.store;
      }}
    />
  );
}
