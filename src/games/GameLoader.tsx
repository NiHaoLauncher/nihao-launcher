import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/tauri";
import { useModal } from "../context/ModalContext";
import { useClient } from "../context/ClientContext";
import { loadGameSettings } from "./GameRegistry";

export function GameModuleRenderer({ gameId }: { gameId: string }) {
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tagName, setTagName] = useState<string | null>(null);
  const [gameSettings, setGameSettings] = useState<Record<string, any> | undefined>(undefined);
  const { openModal, closeModal, confirm } = useModal();
  const { language, setLanguageKeys, localClient } = useClient();
  const gamePath = localClient?.games?.[gameId]?.path;

  // The module's own settings live in `game.nihao` inside its install folder, not in
  // local.data — see local.rs's `load_game_settings`. Nothing to load until a path is known.
  useEffect(() => {
    let cancelled = false;
    if (!gamePath) { setGameSettings(undefined); return; }
    loadGameSettings(gameId, gamePath).then((settings) => {
      if (!cancelled) setGameSettings(settings);
    });
    return () => { cancelled = true; };
  }, [gameId, gamePath]);

  useEffect(() => {
    let isMounted = true;

    async function loadUI() {
      try {
        const stableTag = `${gameId}-ui`;
        const devModule = await invoke("get_dev_module").catch(() => null) as string | null;
        const isDev = devModule === gameId;

        // Production (or a non-dev module): the custom element tag is stable, and browsers
        // refuse to re-register the same tag twice — so if it's already defined, reuse it
        // instead of re-injecting the script.
        if (!isDev && customElements.get(stableTag)) {
          if (isMounted) { setTagName(stableTag); setLoaded(true); }
          return;
        }

        // Dev mode: use a fresh, unique tag every load. Custom elements can never be
        // redefined under the same name, so without this, editing the module's UI source
        // would only ever take effect once per app session (until a full restart).
        const tag = isDev ? `${stableTag}-${Date.now()}` : stableTag;

        // 1. Get the JS bundle from the backend module
        const uiCode = await invoke("get_module_ui", { module: gameId, tag }) as string;

        // 2. Execute the code to register the custom element
        // Note: The module's index.tsx should define a custom element named by `tag`.
        const script = document.createElement("script");
        script.type = "module";
        script.text = uiCode;
        document.head.appendChild(script);

        // Wait for the custom element to be defined to avoid race conditions/upgrade issues
        await customElements.whenDefined(tag);

        if (isMounted) { setTagName(tag); setLoaded(true); }
      } catch (err) {
        console.error(`Failed to load UI for game ${gameId}:`, err);
        if (isMounted) setError(String(err));
      }
    }

    loadUI();
    return () => { isMounted = false; };
  }, [gameId]);

  if (error) {
    return <div style={{padding: "20px", color: "red"}}>Error loading module: {error}</div>;
  }

  if (!loaded || !tagName) {
    return <div style={{padding: "20px"}}>Loading modular interface...</div>;
  }

  // Render the custom element registered by the module under the tag it was loaded with.
  const TagName = tagName as any;

  return (
    <TagName 
      ref={(el: any) => {
        if (el) {
          el.launcherBridge = {
            openModal,
            closeModal,
            confirm,
            language: language?.id || 'en',
            setLanguage: setLanguageKeys,
            moduleId: gameId,
            gamePath,
            gameSettings
          };
        }
      }}
    />
  );
}

