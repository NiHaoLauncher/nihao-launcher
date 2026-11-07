// The "Player profiles" page: the picked profile's skin in 3D with the profile list under it, and
// the wardrobe (skin and cape) beside them. Offline profiles have no skin, so their wardrobe is closed.
import { useEffect, useRef, useState } from "react";
import { open as openExternalUrl } from "@tauri-apps/api/shell";
import { listen } from "@tauri-apps/api/event";
import geometry from "../../player-geometry/default.json";
import idleJson from "../../player-anim/idle.json";
import { BedrockViewer } from "../viewer/bedrockViewer";
import { parseClip } from "../viewer/bedrockAnimation";
import { t } from "@shared/components/Translate";
import { Modal, OptionRow, animationsOff } from "@shared";
import { useCallModule } from "@shared/modules";
import TrashIcon from "@shared/assets/icons/trash.svg?react";
import PlusIcon from "@shared/assets/icons/plus.svg?react";
import AccountIcon from "@shared/assets/icons/account.svg?react";
import ShirtIcon from "@shared/assets/icons/shirt.svg?react";
import CheckIcon from "@shared/assets/icons/check.svg?react";
import OrbitIcon from "@shared/assets/icons/orbit.svg?react";
import FileIcon from "@shared/assets/icons/file.svg?react";
import RefreshIcon from "@shared/assets/icons/refresh.svg?react";
import EyeOffIcon from "@shared/assets/icons/eye-off.svg?react";
import SettingsIcon from "@shared/assets/icons/settings.svg?react";
import CloseIcon from "@shared/assets/icons/close.svg?react";
import ChevronDownIcon from "@shared/assets/icons/chevron-down.svg?react";
import ExternalLinkIcon from "@shared/assets/icons/external-link.svg?react";
import { OfflineProfile } from "./types";
import { useGamePath, useAssetIcon } from "./hooks";
import { StarIcon } from "./components";
import { fetchProfiles, persistProfiles, forgetHead, ProfileAvatar, ProfileKind, ServiceIcon } from "./profiles";

const ELYBY_SKINS_URL = "https://ely.by/skins";

/** The launcher's own idle, drawn in Blockbench (`player-anim/idle.json`). */
const idleClip = parseClip(idleJson);

