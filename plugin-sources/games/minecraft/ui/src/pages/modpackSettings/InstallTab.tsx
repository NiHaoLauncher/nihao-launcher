// The Install tab of the instance settings: Java, JVM arguments and memory. The state belongs to the modal; this draws it.
import { t } from "@shared/components/Translate";
import { SliderField, BrowseField } from "@shared/index";
import { OptionRow, HoverHint } from "@shared";
import SettingsIcon from "@shared/assets/icons/settings.svg?react";
import FolderIcon from "@shared/assets/icons/folder.svg?react";
import TerminalIcon from "@shared/assets/icons/terminal.svg?react";
import SlidersIcon from "@shared/assets/icons/sliders.svg?react";

export function InstallTab({
  javaPath,
  setJavaPath,
  jvmArgs,
  setJvmArgs,
  useCustomRam,
  setUseCustomRam,
  maxRam,
  generalRam,
  handleMaxRamChange,
}: {
  javaPath: string;
  setJavaPath: (path: string) => void;
  jvmArgs: string;
  setJvmArgs: (args: string) => void;
  useCustomRam: boolean;
  setUseCustomRam: (on: boolean) => void;
  maxRam: number;
  generalRam: number | undefined;
  handleMaxRamChange: (mb: number) => void;
}) {
  return (
    <div className="settings-tab">
      <OptionRow stack icon={<FolderIcon className="settings-icon" />} label={t("minecraft.modpack_settings.java_path_label", "Java path")} hint={t("minecraft.modpack_settings.java_path_hint", "Use a specific Java installation for this modpack. Leave empty to let the launcher pick and manage Java itself.")}>
        <BrowseField
          value={javaPath}
          onChange={setJavaPath}
          placeholder={t("minecraft.modpack_settings.java_path_placeholder", "Auto-managed")}
          mode="file"
        />
      </OptionRow>

      <OptionRow stack icon={<TerminalIcon className="settings-icon" />} label={t("minecraft.modpack_settings.jvm_args_label", "JVM arguments")} hint={t("minecraft.modpack_settings.jvm_args_hint", "Extra arguments passed to Java when the game starts. Only change them if you know what they do.")}>
        <input type="text" value={jvmArgs} onChange={(e) => setJvmArgs(e.target.value)} />
      </OptionRow>

      <HoverHint text={t("minecraft.modpack_settings.use_custom_ram_hint", "Give this modpack its own memory limit instead of the general one from Game settings.")}>
        <div className="settings-field">
          <label className="settings-checkbox-label">
            <input
              type="checkbox"
              checked={useCustomRam}
              onChange={(e) => {
                setUseCustomRam(e.target.checked);
                // Switching it on starts from the general allocation, not the stale saved
                // value.
                if (e.target.checked && generalRam !== undefined) handleMaxRamChange(generalRam);
              }}
            />
            <SettingsIcon className="settings-icon" />
            <span className="settings-option-text">{t("minecraft.modpack_settings.use_custom_ram", "Use custom RAM for this modpack")}</span>
          </label>
        </div>
      </HoverHint>

      <OptionRow stack icon={<SlidersIcon className="settings-icon" />} label={t("minecraft.modpack_settings.max_ram_label", "Maximum memory")} hint={t("minecraft.modpack_settings.max_ram_hint", "The most memory this modpack may use. Heavy modpacks need more, but too much starves the rest of your system.")}>
        <SliderField value={useCustomRam ? maxRam : (generalRam ?? maxRam)} min={512} max={16384} step={512} unit="MB" disabled={!useCustomRam} onChange={handleMaxRamChange} />
      </OptionRow>
    </div>
  );
}
