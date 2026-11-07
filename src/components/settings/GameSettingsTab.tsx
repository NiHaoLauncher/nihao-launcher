import { ReactNode, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/tauri";
import { useNavigate } from "react-router-dom";
import { t, Change, useSettingsFooter, HoverHint } from "@shared";
import { useClient } from "../../context/ClientContext";
import { useModal } from "../../context/ModalContext";
import { GameSettings } from "../../games/Games";
import { getGameConfig, loadGameSettings, saveGameSettings, GameConfig } from "../../games/GameRegistry";
import { LocalClient } from "../../launcher/UserProfile";

export default function GameSettingsTab({ onFooterChange }: { onFooterChange: (footer: ReactNode, hint?: ReactNode) => void }) {
  const { localClient, setLocalClient, setPendingDeepLink } = useClient();
  const { closeModal } = useModal();
  const navigate = useNavigate();

  const [modules, setModules] = useState<string[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const [icons, setIcons] = useState<Record<string, string>>({});
  const [activeGame, setActiveGame] = useState<string | null>(null);
  const [config, setConfig] = useState<GameConfig | null>(null);
  const [path, setPath] = useState("");
  const [values, setValues] = useState<Record<string, any>>({});
  const [saving, setSaving] = useState(false);
  // What is saved for the active game: the baseline pending changes are measured against (`null`
  // until loaded).
  const [savedState, setSavedState] = useState<{ path: string; values: Record<string, any> } | null>(null);

  useEffect(() => {
    invoke("list_modules")
      .then((res: any) => {
        setModules(res);
        if (res.length > 0) setActiveGame(res[0]);
        // Fetch display names for every installed game up front so the sub-tabs show real names.
        res.forEach((mod: string) => {
          getGameConfig(mod)
            .then((cfg) => {
              setNames((prev) => ({ ...prev, [mod]: cfg.name }));
              const icon = cfg.icon ?? cfg.banner;
              if (icon) setIcons((prev) => ({ ...prev, [mod]: icon }));
            })
            .catch(console.error);
        });
      })
      .catch(console.error);
  }, []);

  useEffect(() => {
    if (!activeGame) return;
    getGameConfig(activeGame).then(async (cfg) => {
      setConfig(cfg);
      const savedPath = localClient?.games?.[activeGame]?.path ?? cfg.defaultPath;
      setPath(savedPath);
      const loaded = await loadGameSettings(activeGame, savedPath);
      setValues(loaded);
      setSavedState({ path: savedPath, values: loaded });
    }).catch(console.error);
    // Re-fetch only when the selected game changes; `currentPath`/`values` are edited locally
    // afterwards.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeGame]);

  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const show = (v: unknown) => (v === undefined || v === null || v === "" ? "—" : String(v));
  const changes: Change[] = [];
  if (savedState) {
    if (path !== savedState.path) {
      changes.push({ label: t("setting_game_path", "Install path"), from: show(savedState.path), to: show(path) });
    }
    for (const field of config?.settingsFields ?? []) {
      const before = savedState.values[field.key] ?? field.defaultValue;
      const after = values[field.key] ?? field.defaultValue;
      if (!same(before, after)) {
        changes.push({ label: field.label, from: show(before), to: show(after) });
      }
    }
  }

  function handleCancel() {
    if (!savedState) return;
    setPath(savedState.path);
    setValues(savedState.values);
  }

  async function handleSave() {
    if (!localClient || !activeGame) return;
    setSaving(true);
    const updated: LocalClient = {
      ...localClient,
      games: {
        ...localClient.games,
        [activeGame]: { path },
      },
    };
    try {
      await invoke("save_local_data", { data: updated });
      // Only the module's declared settings: `values` is the whole `game.nihao`, whose other keys
      // (e.g. player profiles) this page must not roll back.
      const own = Object.fromEntries(
        (config?.settingsFields ?? []).filter((f) => values[f.key] !== undefined).map((f) => [f.key, values[f.key]]),
      );
      await saveGameSettings(path, own);
      setLocalClient(updated);
      setSavedState({ path, values });
    } catch (e) {
      console.error("Failed to save game settings:", e);
    } finally {
      setSaving(false);
    }
  }

  // "Player profiles" belongs to the module (e.g. Minecraft's `SessionProfileManagerModal`): close
  // Settings, jump to the module's page and hand it a `pendingDeepLink` (see `useDeepLinkRouting`)
  // so it opens its modal once mounted.
  function handleOpenProfileManager() {
    if (!activeGame) return;
    closeModal();
    navigate(`/gm/${activeGame}`);
    setPendingDeepLink({ gameId: activeGame, kind: "open-profile-manager", segments: [] });
  }

  useSettingsFooter({ changes, saving, canSave: !!activeGame, onSave: handleSave, onCancel: handleCancel, report: onFooterChange });

  return (
    <div className="settings-tab">

      {modules.length > 0 && (
        <div className="settings-game-tabs">
          {modules.map((mod) => (
            <button
              key={mod}
              className={mod === activeGame ? "active" : ""}
              onClick={() => setActiveGame(mod)}
            >
              {icons[mod] && <img src={icons[mod]} alt="" />}
              {names[mod] ?? mod.toUpperCase()}
            </button>
          ))}
        </div>
      )}

      {config && activeGame && (
        <GameSettings
          gameId={activeGame}
          gameName={config.name}
          defaultPath={config.defaultPath}
          settingsFields={config.settingsFields}
          currentPath={path}
          currentValues={values}
          onPathChange={setPath}
          onValueChange={(key, value) => setValues({ ...values, [key]: value })}
        />
      )}

      {config?.hasProfileManager && activeGame && (
        <HoverHint text={t("hint_player_profiles", "Manage the offline player profiles (nicknames) you can launch the game with.")}>
          <button
            className="settings-secondary-btn settings-manage-profile-btn"
            onClick={handleOpenProfileManager}
          >
            {t("button_profile_manager", "Player profiles")}
          </button>
        </HoverHint>
      )}

      {modules.length === 0 && (
        <p className="settings-empty">No modules loaded. Check your plugins folder.</p>
      )}
    </div>
  );
}
