// Sharing an instance: export to a file or publish to NiHao.
import { useEffect, useState } from "react";
import { save as saveFileDialog } from "@tauri-apps/api/dialog";
import { t } from "@shared/components/Translate";
import { Modal } from "@shared/index";
import { useCallModule } from "@shared/modules";
import { useBridge } from "@shared";
import OwnFormatIcon from "@shared/assets/icons/format-own.svg?react";
import MrpackFormatIcon from "@shared/assets/icons/format-mrpack.svg?react";
import CloudUploadIcon from "@shared/assets/icons/cloud-upload.svg?react";
import FolderIcon from "@shared/assets/icons/folder.svg?react";
import FileIcon from "@shared/assets/icons/file.svg?react";
import CheckIcon from "@shared/assets/icons/check.svg?react";
import SearchIcon from "@shared/assets/icons/search.svg?react";
import ChevronDownIcon from "@shared/assets/icons/chevron-down.svg?react";
import { ModpackProfile, ExportEntry } from "./types";
import { waitForBackgroundJob, formatFileSize } from "./helpers";
import { useSignedIn, useModpackPermissions } from "./hooks";

/**
 * Top-level entries checked by default when the Share modal's file list loads (the usual pack
 * content); everything else still shows, unchecked.
 */
const DEFAULT_CHECKED_ENTRIES = ["config", "mods", "datapacks", "resourcepacks", "shaderpacks"];

type Destination = "own" | "mrpack" | "publish";
/** How the own format packs: plain files with the profile, or a manifest with `overrides/`. */
type OwnMode = "full" | "compress";

/** Quick selections for the top level of the file tree; each says which entries it checks. */
const PRESETS: { id: string; label: () => string; picks: (names: string[]) => string[] }[] = [
  { id: "recommended", label: () => t("minecraft.share.preset_recommended", "Recommended"), picks: (names) => names.filter((n) => DEFAULT_CHECKED_ENTRIES.includes(n)) },
  { id: "mods", label: () => t("minecraft.share.preset_mods", "Mods & configs"), picks: (names) => names.filter((n) => n === "mods" || n === "config") },
  { id: "all", label: () => t("minecraft.share.preset_all", "Everything"), picks: (names) => names },
  { id: "none", label: () => t("minecraft.share.preset_none", "None"), picks: () => [] },
];

const joinPath = (parent: string, name: string) => (parent ? `${parent}/${name}` : name);
const parentOf = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf("/")));

/** A checkbox that can show "some of what is inside is ticked". */
function TriCheckbox({ state, onChange }: { state: "all" | "some" | "none"; onChange: () => void }) {
  return (
    <input
      type="checkbox"
      checked={state === "all"}
      ref={(el) => { if (el) el.indeterminate = state === "some"; }}
      onChange={onChange}
    />
  );
}

/**
 * "Share": exports the instance as a self-contained archive installable without a server, in this
 * project's own format (plain files, or a manifest with `overrides/`) or a standard Modrinth
 * .mrpack (see MODPACK_FORMAT.md, `library::export`), or publishes it to NiHao. The files to include
 * are picked in a tree on the left (a folder can be opened and ticked in part), where to send them
 * on the right.
 */
