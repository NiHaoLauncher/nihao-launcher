import { ReactNode, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/tauri";
import { t, useSettingsFooter, HoverHint, OptionRow } from "@shared";
import type { Change } from "@shared";
import type { ThemeSettingField, ThemeSettingValue, ThemeSettingValues } from "@shared";
import { useClient } from "../../context/ClientContext";
import { useModal } from "../../context/ModalContext";
import { useTheme } from "../../state/Theme";
import { simpleTheme } from "../../themes/simple";
import { resolveSettings } from "../../themes/external";
import type { LocalClient } from "../../launcher/UserProfile";

/** One row of the list: the built-in theme, or one found in the `themes/` folder. */
export interface Item {
  id: string;
  name: string;
  version: string;
  author?: string | null;
  builtin: boolean;
  /** SHA-256 of the bundle (folder themes only). */
  hash?: string;
  /** Preview picture (a data URI) — the theme's own icon. */
  icon?: string | null;
}

/** A theme's own text is translated under `theme.<themeId>.<key>.*`, falling back to what the theme declares. */
const tk = (themeId: string, field: ThemeSettingField, part: string, fallback: string) => t(`theme.${themeId}.${field.key}.${part}`, fallback);
const optionLabel = (themeId: string, field: ThemeSettingField, o: { value: string; label: string }) => tk(themeId, field, `option.${o.value}`, o.label);

const show = (themeId: string, field: ThemeSettingField, v: ThemeSettingValue) =>
  field.type === "toggle"
    ? (v ? t("value_on", "on") : t("value_off", "off"))
    : field.type === "select"
      ? (() => { const o = field.options.find((o) => o.value === v); return o ? optionLabel(themeId, field, o) : String(v); })()
      : String(v);

/**
 * Preview of a theme in the list: its icon, a swatch of its colours (built-in), or its initial.
 */
function ThemePreview({ item }: { item: Item }) {
  if (item.icon) return <img className="theme-preview" src={item.icon} alt="" />;
  if (item.builtin) {
    const c = simpleTheme.colors;
    return (
      <span className="theme-preview theme-preview-swatch" style={{ background: c.background, borderColor: c.line }}>
        <i style={{ background: c.surface }} />
        <i style={{ background: c.accent }} />
      </span>
    );
  }
  return <span className="theme-preview theme-preview-letter">{item.name.slice(0, 1).toUpperCase()}</span>;
}

/** One control of a theme's own settings, drawn from its declaration (its description is the hover hint). */
function SettingControl({ themeId, field, value, onChange }: { themeId: string; field: ThemeSettingField; value: ThemeSettingValue; onChange: (v: ThemeSettingValue) => void }) {
  const id = `ts-${field.key}`;
  const label = tk(themeId, field, "label", field.label);
  const description = field.description ? tk(themeId, field, "description", field.description) : undefined;
  const row = (control: ReactNode) => <OptionRow label={label} hint={description} htmlFor={id}>{control}</OptionRow>;
  switch (field.type) {
    case "toggle": {
      const toggle = (
        <div className="settings-field">
          <label className="settings-checkbox-label">
            <input type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} />
            <span className="settings-option-text">{label}</span>
          </label>
        </div>
      );
      return description ? <HoverHint text={description}>{toggle}</HoverHint> : toggle;
    }
    case "select":
      return row(
        <select id={id} value={String(value)} onChange={(e) => onChange(e.target.value)}>
          {field.options.map((o) => <option key={o.value} value={o.value}>{optionLabel(themeId, field, o)}</option>)}
        </select>
      );
    case "number":
      return row(
        <input
          id={id}
          type="number"
          value={Number(value)}
          min={field.min}
          max={field.max}
          step={field.step}
          onChange={(e) => { const n = e.target.valueAsNumber; if (Number.isFinite(n)) onChange(n); }}
        />
      );
    case "color":
      return row(
        <input id={id} type="color" className="theme-color-input" value={/^#[0-9a-fA-F]{6}$/.test(String(value)) ? String(value) : "#000000"} onChange={(e) => onChange(e.target.value)} />
      );
  case "text":
    return row(
      <input id={id} type="text" value={String(value)} maxLength={field.maxLength} onChange={(e) => onChange(e.target.value)} />
    );
  }
}

/** Theme card list: pick the built-in theme or a folder theme. */
export function ThemeCards({ items, selected, isApproved, onChoose }: { items: Item[]; selected: string; isApproved: (item: Item) => boolean; onChoose: (item: Item) => void }) {
  return (
    <div className="theme-list" role="radiogroup" aria-label={t("title_appearance", "Appearance")}>
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="radio"
          aria-checked={selected === item.id}
          className={`theme-card${selected === item.id ? " selected" : ""}`}
          onClick={() => onChoose(item)}
        >
          <ThemePreview item={item} />
          <span className="theme-card-main">
            <span className="theme-name">{item.name}</span>
            <span className="theme-meta">
              v{item.version}{item.author ? ` · ${item.author}` : ""}
            </span>
          </span>
          <span className="theme-badges">
            {item.builtin ? (
              <span className="theme-badge">{t("appearance_builtin", "built-in")}</span>
            ) : (
              <>
                <span className="theme-badge theme-badge-code">{t("appearance_code", "code")}</span>
                {isApproved(item)
                  ? <span className="theme-badge theme-badge-ok">{t("appearance_approved", "approved")}</span>
                  : <span className="theme-badge theme-badge-warn">{t("appearance_needs_approval", "needs approval")}</span>}
              </>
            )}
          </span>
        </button>
      ))}
    </div>
  );
}

