import { ReactNode, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/tauri";
import { t } from "@shared";
import { useClient } from "../../context/ClientContext";
import { useInitLanguage } from "../../context/LanguageContext";
import { LocalClient } from "../../launcher/UserProfile";

export default function GeneralSettingsTab({ onFooterChange }: { onFooterChange: (footer: ReactNode) => void }) {
  const { localClient, setLocalClient } = useClient();
  const initLanguage = useInitLanguage();

  const [languages, setLanguages] = useState<{ id: string; title: string }[]>([]);
  const [selectedLang, setSelectedLang] = useState(localClient?.interface.language ?? "en_us");
  const [hideInGame, setHideInGame] = useState(localClient?.interface.hide_in_game_running ?? true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    invoke("get_lang_list", {})
      .then((result: any) => {
        if (Array.isArray(result)) {
          setLanguages(result.map(([id, title]: [string, string]) => ({ id, title })));
        }
      })
      .catch(console.error);
  }, []);

  async function handleSave() {
    if (!localClient) return;
    setSaving(true);
    const languageChanged = selectedLang !== localClient.interface.language;
    const updated: LocalClient = {
      ...localClient,
      interface: { language: selectedLang, hide_in_game_running: hideInGame },
    };
    try {
      await invoke("save_local_data", { data: updated });
      setLocalClient(updated);
      if (languageChanged) initLanguage(selectedLang);
    } catch (e) {
      console.error("Failed to save general settings:", e);
    } finally {
      setSaving(false);
    }
  }

  // Reports the Save button up to the modal's footer slot instead of rendering it inline —
  // see useSettingsModal.tsx. Re-runs whenever anything the button's state depends on changes.
  useEffect(() => {
    onFooterChange(
      <button className="settings-save-btn" onClick={handleSave} disabled={saving || !localClient}>
        {saving ? t("save_button_processing", "Saving...") : t("save_button", "Save change")}
      </button>
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saving, localClient, selectedLang, hideInGame]);

  useEffect(() => () => onFooterChange(null), [onFooterChange]);

  return (
    <div className="settings-tab">
      <h3>{t("title_general", "General")}</h3>

      <div className="settings-field">
        <label>{t("title_launcher", "Language")}</label>
        <select value={selectedLang} onChange={(e) => setSelectedLang(e.target.value)}>
          {languages.map((lang) => (
            <option key={lang.id} value={lang.id}>{lang.title}</option>
          ))}
        </select>
      </div>

      <div className="settings-field">
        <label className="settings-checkbox-label">
          <input
            type="checkbox"
            checked={hideInGame}
            onChange={(e) => setHideInGame(e.target.checked)}
          />
          {t("option_hide_in_startup_game", "Hide launcher while game is running")}
        </label>
      </div>
    </div>
  );
}
