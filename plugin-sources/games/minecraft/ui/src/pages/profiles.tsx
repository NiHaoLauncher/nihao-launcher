// Player profiles: the selector next to Launch and the helpers the `/profiles` page shares.
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { t } from "@shared/components/Translate";
import { useCallModule } from "@shared/modules";
import { useBridge } from "@shared";
import SettingsIcon from "@shared/assets/icons/settings.svg?react";
import AccountIcon from "@shared/assets/icons/account.svg?react";
import ChevronDownIcon from "@shared/assets/icons/chevron-down.svg?react";
import { OfflineProfile, CallModuleFn, ProfilesResponse } from "./types";
import { useAssetIcon } from "./hooks";

/** nickname -> the head cut from its skin (data URI), or null when Ely.by and Mojang have none. */
const heads = new Map<string, Promise<string | null>>();

/** Forgets the cached head of `nickname`, so the next look reads the skin again. */
export function forgetHead(nickname: string) {
  heads.delete(nickname);
}

function loadHead(call_module: CallModuleFn, nickname: string): Promise<string | null> {
  let head = heads.get(nickname);
  if (!head) {
    head = (async () => {
      const skin: any = await call_module("get_skin", { nickname });
      if (typeof skin !== "string") return null;
      const img = new Image();
      img.src = skin;
      await img.decode();
      // The face is at 8,8 on the 64px skin and the hat layer at 40,8.
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 8;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(img, 8, 8, 8, 8, 0, 0, 8, 8);
      ctx.drawImage(img, 40, 8, 8, 8, 0, 0, 8, 8);
      return canvas.toDataURL();
    })().catch(() => null);
    heads.set(nickname, head);
  }
  return head;
}

const KIND_ICONS: Record<string, string> = {
  elyby: "minecraft/services/elyby.svg",
  microsoft: "minecraft/services/microsoft.png",
};

/** The icon of the service a profile signs in with (offline has its own). */
export function ServiceIcon({ service }: { service: string }) {
  const icon = useAssetIcon(KIND_ICONS[service] ?? "minecraft/offline-session.png");
  return icon ? <img className="profile-kind-icon" src={icon} alt="" /> : null;
}

/** The subtitle under a profile's name: the service's icon and how it signs in. */
export function ProfileKind({ service }: { service: string }) {
  return (
    <>
      <ServiceIcon service={service} />
      {service === "elyby"
        ? t("minecraft.launch.session_elyby_subtitle", "Ely.by account")
        : t("minecraft.launch.session_offline_subtitle", "Offline account")}
    </>
  );
}

/** The player's skin head (Ely.by, else licensed), or the default icon when no skin is found. */
export function ProfileAvatar({ name }: { name: string }) {
  const call_module = useCallModule();
  const fallback = useAssetIcon("minecraft/offline-session.png");
  const [head, setHead] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setHead(null);
    loadHead(call_module, name).then((h) => { if (!cancelled) setHead(h); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name]);

  const src = head ?? fallback;
  return (
    <span className="modpack-session-avatar">
      {src ? <img src={src} alt="" /> : <AccountIcon width={18} height={18} />}
    </span>
  );
}

/**
 * Opens the "Player profiles" page (`/profiles`), the one place profiles are managed. Provided at
 * the module root because `SessionSelector` only exists while `/play` is mounted.
 */
export const ProfileManagerContext = createContext<(() => void) | null>(null);

function useOpenProfileManager(): () => void {
  const open = useContext(ProfileManagerContext);
  return open ?? (() => {});
}

/**
 * Reads the named local ("offline") sessions and which one is the default from
 * `{gamePath}/game.nihao` (Rust `get_profiles`, `library::session`). Stored in the module's own
 * save file rather than browser storage so it shows up when `game.nihao` is opened directly.
 */
export async function fetchProfiles(call_module: CallModuleFn): Promise<ProfilesResponse> {
  const res: any = await call_module("get_profiles", {});
  const profiles: OfflineProfile[] = Array.isArray(res?.profiles) ? res.profiles : [];
  return { profiles, defaultProfileId: res?.default_profile_id ?? null };
}

export async function persistProfiles(
  call_module: CallModuleFn,
  profiles: OfflineProfile[],
  defaultProfileId: string | null,
): Promise<void> {
  await call_module("save_profiles", { profiles, default_profile_id: defaultProfileId });
}

