import { ReactNode, useEffect, useMemo, useRef } from "react";
import { t } from "../i18n";
import CheckIcon from "../assets/icons/check.svg?react";

/** One pending setting change, shown in the modal footer's command line before it is saved. */
export interface Change {
  label: string;
  from: string;
  to: string;
}

export const onOff = (on: boolean) => (on ? t("value_on", "on") : t("value_off", "off"));

/** `› Language: English → Ukrainian · Animations: on → off` — what Save is going to change. */
export function ChangeSummary({ changes }: { changes: Change[] }) {
  const text = changes.map((c) => `${c.label}: ${c.from} \u2192 ${c.to}`).join("  \u00b7  ");
  return (
    <span className="settings-changes" title={text}>
      {changes.map((c) => (
        <span className="settings-change" key={c.label}>
          <b>{c.label}</b> <span className="settings-change-from">{c.from}</span>
          <i> &rarr; </i>
          <span className="settings-change-to">{c.to}</span>
        </span>
      ))}
    </span>
  );
}

/**
 * The footer shared by every settings screen: Cancel (only when something changed) + Save and the
 * "what will change" line. Pass `footer`/`hint` to `Modal`, or `report` to push them up
 * (`report(null)` on unmount).
 */
export function useSettingsFooter({ changes, saving, canSave = true, onSave, onCancel, report }: {
  changes: Change[];
  saving: boolean;
  /** Extra condition for Save besides "something changed". */
  canSave?: boolean;
  onSave: () => void;
  onCancel: () => void;
  report?: (footer: ReactNode, hint?: ReactNode) => void;
}) {
  const dirty = changes.length > 0;
  const latest = useRef({ onSave, onCancel, report });
  latest.current = { onSave, onCancel, report };

  const footer = useMemo(() => (
    <>
      {dirty && (
        <button className="settings-cancel-btn" onClick={() => latest.current.onCancel()} disabled={saving}>
          {t("button_cancel_changes", "Cancel")}
        </button>
      )}
      <button className="settings-save-btn" onClick={() => latest.current.onSave()} disabled={saving || !canSave || !dirty}>
        <CheckIcon />
        {saving ? t("save_button_processing", "Saving...") : t("save_button", "Save change")}
      </button>
    </>
  ), [dirty, saving, canSave]);

  const changesKey = JSON.stringify(changes);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const hint = useMemo(() => (dirty ? <ChangeSummary changes={changes} /> : null), [changesKey]);

  useEffect(() => { latest.current.report?.(footer, hint); }, [footer, hint]);
  useEffect(() => () => latest.current.report?.(null), []);

  return { footer, hint };
}
