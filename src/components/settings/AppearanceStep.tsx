import { useEffect } from "react";
import { t } from "@shared";
import type { ThemeSettingValue } from "@shared";
import { useModal } from "../../context/ModalContext";
import { useTheme } from "../../state/Theme";
import { simpleTheme } from "../../themes/simple";
import { ThemeCards, ThemeSettingControls, type Item } from "./AppearanceSettingsTab";

/** What the first-run setup keeps of the look: the chosen theme and the folder themes the user approved. */
export interface AppearanceChoice {
  theme: string | null;
  trusted_themes: Record<string, string>;
}

/**
 * First-run setup, "look" page: pick a theme (live preview) and adjust it. There is no saved profile
 * yet, so the choice goes up to the setup, which saves it with the rest; a theme's settings are read
 * from the theme store at that point.
 */
export function AppearanceStep({ value, onChange }: { value: AppearanceChoice; onChange: (next: AppearanceChoice) => void }) {
  const { confirm } = useModal();
  const { theme, available, error, refresh, activate, previewSettings } = useTheme();
  const selected = value.theme ?? simpleTheme.id;

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const items: Item[] = [
    { id: simpleTheme.id, name: simpleTheme.name, version: simpleTheme.version, author: simpleTheme.author, builtin: true },
    ...available.map((info) => ({ ...info, builtin: false })),
  ];
  const isApproved = (item: Item) => item.builtin || value.trusted_themes[item.id] === item.hash;

  async function choose(item: Item) {
    let trusted = value.trusted_themes;
    if (!isApproved(item)) {
      // A folder theme is code: ask before it ever runs, same as Settings > Appearance does on save.
      const ok = await confirm({
        message:
          t("appearance_trust_message", "This theme is made of code. It runs inside the launcher with the same access the launcher itself has, so only approve themes from people you trust.") +
          `\n\n${item.name} ${item.version}${item.author ? ` — ${item.author}` : ""}` +
          `\n${t("appearance_trust_fingerprint", "File fingerprint")} (SHA-256): ${item.hash?.slice(0, 16)}…`,
        confirmText: t("appearance_trust_confirm", "Approve and apply"),
        cancelText: t("button_cancel_changes", "Cancel"),
        variant: "danger",
      });
      if (!ok) return;
      trusted = { ...trusted, [item.id]: item.hash ?? "" };
    }
    const next = { theme: item.builtin ? null : item.id, trusted_themes: trusted };
    onChange(next);
    await activate(item.id, next);
  }

  const schema = theme.id === selected ? theme.settings ?? [] : [];
  const values = theme.id === selected ? theme.settingValues ?? {} : {};

  return (
    <div className="settings-tab" style={{ width: "100%", maxWidth: "560px", maxHeight: "100%", overflowY: "auto", paddingRight: "6px", boxSizing: "border-box" }}>
      <div style={{ textAlign: "center" }}>
        <h1 style={{ fontSize: "2rem", margin: "0 0 0.5rem", color: "var(--main-color)" }}>{t("startup.appearance.title", "Choose your look")}</h1>
        <p style={{ margin: 0, color: "var(--text-secondary-color)" }}>{t("startup.appearance.subtitle", "Pick a theme and adjust it. You can change it any time in Settings.")}</p>
      </div>
      {error && <p className="settings-form-error">{t("appearance_error", "A theme could not be applied; the built-in one is in use.")} ({error})</p>}
      <ThemeCards items={items} selected={selected} isApproved={isApproved} onChoose={(item) => void choose(item)} />
      <ThemeSettingControls
        themeId={selected}
        schema={schema}
        values={values}
        onChange={(key: string, v: ThemeSettingValue) => previewSettings({ ...values, [key]: v })}
      />
    </div>
  );
}
