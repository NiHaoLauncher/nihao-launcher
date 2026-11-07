import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { invoke } from "@tauri-apps/api/tauri";
import { appWindow } from "@tauri-apps/api/window";
import { t } from "@shared";
import BlankLayout from "../layout/BlankLayout";
import { useModal } from "../context/ModalContext";
import { useLocalization } from "../state/Localization";
import type { LocalClient } from "./UserProfile";
import "./UninstallPage.css";

/** One thing to keep or delete (`UninstallItem` in launcher-common); `paths` only for the tooltip. */
interface Item {
  id: string;
  label: string;
  label_key?: string | null;
  description?: string | null;
  description_key?: string | null;
  paths: string[];
  size: number;
  delete_by_default: boolean;
}

/** The launcher's own data (`id` "launcher") or one module's (see `uninstall.rs`). */
interface Group {
  id: string;
  name: string;
  items: Item[];
}

type Ticked = Record<string, string[]>;

function formatBytes(bytes: number): string {
  const units = ["KB", "MB", "GB", "TB"];
  if (bytes < 1024) return `${bytes} B`;
  let value = bytes;
  let unit = -1;
  do {
    value /= 1024;
    unit++;
  } while (value >= 1024 && unit < units.length - 1);
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

const text = (key: string | null | undefined, fallback: string) => (key ? t(key, fallback) : fallback);

/** A checkbox that can show "some of them" (`indeterminate` is a DOM property, not an attribute). */
function GroupBox({ checked, some, onChange }: { checked: boolean; some: boolean; onChange: (on: boolean) => void }) {
  return (
    <input
      type="checkbox"
      checked={checked}
      ref={(el) => { if (el) el.indeterminate = some && !checked; }}
      onChange={(e) => onChange(e.target.checked)}
    />
  );
}

/**
 * `/uninstall`: what to remove with the launcher. Opened by the uninstaller (`--uninstall`) or
 * from a running launcher it re-launches. On confirm the backend hands the choice to the
 * uninstaller and the launcher exits, so nothing here deletes anything itself.
 */
export default function UninstallPage() {
  const navigate = useNavigate();
  const { confirm } = useModal();
  const loadLanguage = useLocalization((s) => s.load);
  const hasLanguage = useLocalization((s) => !!s.language);

  const [groups, setGroups] = useState<Group[] | null>(null);
  const [ticked, setTicked] = useState<Ticked>({});
  const [startedByUninstaller, setStartedByUninstaller] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // The page can be the first thing shown: take the saved language before anything else.
    if (!hasLanguage) {
      invoke<LocalClient>("init_local_data", {})
        .then((profile) => loadLanguage(profile.interface.language ?? "en_us"))
        .catch(() => loadLanguage("en_us"));
    }
    invoke<boolean>("is_uninstall_mode").then(setStartedByUninstaller).catch(() => {});
    invoke<Group[]>("get_uninstall_options", {})
      .then((found) => {
        setGroups(found);
        setTicked(Object.fromEntries(found.map((g) => [g.id, g.items.filter((i) => i.delete_by_default).map((i) => i.id)])));
      })
      .catch((e) => setError(String(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selection = useMemo(() => {
    let count = 0;
    let size = 0;
    for (const g of groups ?? []) {
      for (const i of g.items) {
        if (ticked[g.id]?.includes(i.id)) { count++; size += i.size; }
      }
    }
    return { count, size };
  }, [groups, ticked]);

  function toggle(group: Group, itemIds: string[], on: boolean) {
    setTicked((prev) => {
      const rest = (prev[group.id] ?? []).filter((id) => !itemIds.includes(id));
      return { ...prev, [group.id]: on ? [...rest, ...itemIds] : rest };
    });
  }

  function cancel() {
    if (startedByUninstaller) appWindow.close();
    else navigate("/home");
  }

  async function uninstall() {
    const ok = await confirm({
      message: t("uninstall.confirm", "The launcher closes now and the selected data is deleted for good. Continue?"),
      confirmText: t("uninstall.button", "Uninstall"),
      cancelText: t("uninstall.cancel", "Cancel"),
      variant: "danger",
    });
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      await invoke("uninstall_apply", { selected: ticked });
    } catch (e) {
      setError(`${t("uninstall.failed", "Could not start the uninstaller")}: ${e}`);
      setBusy(false);
    }
  }

  return (
    <BlankLayout>
      <div className="uninstall-page settings-tab">
        <h1>{t("uninstall.title", "Uninstall NiHao Launcher")}</h1>
        <p>{t("uninstall.intro", "Choose what to remove from this computer. When you confirm, the launcher closes and the uninstaller deletes what is ticked. Whatever you leave unticked stays where it is.")}</p>

        <div className="uninstall-groups">
          {!groups && !error && <p className="uninstall-muted">{t("uninstall.loading", "Looking for your data...")}</p>}
          {groups?.map((group) => {
            const ids = group.items.map((i) => i.id);
            const on = ticked[group.id] ?? [];
            const total = group.items.reduce((sum, i) => sum + i.size, 0);
            return (
              <section className="uninstall-group" key={group.id}>
                <label className="settings-checkbox-label uninstall-group-head">
                  <GroupBox checked={on.length === ids.length} some={on.length > 0} onChange={(v) => toggle(group, ids, v)} />
                  <b className="settings-option-text">{group.id === "launcher" ? t("uninstall.launcher", "Launcher") : group.name}</b>
                  <span className="uninstall-size">{t("uninstall.delete_all", "Delete all")} · {formatBytes(total)}</span>
                </label>
                {group.items.map((item) => (
                  <label className="settings-checkbox-label uninstall-item" key={item.id} title={item.paths.join("\n")}>
                    <input type="checkbox" checked={on.includes(item.id)} onChange={(e) => toggle(group, [item.id], e.target.checked)} />
                    <span className="uninstall-item-text">
                      <span className="settings-option-text">{text(item.label_key, item.label)}</span>
                      {item.description && <small className="uninstall-muted">{text(item.description_key, item.description)}</small>}
                    </span>
                    <span className="uninstall-size">{formatBytes(item.size)}</span>
                  </label>
                ))}
              </section>
            );
          })}
        </div>

        <p className="uninstall-muted">{t("uninstall.program_note", "The launcher program, its modules and its cache are always removed.")}</p>
        {error && <p className="uninstall-error">{error}</p>}

        <div className="uninstall-footer">
          <span className="uninstall-muted">
            {selection.count > 0
              ? `${t("uninstall.selected", "Selected")}: ${selection.count} · ${formatBytes(selection.size)}`
              : t("uninstall.nothing_selected", "Nothing is ticked: only the program is removed and all your data stays.")}
          </span>
          <button className="settings-cancel-btn" onClick={cancel} disabled={busy}>{t("uninstall.cancel", "Cancel")}</button>
          <button className="uninstall-danger" onClick={uninstall} disabled={busy || !groups}>{t("uninstall.button", "Uninstall")}</button>
        </div>
      </div>
    </BlankLayout>
  );
}
