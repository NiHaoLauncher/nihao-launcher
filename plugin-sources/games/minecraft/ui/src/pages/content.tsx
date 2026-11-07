// The Content manager of an instance: its mods, resource packs, shaders and datapacks.
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { t } from "@shared/components/Translate";
import { useCallModule } from "@shared/modules";
import { installedKey } from "../services";
import TrashIcon from "@shared/assets/icons/trash.svg?react";
import FolderIcon from "@shared/assets/icons/folder.svg?react";
import FileIcon from "@shared/assets/icons/file.svg?react";
import { ContentLists, ContentCategory } from "./types";
import { formatFileSize } from "./helpers";
import { PanelExpandButton } from "./components";
import { BrowseContentModal } from "./browse";

/**
 * "Content manager": browses what is in the instance's mods/resourcepacks/shaderpacks/datapacks
 * folders in the same right-hand pane as the client log (one at a time). Texture packs live in
 * `resourcepacks/`. Mods can be toggled/deleted in place; "Browse content" (`BrowseContentModal`)
 * adds new ones from the online services (`services.ts`).
 */
export function ContentManagerPanel({
  onClose, gamePath, name, expanded, onToggleExpand, readOnly = false,
}: {
  onClose: () => void;
  gamePath: string | undefined;
  name: string;
  expanded: boolean;
  onToggleExpand: () => void;
  /** Only list the content: no toggling, deleting or adding (an instance tied to a service). */
  readOnly?: boolean;
}) {
  const call_module = useCallModule();
  const [category, setCategory] = useState<ContentCategory>("mods");
  const [content, setContent] = useState<ContentLists | null>(null);
  const [loading, setLoading] = useState(false);
  const [scanProgress, setScanProgress] = useState<{ category: string; current: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [browseOpen, setBrowseOpen] = useState(false);
  const [query, setQuery] = useState("");

  /**
   * Starts `start_content_scan` and polls `get_content_scan_status`, so the panel shows real
   * progress during the first scan of a freshly imported modpack.
   */
  async function reload() {
    if (!gamePath) return;
    setLoading(true);
    setError(null);
    setScanProgress(null);
    try {
      await call_module("start_content_scan", { name });
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const res: any = await call_module("get_content_scan_status", { name });
        if (res?.status === "scanning") {
          setScanProgress({ category: res.category, current: res.current, total: res.total });
        } else if (res?.status === "done") {
          setContent(res.lists);
          break;
        } else if (res?.status === "error") {
          throw new Error(res.error);
        } else if (res?.status !== "idle") {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
      setScanProgress(null);
    }
  }

  useEffect(() => { reload(); }, [gamePath, name]); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleToggle(filename: string) {
    if (!gamePath) return;
    try {
      await call_module("toggle_content_file", { name, category, filename });
      reload();
    } catch (e) {
      setError(String(e));
    }
  }

  async function handleDelete(filename: string) {
    if (!gamePath) return;
    try {
      await call_module("delete_content_file", { name, category, filename });
      reload();
    } catch (e) {
      setError(String(e));
    }
  }

  const allEntries = content?.[category] ?? [];
  const q = query.trim().toLowerCase();
  const entries = q
    ? allEntries.filter((e) => `${e.display_name ?? ""} ${e.name}`.toLowerCase().includes(q))
    : allEntries;
  const categories: { key: ContentCategory; label: string }[] = [
    { key: "mods", label: t("minecraft.content_manager.mods", "Mods") },
    { key: "resourcepacks", label: t("minecraft.content_manager.resourcepacks", "Resource packs") },
    { key: "shaderpacks", label: t("minecraft.content_manager.shaderpacks", "Shader packs") },
    { key: "datapacks", label: t("minecraft.content_manager.datapacks", "Datapacks") },
  ];
  const scanCategoryLabel = categories.find((c) => c.key === scanProgress?.category)?.label ?? scanProgress?.category;

  return (
    <div className={`client-log-panel${expanded ? " client-log-panel-expanded" : ""}`}>
      <div className="client-log-header">
        <span>{t("minecraft.content_manager.title", "Content manager")}</span>
        <span className="client-log-header-actions">
          <PanelExpandButton expanded={expanded} onToggle={onToggleExpand} />
          <button className="client-log-close" onClick={onClose} title={t("minecraft.launch.log_close", "Close")}>
            ×
          </button>
        </span>
      </div>

      <div className="content-manager-tabs">
        <nav className="pill-nav">
          {categories.map((c) => (
            <button
              key={c.key}
              className={c.key === category ? "active" : ""}
              onClick={() => setCategory(c.key)}
            >
              {c.label}
              {content && <span className="pill-nav-count">{content[c.key]?.length ?? 0}</span>}
            </button>
          ))}
        </nav>
        <input
          className="content-manager-search"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("minecraft.content_manager.search", "Search...")}
        />
        {!readOnly && (
          <button className="content-manager-browse-btn" onClick={() => setBrowseOpen(true)}>
            {t("minecraft.content_manager.browse", "Browse content")}
          </button>
        )}
      </div>
      {readOnly && (
        <p className="content-manager-readonly">
          {t("minecraft.content_manager.readonly_hint", "This modpack is managed by its service, so its content can only be viewed. Detach it in the modpack settings to change it.")}
        </p>
      )}

      {/*
       * Portalled to <body>: this panel's `backdrop-filter` makes it a containing block for
       * `position: fixed` descendants, which would confine Modal's overlay to the side panel.
       */}
      {browseOpen && createPortal(
        <BrowseContentModal
          onClose={() => setBrowseOpen(false)}
          gamePath={gamePath}
          name={name}
          category={category}
          onInstalled={reload}
          installedProjectIds={(cat) => new Set((content?.[cat] ?? []).flatMap((e) => (e.project_id && e.service ? [installedKey(e.service, e.project_id)] : [])))}
        />,
        document.body
      )}

      <div className="content-manager-list">
        {loading && (
          <div className="content-manager-scan">
            <p className="modpack-option-hint">
              {scanProgress && scanProgress.total > 0
                ? t("minecraft.content_manager.scanning", "Parsing {{category}}... {{current}}/{{total}}")
                    .replace("{{category}}", String(scanCategoryLabel ?? ""))
                    .replace("{{current}}", String(scanProgress.current))
                    .replace("{{total}}", String(scanProgress.total))
                : t("minecraft.content_manager.loading", "Loading...")}
            </p>
            {scanProgress && scanProgress.total > 0 && (
              <div className="content-manager-scan-bar">
                <div
                  className="content-manager-scan-bar-fill"
                  style={{ width: `${Math.round((scanProgress.current / scanProgress.total) * 100)}%` }}
                />
              </div>
            )}
          </div>
        )}
        {error && <p className="modpack-error">{error}</p>}
        {!loading && !error && (
          <>
            {entries.map((entry) => (
              <div key={entry.name} className={`modpack-content-row${entry.enabled ? "" : " disabled"}`}>
                {entry.icon_data ? (
                  <img className="modpack-content-icon" src={entry.icon_data} alt="" />
                ) : (
                  <span className="modpack-file-icon">{entry.is_dir ? <FolderIcon width={16} height={16} /> : <FileIcon width={16} height={16} />}</span>
                )}
                <div className="modpack-content-main">
                  <span className="modpack-content-name" title={entry.display_name ?? entry.name}>
                    {entry.display_name ?? entry.name}
                  </span>
                  <span className="modpack-content-filename" title={entry.name}>{entry.name}</span>
                </div>
                {entry.version && <span className="modpack-content-version" title={entry.version}>{entry.version}</span>}
                {!entry.is_dir && <span className="modpack-content-size">{formatFileSize(entry.size)}</span>}
                {!readOnly && (
                  <div className="modpack-content-actions">
                    {category === "mods" && (
                      <button
                        className={`modpack-content-toggle${entry.enabled ? " on" : ""}`}
                        onClick={() => handleToggle(entry.name)}
                        title={entry.enabled
                          ? t("minecraft.content_manager.disable", "Disable")
                          : t("minecraft.content_manager.enable", "Enable")}
                      >
                        <span className="modpack-content-toggle-knob" />
                      </button>
                    )}
                    <button
                      className="modpack-content-delete"
                      onClick={() => handleDelete(entry.name)}
                      title={t("minecraft.content_manager.delete", "Delete")}
                    >
                      <TrashIcon width={16} height={16} />
                    </button>
                  </div>
                )}
              </div>
            ))}
            {entries.length === 0 && (
              <p className="modpack-option-hint">
                {q ? t("minecraft.content_manager.no_matches", "No matches.") : t("minecraft.content_manager.empty", "Nothing here yet.")}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