/**
 * The login profile the game launches under: one of the player's named offline profiles in
 * `{gamePath}/game.nihao`. Adding/deleting, the default pick and the disabled "Sign in online"
 * placeholder live on the `/profiles` page (`ProfilesPage`). Starts on the default profile on every mount
 * (falls back to the first; a fresh install seeds one "Player" profile and saves it). Reports the
 * effective nickname via `onSessionChange`; `disabled` locks the selector (and closes any open
 * menu) while a session is launching or running.
 */
export function SessionSelector(
  { gamePath, disabled, onSessionChange }:
  { gamePath: string | undefined; disabled?: boolean; onSessionChange?: (nickname: string, profileId: string) => void }
) {
  const call_module = useCallModule();
  // Nickname from first-run onboarding (`LauncherBridge.defaultNickname`) seeds the very first
  // offline profile instead of the generic "Player".
  const defaultNickname = useBridge((b) => b.defaultNickname);
  const [allProfiles, setAllProfiles] = useState<OfflineProfile[]>([]);
  const [profile, setProfile] = useState<string>("");
  // Only the first load picks the default as the current selection; a later refresh must not
  // override the player's pick.
  const [loaded, setLoaded] = useState(false);
  const [open, setOpen] = useState(false);
  const openProfileManager = useOpenProfileManager();
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!gamePath || loaded) return;
    let cancelled = false;
    (async () => {
      const data = await fetchProfiles(call_module);
      let profiles = data.profiles;
      let defaultId = data.defaultProfileId;
      if (profiles.length === 0) {
        const seeded: OfflineProfile = { id: crypto.randomUUID(), name: defaultNickname?.trim() || "Player", service: "offline" };
        profiles = [seeded];
        defaultId = seeded.id;
        await persistProfiles(call_module, profiles, defaultId);
      }
      if (cancelled) return;
      setAllProfiles(profiles);
      setProfile(defaultId ?? profiles[0].id);
      setLoaded(true);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gamePath, loaded]);

  useEffect(() => {
    if (!open) return;
    function handlePointerDown(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpen(false);
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  const current = allProfiles.find((p) => p.id === profile) ?? allProfiles[0] ?? { id: "", name: "…" };

  // How `MinecraftLaunch` learns which nickname and profile to launch under.
  useEffect(() => {
    if (loaded) onSessionChange?.(current.name, current.id);
  }, [loaded, current.name, current.id, onSessionChange]);

  async function handleToggle() {
    if (!open && gamePath) {
      // Re-read on open: the profile manager edits the same file and may have run since mount.
      const data = await fetchProfiles(call_module);
      setAllProfiles(data.profiles);
    }
    setOpen((v) => !v);
  }

  return (
    <div className="modpack-session-selector" ref={menuRef}>
      <button
        className="modpack-launch-btn modpack-session-btn"
        onClick={handleToggle}
        disabled={disabled}
        title={disabled ? t("minecraft.launch.session_locked_while_running", "Can't change while running") : undefined}
      >
        <ProfileAvatar name={current.name} />
        <span className="modpack-session-info">
          <span className="modpack-session-name">{current.name}</span>
          <span className="modpack-session-type"><ProfileKind service={current.service} /></span>
        </span>
        <ChevronDownIcon width={16} height={16} />
      </button>
      {open && !disabled && (
        <div className="modpack-session-menu">
          {allProfiles.map((p) => (
            <button
              key={p.id}
              className={p.id === profile ? "active" : ""}
              onClick={() => { setProfile(p.id); setOpen(false); }}
            >
              <ProfileAvatar name={p.name} />
              <span className="modpack-session-info">
                <span className="modpack-session-name">{p.name}</span>
                <span className="modpack-session-type"><ProfileKind service={p.service} /></span>
              </span>
            </button>
          ))}

          <button onClick={() => { openProfileManager(); setOpen(false); }}>
            <span className="modpack-session-avatar modpack-session-avatar-icon">
              <SettingsIcon width={16} height={16} />
            </span>
            <span className="modpack-session-info">
              <span className="modpack-session-name">{t("minecraft.launch.profile_manager", "Player profiles")}</span>
            </span>
          </button>
        </div>
      )}
    </div>
  );
}