export function ShareModal({
  open, onClose, gamePath, name, profile, onPublished,
}: {
  open: boolean;
  onClose: () => void;
  gamePath: string | undefined;
  name: string;
  /**
   * For "Publish to NiHao": `profile.pack` (if set) means the instance already tracks a published
   * pack; its `id` is reused for a new build.
   */
  profile?: ModpackProfile;
  /**
   * Fired after a successful publish with the manifest the server returned (already saved as
   * `profile.pack` on the Rust side).
   */
  onPublished?: (pack: ModpackProfile["pack"]) => void;
}) {
  const call_module = useCallModule();
  const signedIn = useSignedIn();
  const toast = useBridge((b) => b.toast);
  const { canCreate } = useModpackPermissions();
  /** Folder path ("" is the instance itself) -> what is in it, once opened. */
  const [tree, setTree] = useState<Record<string, ExportEntry[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  /** Paths to include: a folder stands for everything in it. */
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [showHidden, setShowHidden] = useState(false);
  const [sortBy, setSortBy] = useState<"name" | "size">("name");
  const [destination, setDestination] = useState<Destination>("own");
  const [ownMode, setOwnMode] = useState<OwnMode>("compress");
  const [busy, setBusy] = useState<Destination | null>(null);
  const [publishVisibility, setPublishVisibility] = useState<"public" | "invite">("public");
  const [publishVersion, setPublishVersion] = useState("");
  const [error, setError] = useState<string | null>(null);

  const loadFolder = (path: string) =>
    call_module("list_export_entries", { name, path: path || null })
      .then((res: any) => setTree((prev) => ({ ...prev, [path]: Array.isArray(res) ? res : [] })))
      .catch((e: any) => setError(String(e)));

  useEffect(() => {
    if (!open || !gamePath) return;
    setError(null);
    setDestination("own");
    setPublishVersion("");
    setTree({});
    setExpanded(new Set());
    setQuery("");
    call_module("list_export_entries", { name, path: null })
      .then((res: any) => {
        const list: ExportEntry[] = Array.isArray(res) ? res : [];
        setTree({ "": list });
        setSelected(new Set(list.map((entry) => entry.name).filter((n) => DEFAULT_CHECKED_ENTRIES.includes(n))));
      })
      .catch((e: any) => setError(String(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, gamePath, name]);

  const roots = tree[""] ?? [];

  /** Whether `path` is taken (itself or a folder above it ticked), partly (something inside it is), or not. */
  function stateOf(path: string): "all" | "some" | "none" {
    const parts = path.split("/");
    for (let n = 1; n <= parts.length; n++) if (selected.has(parts.slice(0, n).join("/"))) return "all";
    for (const s of selected) if (s.startsWith(`${path}/`)) return "some";
    return "none";
  }

  function toggle(path: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      const parts = path.split("/");
      let ancestor: string | null = null;
      for (let n = 1; n <= parts.length && !ancestor; n++) {
        const above = parts.slice(0, n).join("/");
        if (next.has(above)) ancestor = above;
      }
      if (ancestor === path) {
        next.delete(path);
      } else if (ancestor) {
        // A folder above is ticked as a whole: untick one thing in it by ticking everything else in it.
        next.delete(ancestor);
        for (let n = ancestor.split("/").length; n < parts.length; n++) {
          const folder = parts.slice(0, n).join("/");
          for (const entry of tree[folder] ?? []) if (entry.name !== parts[n]) next.add(joinPath(folder, entry.name));
        }
      } else {
        for (const s of [...next]) if (s.startsWith(`${path}/`)) next.delete(s);
        next.add(path);
      }
      return next;
    });
  }

  function toggleFolder(path: string) {
    const opening = !expanded.has(path);
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.delete(path)) next.add(path);
      return next;
    });
    if (opening && !tree[path]) loadFolder(path);
  }

  const sizeOf = (path: string) => (tree[parentOf(path)] ?? []).find((entry) => joinPath(parentOf(path), entry.name) === path)?.size ?? 0;
  const selectedSize = [...selected].reduce((sum, path) => sum + sizeOf(path), 0);

  function applyPreset(picks: string[]) {
    setSelected(new Set(picks));
  }
  const presetActive = (picks: string[]) => selected.size === picks.length && picks.every((p) => selected.has(p));

  const needle = query.trim().toLowerCase();
  /** Whether `entry` (in `parent`) shows: by hidden-ness, and by the search, which also keeps a folder with a match inside. */
  function visible(parent: string, entry: ExportEntry): boolean {
    if (!showHidden && entry.name.startsWith(".")) return false;
    if (!needle) return true;
    if (entry.name.toLowerCase().includes(needle)) return true;
    const path = joinPath(parent, entry.name);
    return entry.is_dir && (tree[path] ?? []).some((child) => visible(path, child));
  }

  function rows(parent: string, depth: number): React.ReactNode[] {
    const list = (tree[parent] ?? []).filter((entry) => visible(parent, entry));
    const ordered = [...list].sort((a, b) => (a.is_dir === b.is_dir ? 0 : a.is_dir ? -1 : 1) || (sortBy === "size" ? b.size - a.size : a.name.localeCompare(b.name)));
    const biggest = Math.max(1, ...list.map((entry) => entry.size));
    return ordered.flatMap((entry) => {
      const path = joinPath(parent, entry.name);
      const state = stateOf(path);
      const open = entry.is_dir && (expanded.has(path) || (!!needle && (tree[path] ?? []).some((child) => visible(path, child))));
      return [
        <div key={path} className={`share-row${state === "all" ? " checked" : ""}`} style={{ paddingLeft: 10 + depth * 20 }}>
          <i className="share-row-bar" style={{ width: `${Math.round((entry.size / biggest) * 100)}%` }} />
          {entry.is_dir ? (
            <button className={`share-row-chevron${open ? " open" : ""}`} onClick={() => toggleFolder(path)} aria-label={open ? "Collapse" : "Expand"}>
              <ChevronDownIcon width={14} height={14} />
            </button>
          ) : <span className="share-row-chevron" />}
          <TriCheckbox state={state} onChange={() => toggle(path)} />
          <span className="share-row-icon">{entry.is_dir ? <FolderIcon width={16} height={16} /> : <FileIcon width={16} height={16} />}</span>
          <span className="share-row-name" onClick={() => (entry.is_dir ? toggleFolder(path) : toggle(path))}>{entry.name}</span>
          <span className="share-row-size">{formatFileSize(entry.size)}</span>
        </div>,
        ...(open ? rows(path, depth + 1) : []),
      ];
    });
  }

  // Registering a new pack needs `minecraft.modpacks.create`; another build of an owned pack
  // doesn't. Publishing is only offered to an account that can do it.
  const canPublish = !!signedIn && (!!profile?.pack || canCreate);
  useEffect(() => {
    if (!canPublish && destination === "publish") setDestination("own");
  }, [canPublish, destination]);

  async function handlePublish() {
    if (!gamePath || !signedIn || busy) return;
    const include = [...selected];
    if (include.length === 0) {
      setError(t("minecraft.share.nothing_selected", "Select at least one folder or file to export."));
      return;
    }
    setError(null);
    setBusy("publish");
    console.log(`[publish] Starting publish for '${name}' — ${include.length} entr${include.length === 1 ? "y" : "ies"} selected:`, include);
    try {
      // `id` is server-generated, so a first publish registers first and uploads the build under
      // that response's `id`; later builds reuse `profile.pack.id`.
      let id = profile?.pack?.id;
      if (id) {
        console.log(`[publish] Instance already tracks pack '${id}' — checking this account still owns it...`);
        // `profile.pack.id` is local state and may be stale (other account, or pack deleted
        // server-side); check ownership first for a clear message instead of a raw 403.
        const info: any = await call_module("get_modpack_publish_info", { id }).catch((e) => {
          console.warn("[publish] Ownership check itself failed, proceeding anyway:", e);
          return null;
        });
        console.log("[publish] Ownership check result:", info);
        if (info && !info.is_owner) {
          throw new Error(
            t(
              "minecraft.share.publish_stale_owner",
              "This instance's linked pack is no longer owned by this account. Detach it in the instance's Publish settings, then publish again to register a new one."
            )
          );
        }
      } else {
        console.log(`[publish] No linked pack yet — registering '${(profile?.display_name || name).trim()}' (${publishVisibility})...`);
        const registered: any = await call_module("register_online_modpack", {
          name: (profile?.display_name || name).trim(),
          visibility: publishVisibility,
        });
        console.log("[publish] Registration result:", registered);
        id = registered?.id;
        if (!id) throw new Error("Server didn't return a pack id.");
      }
      console.log(`[publish] Building and uploading build for pack '${id}'...`);
      await call_module("publish_modpack_build", {
        name,
        id,
        include,
        version: publishVersion.trim() || null,
      });
      const jobError = await waitForBackgroundJob(call_module, `${name} (export)`);
      if (jobError) {
        console.error("[publish] Background job reported an error:", jobError);
        throw new Error(jobError);
      }
      console.log(`[publish] Build upload finished for pack '${id}'.`);
      toast?.({ message: t("minecraft.share.published", "Published successfully."), variant: "success" });
      const manifest = await call_module("get_modpack_manifest", { name });
      console.log("[publish] Refetched manifest after publish:", manifest);
      onPublished?.(manifest ?? null);
    } catch (e) {
      const message = String(e);
      console.error("[publish] Publish failed:", e);
      setError(message);
      toast?.({ message, variant: "error" });
    } finally {
      setBusy(null);
    }
  }

  async function handleExport(format: "own" | "mrpack") {
    if (!gamePath || busy) return;
    const include = [...selected];
    if (include.length === 0) {
      setError(t("minecraft.share.nothing_selected", "Select at least one folder or file to export."));
      return;
    }
    setError(null);
    try {
      const dest = await saveFileDialog({
        defaultPath: format === "own" ? `${name}.zip` : `${name}.mrpack`,
        filters: [
          format === "own"
            ? { name: "NiHao Modpack", extensions: ["zip"] }
            : { name: "Modrinth Modpack", extensions: ["mrpack"] },
        ],
      });
      if (!dest) return;
      setBusy(format);
      const method = format === "own" ? "export_modpack_own" : "export_modpack_mrpack";
      // The command only starts the export in the background; progress shows in the bottom
      // progress bar (see `export_job_label`) while we poll for it to finish.
      await call_module(method, format === "own" ? { name, include, dest_path: dest, mode: ownMode } : { name, include, dest_path: dest });
      const jobError = await waitForBackgroundJob(call_module, `${name} (export)`);
      if (jobError) throw new Error(jobError);
      toast?.({ message: t("minecraft.share.exported", "Exported successfully."), variant: "success" });
      // Show the player where the file went.
      call_module("reveal_in_folder", { path: dest }).catch(console.error);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }

  const destinations: { id: Destination; icon: React.ReactNode; title: string; hint: string }[] = [
    { id: "own", icon: <OwnFormatIcon width={26} height={26} />, title: t("minecraft.share.own_format", "Our format (.zip)"), hint: t("minecraft.share.own_format_hint", "Self-contained — bundles every file, ready to unzip and use.") },
    { id: "mrpack", icon: <MrpackFormatIcon width={26} height={26} />, title: t("minecraft.share.mrpack_format", "Modrinth (.mrpack)"), hint: t("minecraft.share.mrpack_format_hint", "Standard format other launchers understand. Needs internet to look up mods on Modrinth.") },
    ...(canPublish ? [{ id: "publish" as const, icon: <CloudUploadIcon width={26} height={26} />, title: t("minecraft.share.publish_format", "Publish to NiHao"), hint: t("minecraft.share.publish_format_hint", "Upload to the NiHao server so friends can download it in-app.") }] : []),
  ];

  const working = busy !== null;
  const primaryLabel = busy === "publish"
    ? t("minecraft.share.publishing", "Publishing...")
    : busy
      ? t("minecraft.share.exporting", "Exporting...")
      : destination === "publish"
        ? profile?.pack
          ? t("minecraft.share.publish_build_button", "Publish build")
          : t("minecraft.share.publish_register_button", "Register & publish")
        : destination === "own"
          ? t("minecraft.share.export_zip", "Export .zip...")
          : t("minecraft.share.export_mrpack", "Export .mrpack...");
  const primaryDisabled = working || selected.size === 0;

  return (
    <Modal
      isOpen={open}
      onClose={onClose}
      title={t("minecraft.share.title", "Share modpack")}
      size="large"
      footerHint={`${selected.size} ${t("minecraft.share.selected", "selected")} · ${formatFileSize(selectedSize)}`}
      footer={
        <>
          <button onClick={onClose}>{t("minecraft.share.close", "Close")}</button>
          <button
            className="btn-primary"
            disabled={primaryDisabled}
            onClick={() => (destination === "publish" ? handlePublish() : handleExport(destination))}
          >
            {primaryLabel}
          </button>
        </>
      }
    >
      <div className="share-layout">
        <section className="share-card">
          <header className="share-card-head">
            <b>{t("minecraft.share.files_label", "What to include")}</b>
            <div className="share-presets">
              {PRESETS.map((preset) => {
                const picks = preset.picks(roots.map((entry) => entry.name));
                return (
                  <button key={preset.id} className={`share-chip${presetActive(picks) ? " active" : ""}`} onClick={() => applyPreset(picks)}>
                    {preset.label()}
                  </button>
                );
              })}
            </div>
            <div className="share-tools">
              <div className="share-search">
                <SearchIcon width={14} height={14} />
                <input type="text" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("minecraft.share.search", "Search files")} />
              </div>
              <button className="share-chip" onClick={() => setSortBy((s) => (s === "name" ? "size" : "name"))} title={t("minecraft.share.sort", "Sort")}>
                {sortBy === "name" ? t("minecraft.share.sort_name", "By name") : t("minecraft.share.sort_size", "By size")}
              </button>
              <button className={`share-chip${showHidden ? " active" : ""}`} onClick={() => setShowHidden((v) => !v)}>
                {t("minecraft.share.hidden", "Hidden")}
              </button>
            </div>
          </header>
          <div className="share-files">
            {rows("", 0)}
            {roots.length === 0 && (
              <p className="modpack-option-hint">{t("minecraft.share.no_files", "This instance has no files yet.")}</p>
            )}
          </div>
        </section>

        <section className="share-card">
          <header className="share-card-head"><b>{t("minecraft.share.destination", "Where to")}</b></header>
          <div className="share-destinations" role="radiogroup">
            {destinations.map((d) => (
              <button
                key={d.id}
                role="radio"
                aria-checked={destination === d.id}
                className={`share-destination${destination === d.id ? " active" : ""}`}
                disabled={working}
                onClick={() => setDestination(d.id)}
              >
                <span className="share-destination-icon">{d.icon}</span>
                <span className="share-destination-text">
                  <strong>{d.title}</strong>
                  <small>{d.hint}</small>
                </span>
                {destination === d.id && <CheckIcon className="share-destination-check" width={18} height={18} />}
              </button>
            ))}
          </div>

          {destination === "own" && (
            <div className="share-field">
              <label>{t("minecraft.share.packing", "Packing")}</label>
              <div className="share-segmented">
                <button className={ownMode === "full" ? "active" : ""} onClick={() => setOwnMode("full")}>
                  {t("minecraft.share.packing_full", "Full")}
                </button>
                <button className={ownMode === "compress" ? "active" : ""} onClick={() => setOwnMode("compress")}>
                  {t("minecraft.share.packing_compress", "Compress")}
                </button>
              </div>
              <small className="share-field-hint">
                {ownMode === "full"
                  ? t("minecraft.share.packing_full_hint", "The files as they are in a plain zip, with the instance's profile.nihao next to them.")
                  : t("minecraft.share.packing_compress_hint", "A manifest with every file's checksum and the files under overrides/, like a CurseForge pack.")}
              </small>
            </div>
          )}

          {destination === "publish" && (
            <div className="share-publish">
              {profile?.pack ? (
                <p className="modpack-option-hint">
                  {t("minecraft.share.publish_update_hint", "A new build of \"{name}\" will be uploaded.").replace("{name}", profile.pack.name)}
                </p>
              ) : (
                <div className="share-field">
                  <label>{t("minecraft.share.publish_visibility_label", "Visibility")}</label>
                  <div className="share-segmented">
                    <button className={publishVisibility === "public" ? "active" : ""} onClick={() => setPublishVisibility("public")}>
                      {t("minecraft.share.publish_visibility_public", "Public")}
                    </button>
                    <button className={publishVisibility === "invite" ? "active" : ""} onClick={() => setPublishVisibility("invite")}>
                      {t("minecraft.share.publish_visibility_invite", "Invite-only")}
                    </button>
                  </div>
                </div>
              )}
              <div className="share-field">
                <label>{t("minecraft.share.publish_version_label", "Version label (optional)")}</label>
                <input type="text" value={publishVersion} onChange={(e) => setPublishVersion(e.target.value)} placeholder="1.0.0" />
              </div>
            </div>
          )}

          {error && <p className="modpack-error">{error}</p>}
        </section>
      </div>
    </Modal>
  );
}
