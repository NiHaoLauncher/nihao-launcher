import { ReactNode, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/tauri";
import { t } from "@shared";
import { useClient } from "../../context/ClientContext";
import { GameSettings } from "../../games/Games";
import { getGameConfig, loadGameSettings, saveGameSettings, GameConfig } from "../../games/GameRegistry";
import { LocalClient } from "../../launcher/UserProfile";

export default function GameSettingsTab({ onFooterChange }: { onFooterChange: (footer: ReactNode) => void }) {
  const { localClient, setLocalClient } = useClient();

  const [modules, setModules] = useState<string[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const [activeGame, setActiveGame] = useState<string | null>(null);
  const [config, setConfig] = useState<GameConfig | null>(null);
  const [path, setPath] = useState("");
  const [values, setValues] = useState<Record<string, any>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    invoke("list_modules")
      .then((res: any) => {
        setModules(res);
        if (res.length > 0) setActiveGame(res[0]);
        // Fetch display names for every installed game up front, so the sub-tab row
        // (one tab per game, like the old launcher) can show real names, not module ids.
        res.forEach((mod: string) => {
          getGameConfig(mod)
            .then((cfg) => setNames((prev) => ({ ...prev, [mod]: cfg.name })))
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
      setValues(await loadGameSettings(activeGame, savedPath));
    }).catch(console.error);
    // Only re-fetch when the selected game changes — currentPath/values are edited locally afterwards.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeGame]);

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
      await saveGameSettings(path, values);
      setLocalClient(updated);
    } catch (e) {
      console.error("Failed to save game settings:", e);
    } finally {
      setSaving(false);
    }
  }

  // Reports the Save button up to the modal's footer slot instead of rendering it inline —
  // see useSettingsModal.tsx. Re-runs whenever anything the button's state depends on changes.
  useEffect(() => {
    onFooterChange(
      <button className="settings-save-btn" onClick={handleSave} disabled={saving || !activeGame}>
        {saving ? t("save_button_processing", "Saving...") : t("save_button", "Save change")}
      </button>
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saving, activeGame, path, values]);

  useEffect(() => () => onFooterChange(null), [onFooterChange]);

  return (
    <div className="settings-tab">
      <h3>{t("title_game", "Game settings")}</h3>

      {modules.length > 0 && (
        <div className="settings-game-tabs">
          {modules.map((mod) => (
            <button
              key={mod}
              className={mod === activeGame ? "active" : ""}
              onClick={() => setActiveGame(mod)}
            >
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

      {modules.length === 0 && (
        <p className="settings-empty">No modules loaded. Check your plugins folder.</p>
      )}
    </div>
  );
}