/** Whether the launcher's "Interface animations" switch is off (it sits on `<html>`, so changes are watched). */
function useAnimationsOff(): boolean {
  const [off, setOff] = useState(animationsOff);
  useEffect(() => {
    const observer = new MutationObserver(() => setOff(animationsOff()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-animations"] });
    return () => observer.disconnect();
  }, []);
  return off;
}

/**
 * The player's skin in 3D, turned a little towards the viewer. The big stage plays the idle and
 * can be dragged round; a `small` one is a still portrait for a wardrobe tile that plays it while
 * `animated`.
 */
function SkinStage({ skin, slim, small, animated }: { skin: string | null; slim?: boolean; small?: boolean; animated?: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<BedrockViewer | null>(null);
  const animationsDisabled = useAnimationsOff();

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const box = wrapRef.current;
    const viewer = new BedrockViewer(canvas, small ? 160 : box?.clientWidth || 260, small ? 340 : box?.clientHeight || 340, !small);
    viewerRef.current = viewer;
    // The big stage takes the room it is given, so it follows the window.
    const observer = box && !small ? new ResizeObserver(() => viewer.resize(box.clientWidth || 1, box.clientHeight || 1)) : null;
    if (box && observer) observer.observe(box);
    return () => { observer?.disconnect(); viewer.dispose(); viewerRef.current = null; };
  }, [small]);

  useEffect(() => { viewerRef.current?.setModel(geometry, !!slim); }, [slim, small]);
  useEffect(() => { viewerRef.current?.setSkin(skin); }, [skin, small]);
  useEffect(() => { viewerRef.current?.setClip(idleClip, !animationsDisabled && (!small || !!animated)); }, [small, animated, animationsDisabled]);

  if (small) return <canvas ref={canvasRef} className="profiles-card-canvas" />;
  return (
    <div className="profiles-stage-wrap" ref={wrapRef}>
      <canvas ref={canvasRef} className="profiles-stage-canvas" />
    </div>
  );
}

/**
 * The skin editor, not reachable from the page for now (Ely.by skins are changed on its site).
 * Ely.by has no API to change a skin, so the texture is changed on its site and
 * "Refresh" reads it again; a PNG picked here is only tried on the preview. The cape list is
 * still a stand-in.
 */
export function SkinEditModal({ open, skin, cape, onRefresh, onClose }: { open: boolean; skin: string | null; cape: string | null; onRefresh: () => void; onClose: () => void }) {
  const [arms, setArms] = useState<"default" | "slim">("default");
  const [capeOn, setCapeOn] = useState(true);
  const [preview, setPreview] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const soon = t("minecraft.profiles.coming_soon", "Coming soon");

  useEffect(() => { if (!open) setPreview(null); }, [open]);

  function tryFile(file: File | undefined) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setPreview(String(reader.result));
    reader.readAsDataURL(file);
  }

  return (
    <Modal
      isOpen={open}
      onClose={onClose}
      title={t("minecraft.profiles.edit_title", "Edit skin")}
      size="large"
      footer={
        <>
          <button onClick={onClose}>{t("minecraft.profiles.close", "Close")}</button>
          <button className="btn-primary" onClick={() => { setPreview(null); onRefresh(); }}>
            <RefreshIcon width={14} height={14} /> {t("minecraft.profiles.refresh", "Refresh from Ely.by")}
          </button>
        </>
      }
    >
      <div className="profiles-edit">
        <div className="profiles-edit-preview">
          <SkinStage skin={preview ?? skin} slim={arms === "slim"} />
          <small className="profiles-edit-hint"><OrbitIcon width={14} height={14} /> {t("minecraft.profiles.drag_to_rotate", "Drag to rotate")}</small>
        </div>
        <div className="profiles-edit-controls">
          <div className="profiles-edit-group">
            <b>{t("minecraft.profiles.texture", "Texture")}</b>
            <button onClick={() => openExternalUrl(ELYBY_SKINS_URL)}>
              <ExternalLinkIcon width={16} height={16} /> {t("minecraft.profiles.replace_texture", "Replace texture on ely.by")}
            </button>
            <button onClick={() => fileRef.current?.click()}>
              <FileIcon width={16} height={16} /> {t("minecraft.profiles.try_png", "Try a PNG here")}
            </button>
            <input ref={fileRef} type="file" accept="image/png" hidden onChange={(e) => { tryFile(e.target.files?.[0]); e.target.value = ""; }} />
            <small className="profiles-edit-hint">
              {preview
                ? t("minecraft.profiles.preview_only", "This is only a preview: nothing is saved. Upload the skin on ely.by to keep it.")
                : t("minecraft.profiles.elyby_changes_hint", "Ely.by changes skins on its site. Upload there, then press Refresh.")}
            </small>
          </div>
          <div className="profiles-edit-group">
            <b>{t("minecraft.profiles.arm_style", "Arm style")}</b>
            <div className="profiles-edit-radios">
              <label><input type="radio" name="arms" checked={arms === "default"} onChange={() => setArms("default")} /> {t("minecraft.profiles.arms_wide", "Wide")}</label>
              <label><input type="radio" name="arms" checked={arms === "slim"} onChange={() => setArms("slim")} /> {t("minecraft.profiles.arms_slim", "Slim")}</label>
            </div>
          </div>
          <div className="profiles-edit-group">
            <b>{t("minecraft.profiles.cape", "Cape")}</b>
            <div className="profiles-edit-capes">
              <button className={`profiles-edit-cape${!capeOn || !cape ? " active" : ""}`} onClick={() => setCapeOn(false)}>
                <span>×</span>
                <small>{t("minecraft.profiles.cape_none_pick", "None")}</small>
              </button>
              {cape && (
                <button className={`profiles-edit-cape${capeOn ? " active" : ""}`} onClick={() => setCapeOn(true)} title="Ely.by">
                  <img src={cape} alt="" />
                </button>
              )}
              {[0, 1, 2].map((i) => <button key={i} className="profiles-edit-cape" disabled title={soon}><small>{soon}</small></button>)}
            </div>
          </div>
        </div>
      </div>
    </Modal>
  );
}

