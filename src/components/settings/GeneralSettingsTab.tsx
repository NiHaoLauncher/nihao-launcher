import { ReactNode, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/tauri";
import { AnimationsDemo, DiscordPresenceDemo } from "./HintDemos";
import { t, Change, onOff, useSettingsFooter, HoverHint } from "@shared";
import { useClient } from "../../context/ClientContext";
import { useLocalization } from "../../state/Localization";
import { LocalClient } from "../../launcher/UserProfile";
import GlobeIcon from "@shared/assets/icons/globe.svg?react";
import EyeOffIcon from "@shared/assets/icons/eye-off.svg?react";
import DiscordIcon from "@shared/assets/icons/discord.svg?react";
import MotionIcon from "@shared/assets/icons/motion.svg?react";

export default function GeneralSettingsTab({ onFooterChange }: { onFooterChange: (footer: ReactNode, hint?: ReactNode) => void }) {
  const { localClient, setLocalClient } = useClient();
  const initLanguage = useLocalization((s) => s.load);

  const [languages, setLanguages] = useState<{ id: string; title: string }[]>([]);
  const [selectedLang, setSelectedLang] = useState(localClient?.interface.language ?? "en_us");
  const [hideInGame, setHideInGame] = useState(localClient?.interface.hide_in_game_running ?? true);
  const [discordPresence, setDiscordPresence] = useState(localClient?.interface.discord_presence_enabled ?? false);
  const [animations, setAnimations] = useState(localClient?.interface.animations_enabled !== false);
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

  // What differs from what is saved: drives the footer's change line, Cancel, and whether Save is
  // available.
  const saved = localClient?.interface;
  const savedLang = saved?.language ?? "en_us";
  const savedHide = saved?.hide_in_game_running ?? true;
  const savedDiscord = saved?.discord_presence_enabled ?? false;
  const savedAnimations = saved?.animations_enabled !== false;
  const langTitle = (id: string) => languages.find((l) => l.id === id)?.title ?? id;

  const changes: Change[] = [];
  if (selectedLang !== savedLang) {
    changes.push({ label: t("setting_language", "Language"), from: langTitle(savedLang), to: langTitle(selectedLang) });
  }
  if (hideInGame !== savedHide) {
    changes.push({ label: t("setting_hide_launcher", "Hide launcher"), from: onOff(savedHide), to: onOff(hideInGame) });
  }
  if (discordPresence !== savedDiscord) {
    changes.push({ label: t("setting_discord", "Discord"), from: onOff(savedDiscord), to: onOff(discordPresence) });
  }
  if (animations !== savedAnimations) {
    changes.push({ label: t("setting_animations", "Animations"), from: onOff(savedAnimations), to: onOff(animations) });
  }

  function handleCancel() {
    setSelectedLang(savedLang);
    setHideInGame(savedHide);
    setDiscordPresence(savedDiscord);
    setAnimations(savedAnimations);
  }

  async function handleSave() {
    if (!localClient) return;
    setSaving(true);
    const languageChanged = selectedLang !== localClient.interface.language;
    const updated: LocalClient = {
      ...localClient,
      interface: {
        language: selectedLang,
        hide_in_game_running: hideInGame,
        discord_presence_enabled: discordPresence,
        animations_enabled: animations,
      },
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

  useSettingsFooter({ changes, saving, canSave: !!localClient, onSave: handleSave, onCancel: handleCancel, report: onFooterChange });

  return (
    <div className="settings-tab">
      <HoverHint text={t("hint_language", "The language of the launcher interface.")}>
        <div className="settings-field">
          <div className="settings-row">
            <GlobeIcon className="settings-icon" />
            <span className="settings-option-text">{t("setting_language", "Language")}</span>
            <select value={selectedLang} onChange={(e) => setSelectedLang(e.target.value)}>
              {languages.map((lang) => (
                <option key={lang.id} value={lang.id}>{lang.title}</option>
              ))}
            </select>
          </div>
        </div>
      </HoverHint>

      <HoverHint text={t("hint_hide_in_game", "The launcher window hides while a game is running and comes back when you close it.")}>
        <div className="settings-field">
          <label className="settings-checkbox-label">
            <input
              type="checkbox"
              checked={hideInGame}
              onChange={(e) => setHideInGame(e.target.checked)}
            />
            <EyeOffIcon className="settings-icon" />
            <span className="settings-option-text">{t("option_hide_in_startup_game", "Hide launcher while game is running")}</span>
          </label>
        </div>
      </HoverHint>

      <HoverHint text={t("hint_discord_presence", "Shows on your Discord profile what you are playing and what you are doing in the game, for example being in the menu, in a world or on a server.")} demo={<DiscordPresenceDemo />}>
        <div className="settings-field">
          <label className="settings-checkbox-label">
            <input
              type="checkbox"
              checked={discordPresence}
              onChange={(e) => setDiscordPresence(e.target.checked)}
            />
            <DiscordIcon className="settings-icon" />
            <span className="settings-option-text">{t("option_discord_presence", "Show activity on Discord")}</span>
          </label>
        </div>
      </HoverHint>

      <HoverHint text={t("hint_animations", "Smooth transitions and pop-ups in the launcher. Turn them off if the interface feels slow.")} demo={<AnimationsDemo />}>
        <div className="settings-field">
          <label className="settings-checkbox-label">
            <input
              type="checkbox"
              checked={animations}
              onChange={(e) => setAnimations(e.target.checked)}
            />
            <MotionIcon className="settings-icon" />
            <span className="settings-option-text">{t("option_animations", "Interface animations")}</span>
          </label>
        </div>
      </HoverHint>
    </div>
  );
}