/** Controls for a theme's own settings, drawn from its declaration. */
export function ThemeSettingControls({ themeId, schema, values, onChange }: { themeId: string; schema: ThemeSettingField[]; values: ThemeSettingValues; onChange: (key: string, v: ThemeSettingValue) => void }) {
  return (
    <section className="theme-settings">
      <h4>{t("appearance_theme_settings", "Theme settings")}</h4>
      {schema.map((field) => (
        <SettingControl key={field.key} themeId={themeId} field={field} value={values[field.key]} onChange={(v) => onChange(field.key, v)} />
      ))}
    </section>
  );
}

/**
 * Settings > Appearance: pick the theme and set its settings. A folder theme is code, so it only
 * runs after the user approves its exact file; built-in and approved themes preview live.
 */
export default function AppearanceSettingsTab({ onFooterChange }: { onFooterChange: (footer: ReactNode, hint?: ReactNode) => void }) {
  const { localClient, setLocalClient } = useClient();
  const { confirm } = useModal();
  const { theme, available, safeMode, error, refresh, activate, previewSettings, pendingId, setPendingId } = useTheme();

  const savedId = localClient?.interface.theme ?? simpleTheme.id;
  // The clicked-but-unsaved card lives in the theme store (`pendingId`) so it survives a remount
  // of this tab.
  const selected = pendingId ?? savedId;
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const items: Item[] = [
    { id: simpleTheme.id, name: simpleTheme.name, version: simpleTheme.version, author: simpleTheme.author, builtin: true },
    ...available.map((info) => ({ ...info, builtin: false })),
  ];
  const approvedHash = (id: string) => localClient?.interface.trusted_themes?.[id];
  const isApproved = (item: Item) => item.builtin || approvedHash(item.id) === item.hash;
  const nameOf = (id: string) => items.find((i) => i.id === id)?.name ?? id;
  const current = items.find((i) => i.id === selected);

  // The selected theme's settings appear once it is the one in effect (its code must run to
  // declare them); `values` is what is shown, `baseline` what is saved.
  const schema = theme.id === selected ? theme.settings ?? [] : [];
  const values: ThemeSettingValues = theme.id === selected ? theme.settingValues ?? {} : {};
  const baseline = resolveSettings(schema, localClient?.interface.theme_settings?.[selected]);
  const changedFields = schema.filter((f) => values[f.key] !== baseline[f.key]);

  function choose(item: Item) {
    setPendingId(item.id === savedId ? null : item.id);
    // Live preview, but never run a folder theme's code before the user approved it.
    if (isApproved(item)) void activate(item.id);
  }

  function setSetting(key: string, value: ThemeSettingValue) {
    previewSettings({ ...values, [key]: value });
  }

  function handleCancel() {
    setPendingId(null);
    void activate(savedId);
  }

  async function handleSave() {
    if (!localClient || !current) return;
    setSaving(true);
    try {
      const trusted = { ...(localClient.interface.trusted_themes ?? {}) };
      if (!current.builtin && trusted[current.id] !== current.hash) {
        const ok = await confirm({
          message:
            t("appearance_trust_message", "This theme is made of code. It runs inside the launcher with the same access the launcher itself has, so only approve themes from people you trust.") +
            `\n\n${current.name} ${current.version}${current.author ? ` — ${current.author}` : ""}` +
            `\n${t("appearance_trust_fingerprint", "File fingerprint")} (SHA-256): ${current.hash?.slice(0, 16)}…`,
          confirmText: t("appearance_trust_confirm", "Approve and apply"),
          cancelText: t("button_cancel_changes", "Cancel"),
          variant: "danger",
        });
        if (!ok) return;
        trusted[current.id] = current.hash ?? "";
      }
      const themeSettings = { ...(localClient.interface.theme_settings ?? {}) };
      if (schema.length > 0) themeSettings[current.id] = values;
      const updated: LocalClient = {
        ...localClient,
        interface: {
          ...localClient.interface,
          theme: current.builtin ? null : current.id,
          trusted_themes: trusted,
          theme_settings: themeSettings,
        },
      };
      await invoke("save_local_data", { data: updated });
      // Profile first (it now holds the approval and settings), then the theme.
      setLocalClient(updated);
      setPendingId(null);
      await activate(current.id);
    } catch (e) {
      console.error("Failed to save the theme:", e);
    } finally {
      setSaving(false);
    }
  }

  const changes: Change[] = [
    ...(selected !== savedId ? [{ label: t("setting_theme", "Theme"), from: nameOf(savedId), to: nameOf(selected) }] : []),
    ...changedFields.map((f) => ({ label: tk(selected, f, "label", f.label), from: show(selected, f, baseline[f.key]), to: show(selected, f, values[f.key]) })),
  ];

  useSettingsFooter({ changes, saving, canSave: !!localClient, onSave: handleSave, onCancel: handleCancel, report: onFooterChange });

  return (
    <div className="settings-tab">
      {safeMode && (
        <p className="theme-note theme-note-warn">
          {t("appearance_safe_mode", "Safe mode: the saved theme is ignored. Restart without --safe-mode to use it again.")}
        </p>
      )}
      {error && <p className="settings-form-error">{t("appearance_error", "A theme could not be applied; the built-in one is in use.")} ({error})</p>}

      <div className="theme-list" role="radiogroup" aria-label={t("title_appearance", "Appearance")}>
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            role="radio"
            aria-checked={selected === item.id}
            className={`theme-card${selected === item.id ? " selected" : ""}`}
            onClick={() => choose(item)}
          >
            <ThemePreview item={item} />
            <span className="theme-card-main">
              <span className="theme-name">{item.name}</span>
              <span className="theme-meta">
                v{item.version}{item.author ? ` · ${item.author}` : ""}
              </span>
            </span>
            <span className="theme-badges">
              {item.builtin ? (
                <span className="theme-badge">{t("appearance_builtin", "built-in")}</span>
              ) : (
                <>
                  <span className="theme-badge theme-badge-code">{t("appearance_code", "code")}</span>
                  {isApproved(item)
                    ? <span className="theme-badge theme-badge-ok">{t("appearance_approved", "approved")}</span>
                    : <span className="theme-badge theme-badge-warn">{t("appearance_needs_approval", "needs approval")}</span>}
                </>
              )}
            </span>
          </button>
        ))}
      </div>

      {current && !current.builtin && !isApproved(current) && (
        <p className="theme-note">
          {t("appearance_unapproved_note", "This theme runs code, so it will ask for your approval when you save. Until then it is not run, and there is no live preview.")}
        </p>
      )}

      {schema.length > 0 && (
        <section className="theme-settings">
          <h4>{t("appearance_theme_settings", "Theme settings")}</h4>
          {schema.map((field) => (
            <SettingControl key={field.key} themeId={selected} field={field} value={values[field.key]} onChange={(v) => setSetting(field.key, v)} />
          ))}
        </section>
      )}

      <div className="theme-actions">
        <HoverHint text={t("hint_rescan_themes", "Looks for newly added or changed themes in the themes folder.")}>
          <button type="button" className="settings-secondary-btn" onClick={() => void refresh()}>
            {t("appearance_rescan", "Rescan")}
          </button>
        </HoverHint>
        <HoverHint text={t("hint_open_themes_folder", "Opens the folder where custom themes are installed.")}>
          <button type="button" className="settings-secondary-btn" onClick={() => void invoke("open_themes_dir").catch(console.error)}>
            {t("appearance_open_folder", "Open themes folder")}
          </button>
        </HoverHint>
      </div>
    </div>
  );
}