/** Ely.by sign-in: the password is sent once to Ely.by and not kept (see `library::elyby`). */
function ElybyLoginModal({ open, busy, error, onSubmit, onClose }: {
  open: boolean;
  busy: boolean;
  error: string | null;
  onSubmit: (login: string, password: string) => void;
  onClose: () => void;
}) {
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const canSubmit = !busy && !!login.trim() && !!password;
  const submit = () => { if (canSubmit) onSubmit(login, password); };

  useEffect(() => {
    if (!open) { setLogin(""); setPassword(""); }
  }, [open]);

  return (
    <Modal
      isOpen={open}
      onClose={busy ? () => {} : onClose}
      title={t("minecraft.profiles.elyby_title", "Sign in with Ely.by")}
      size="small"
      footer={
        <>
          <button onClick={onClose} disabled={busy}>{t("minecraft.profiles.cancel", "Cancel")}</button>
          <button className="btn-primary" onClick={submit} disabled={!canSubmit}>
            {busy ? t("minecraft.launch.elyby_signing_in", "Signing in...") : t("minecraft.launch.elyby_sign_in", "Sign in")}
          </button>
        </>
      }
    >
      <div className="settings-tab">
        <OptionRow stack icon={<AccountIcon className="settings-icon" />} label={t("minecraft.profiles.elyby_login", "Username or email")}>
          <input type="text" autoFocus value={login} onChange={(e) => setLogin(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") submit(); }} />
        </OptionRow>
        <OptionRow
          stack
          icon={<SettingsIcon className="settings-icon" />}
          label={t("minecraft.profiles.elyby_password", "Password")}
          hint={t("minecraft.profiles.elyby_password_hint", "With two-factor authentication, type the password, a colon and the code: password:123456. The password is not saved, only the sign-in token.")}
        >
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") submit(); }} />
        </OptionRow>
        {error && <p style={{ color: "var(--nh-danger)", fontSize: "0.85rem" }}>{error}</p>}
      </div>
    </Modal>
  );
}

/** The profile list folded into one button with a menu, like the one next to Launch. */
function ProfilePicker({ profiles, selectedId, onPick }: { profiles: OfflineProfile[]; selectedId: string | undefined; onPick: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const current = profiles.find((p) => p.id === selectedId) ?? profiles[0];

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);

  if (!current) return null;
  const item = (p: OfflineProfile) => (
    <>
      <ProfileAvatar name={p.name} />
      <span className="modpack-session-info">
        <span className="modpack-session-name">{p.name}</span>
        <span className="modpack-session-type"><ProfileKind service={p.service} /></span>
      </span>
    </>
  );
  return (
    <div className="modpack-session-selector profiles-picker" ref={ref}>
      <button className="modpack-launch-btn modpack-session-btn" onClick={() => setOpen((v) => !v)}>
        {item(current)}
        <ChevronDownIcon width={16} height={16} />
      </button>
      {open && (
        <div className="modpack-session-menu">
          {profiles.map((p) => (
            <button key={p.id} className={p.id === current.id ? "active" : ""} onClick={() => { onPick(p.id); setOpen(false); }}>
              {item(p)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// What the full layout (stage, one row per profile, the two add buttons) needs, in px: below it
// the profiles fold into a `ProfilePicker`.
const FULL_BASE = 400;
const FULL_PER_PROFILE = 54;

export function ProfilesPage() {
  const call_module = useCallModule();
  const gamePath = useGamePath();
  const steve = useAssetIcon("minecraft/steve.png");
  const [profiles, setProfiles] = useState<OfflineProfile[]>([]);
  const [defaultId, setDefaultId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [skin, setSkin] = useState<string | null>(null);
  const [skinRev, setSkinRev] = useState(0);
  /** A skin PNG dropped on the page, tried on the mannequin without being used anywhere. */
  const [dropped, setDropped] = useState<string | null>(null);
  const [dropHover, setDropHover] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newNickname, setNewNickname] = useState("");
  const [tileHover, setTileHover] = useState(false);
  const [elyOpen, setElyOpen] = useState(false);
  const [elyError, setElyError] = useState<string | null>(null);
  const [elyBusy, setElyBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const leftRef = useRef<HTMLElement>(null);
  const [leftHeight, setLeftHeight] = useState(Infinity);

  useEffect(() => {
    const left = leftRef.current;
    if (!left) return;
    const observer = new ResizeObserver(() => setLeftHeight(left.clientHeight));
    observer.observe(left);
    return () => observer.disconnect();
  }, []);

  const selected = profiles.find((p) => p.id === selectedId) ?? profiles[0];
  const isEly = selected?.service === "elyby";
  const compact = leftHeight < FULL_BASE + FULL_PER_PROFILE * profiles.length;

  useEffect(() => {
    if (!gamePath) return;
    fetchProfiles(call_module)
      .then((data) => {
        setProfiles(data.profiles);
        setDefaultId(data.defaultProfileId);
        setSelectedId(data.defaultProfileId ?? data.profiles[0]?.id ?? null);
      })
      .catch((e) => setError(String(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gamePath]);

  // Only an Ely.by profile has a skin of its own to show; an offline one shows its placeholder.
  useEffect(() => {
    setSkin(null);
    if (!selected || !isEly) return;
    let cancelled = false;
    call_module("get_skin", { nickname: selected.name }).then((res: any) => { if (!cancelled) setSkin(typeof res === "string" ? res : null); }).catch(() => {});
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id, isEly, skinRev]);

  // The window hands a dropped file over as a path (the page itself gets no drop event).
  useEffect(() => {
    const unlisten = [
      listen<string[]>("tauri://file-drop", (e) => {
        setDropHover(false);
        const file = e.payload[0];
        if (!file) return;
        setError(null);
        call_module("read_skin_file", { path: file })
          .then((uri: any) => setDropped(typeof uri === "string" ? uri : null))
          .catch((err) => setError(String(err)));
      }),
      listen("tauri://file-drop-hover", () => setDropHover(true)),
      listen("tauri://file-drop-cancelled", () => setDropHover(false)),
    ];
    return () => { unlisten.forEach((u) => u.then((off) => off())); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A tried-on skin belongs to the moment, not to the profile picked next.
  useEffect(() => { setDropped(null); }, [selected?.id]);

  /** Reads the skin and cape from Ely.by again, after the player changed them on its site. */
  function refreshSkin() {
    if (selected) forgetHead(selected.name);
    setSkinRev((r) => r + 1);
  }

  function persistAll(nextProfiles: OfflineProfile[], nextDefaultId: string | null) {
    setProfiles(nextProfiles);
    setDefaultId(nextDefaultId);
    if (!gamePath) return;
    setError(null);
    persistProfiles(call_module, nextProfiles, nextDefaultId).catch((e) => setError(String(e)));
  }

  function remove(id: string) {
    if (profiles.length <= 1) return;
    const next = profiles.filter((p) => p.id !== id);
    // The default pointed at a deleted profile: reassign it rather than leave a dangling id.
    persistAll(next, id === defaultId ? next[0].id : defaultId);
    if (id === selectedId) setSelectedId(next[0].id);
  }

  function add() {
    const name = newNickname.trim();
    if (!name) return;
    const profile: OfflineProfile = { id: crypto.randomUUID(), name, service: "offline" };
    persistAll([...profiles, profile], defaultId);
    setSelectedId(profile.id);
    setNewNickname("");
    setCreating(false);
  }

  async function signInEly(login: string, password: string) {
    setElyBusy(true);
    setElyError(null);
    try {
      const profile: any = await call_module("login_elyby", { login, password });
      const data = await fetchProfiles(call_module);
      setProfiles(data.profiles);
      setDefaultId(data.defaultProfileId);
      setSelectedId(profile?.id ?? null);
      setElyOpen(false);
    } catch (e) {
      setElyError(String(e));
    } finally {
      setElyBusy(false);
    }
  }

  const starButton = (p: OfflineProfile) => (
    <button
      className={`modpack-profile-manager-default${p.id === defaultId ? " active" : ""}`}
      disabled={p.id === defaultId}
      title={p.id === defaultId ? t("minecraft.launch.profile_manager_is_default", "Default profile") : t("minecraft.launch.profile_manager_set_default", "Set as default")}
      onClick={(e) => { e.stopPropagation(); persistAll(profiles, p.id); }}
    >
      <StarIcon filled={p.id === defaultId} />
    </button>
  );
  const deleteButton = (p: OfflineProfile) => (
    <button
      className="modpack-profile-manager-delete"
      disabled={profiles.length <= 1}
      title={profiles.length <= 1 ? t("minecraft.launch.profile_manager_delete_last", "Can't delete the last profile") : t("minecraft.launch.profile_manager_delete", "Delete profile")}
      onClick={(e) => { e.stopPropagation(); remove(p.id); }}
    >
      <TrashIcon width={16} height={16} />
    </button>
  );

  return (
    <div className="profiles-page">
      <section className="profiles-left" ref={leftRef}>
        <h2 className="profiles-title"><AccountIcon width={20} height={20} /> {t("minecraft.launch.profile_manager", "Player profiles")}</h2>
        <div className="profiles-stage">
          <SkinStage skin={dropped ?? (isEly ? skin : steve ?? null)} />
          {dropHover && <div className="profiles-drop-hint">{t("minecraft.profiles.drop_hint", "Drop a skin PNG to try it on")}</div>}
          <div className="profiles-stage-label">
            <h2>{selected?.name}</h2>
            <small>{selected && <ProfileKind service={selected.service} />}</small>
          </div>
        </div>

        {compact ? (
          <div className="profiles-compact-row">
            <ProfilePicker profiles={profiles} selectedId={selected?.id} onPick={setSelectedId} />
            {selected && starButton(selected)}
            {selected && deleteButton(selected)}
          </div>
        ) : (
          <div className="modpack-profile-manager-list">
            {profiles.map((p) => (
              <div key={p.id} className={`modpack-profile-manager-row profiles-row${p.id === selected?.id ? " active" : ""}`} onClick={() => setSelectedId(p.id)}>
                <ProfileAvatar name={p.name} />
                <span className="modpack-profile-manager-name">{p.name}</span>
                <ServiceIcon service={p.service} />
                {starButton(p)}
                {deleteButton(p)}
              </div>
            ))}
          </div>
        )}

        <div className={`profiles-add${compact ? " compact" : ""}`}>
          {creating ? (
            <div className="modpack-profile-manager-create-row">
              <input
                type="text"
                autoFocus
                value={newNickname}
                onChange={(e) => setNewNickname(e.target.value)}
                placeholder={t("minecraft.launch.profile_manager_create_placeholder", "Nickname")}
                onKeyDown={(e) => { if (e.key === "Enter") add(); if (e.key === "Escape") { setNewNickname(""); setCreating(false); } }}
              />
              <button className="modpack-profile-manager-create-btn" onClick={add} disabled={!newNickname.trim()} title={t("minecraft.launch.profile_manager_create", "Create offline profile")}>
                <PlusIcon width={14} height={14} />
              </button>
            </div>
          ) : (
            <button className="modpack-profile-manager-create-btn-full" onClick={() => setCreating(true)} title={t("minecraft.launch.profile_manager_create", "Create offline profile")}>
              <ServiceIcon service="offline" />
              {t("minecraft.launch.profile_manager_create", "Create offline profile")}
            </button>
          )}
          <button className="modpack-profile-manager-create-btn-full" onClick={() => { setElyError(null); setElyOpen(true); }} title={t("minecraft.launch.elyby_add", "Sign in with Ely.by")}>
            <ServiceIcon service="elyby" />
            {t("minecraft.launch.elyby_add", "Sign in with Ely.by")}
          </button>
        </div>
        {error && <p style={{ color: "var(--nh-danger)", fontSize: "0.85rem" }}>{error}</p>}
      </section>

      <section className="profiles-wardrobe">
        <h2><ShirtIcon width={20} height={20} /> {dropped ? t("minecraft.profiles.preview_title", "Skin preview") : t("minecraft.profiles.wardrobe", "Wardrobe")}</h2>
        {dropped ? (
          <div className="profiles-wardrobe-locked">
            <p>{t("minecraft.profiles.preview_note", "You are looking at a skin you dropped here. It is only a preview: it is not used anywhere.")}</p>
            <button className="modpack-profile-manager-create-btn-full" onClick={() => setDropped(null)}>
              <CloseIcon width={14} height={14} />
              {t("minecraft.profiles.preview_reset", "Back to the profile's own skin")}
            </button>
          </div>
        ) : isEly ? (
          <>
            <div className="profiles-skins">
              <div className="profiles-skin-tile active" onMouseEnter={() => setTileHover(true)} onMouseLeave={() => setTileHover(false)}>
                <span className="profiles-skin-check"><CheckIcon width={14} height={14} /></span>
                <div className="profiles-skin-view"><SkinStage skin={skin} small animated={tileHover} /></div>
              </div>
            </div>
            <button className="modpack-profile-manager-create-btn-full" onClick={() => openExternalUrl(ELYBY_SKINS_URL)}>
              <ExternalLinkIcon width={14} height={14} />
              {t("minecraft.profiles.change_on_elyby", "Change on ely.by")}
            </button>
            <button className="modpack-profile-manager-create-btn-full" onClick={refreshSkin}>
              <RefreshIcon width={14} height={14} />
              {t("minecraft.profiles.refresh", "Refresh from Ely.by")}
            </button>
          </>
        ) : (
          <div className="profiles-wardrobe-locked">
            <EyeOffIcon width={32} height={32} />
            <p>{t("minecraft.profiles.wardrobe_locked", "An offline profile has no skin, so the wardrobe is closed. Sign in with Ely.by to open it.")}</p>
            <button className="modpack-profile-manager-create-btn-full" onClick={() => { setElyError(null); setElyOpen(true); }}>
              <ServiceIcon service="elyby" />
              {t("minecraft.launch.elyby_add", "Sign in with Ely.by")}
            </button>
          </div>
        )}
      </section>

      <ElybyLoginModal open={elyOpen} busy={elyBusy} error={elyError} onSubmit={signInEly} onClose={() => setElyOpen(false)} />
    </div>
  );
}
