import { FormEvent, useEffect, useState } from "react";
import { open as openFileDialog } from "@tauri-apps/api/dialog";
import { Modal, t } from "@shared";
import { useAuth } from "../context/AuthContext";
import { getProfile, updateProfile, uploadAvatar, Profile } from "./api";
import AccountIcon from "../assets/profile.png";

/** Own-profile editor — `displayname`/`description` (`PATCH /profile/me`) and the avatar
 *  (`POST /profile/me/avatar`), the "Customize" button on `ProfilePage`. */
export default function CustomizeProfileModal({
  isOpen, onClose, profile, onUpdated,
}: {
  isOpen: boolean;
  onClose: () => void;
  profile: Profile | null;
  onUpdated: (profile: Profile) => void;
}) {
  const { status } = useAuth();
  const signedIn = status === "authenticated";
  const [displayname, setDisplayname] = useState("");
  const [description, setDescription] = useState("");
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    if (!isOpen || !profile) return;
    setDisplayname(profile.displayname);
    setDescription(profile.description ?? "");
    setAvatarPreview(profile.avatar ?? null);
    setError(null);
    setSuccess(false);
  }, [isOpen, profile]);

  async function handlePickAvatar() {
    if (!signedIn) return;
    setError(null);
    try {
      const picked = await openFileDialog({
        multiple: false,
        filters: [{ name: "Image", extensions: ["png", "jpg", "jpeg", "webp", "gif"] }],
      });
      if (!picked || Array.isArray(picked)) return;
      setUploadingAvatar(true);
      const url = await uploadAvatar(picked);
      setAvatarPreview(url);
      // Upload persists server-side at once (unlike displayname/description, which wait for Save),
      // so propagate now: `user.avatar` would otherwise go stale if the modal closes without Save.
      if (profile) onUpdated({ ...profile, avatar: url });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setUploadingAvatar(false);
    }
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!signedIn || !profile) return;
    setSaving(true);
    setError(null);
    setSuccess(false);
    try {
      const trimmedName = displayname.trim();
      const trimmedDesc = description.trim();
      const newName = trimmedName && trimmedName !== profile.displayname ? trimmedName : null;
      const newDesc = trimmedDesc !== (profile.description ?? "") ? trimmedDesc : null;
      if (newName || newDesc) {
        await updateProfile(newName, newDesc);
      }
      const fresh = await getProfile();
      setSuccess(true);
      onUpdated(fresh);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={t("title_customize_profile", "Customize profile")}
      size="small"
      footer={
        <button type="submit" form="customize-profile-form" className="settings-save-btn" disabled={saving}>
          {saving ? t("save_button_processing", "Saving...") : t("button_save", "Save")}
        </button>
      }
    >
      <form id="customize-profile-form" className="settings-tab" onSubmit={handleSubmit}>
        <div className="settings-field" style={{ alignItems: "center" }}>
          <img
            src={avatarPreview || AccountIcon}
            alt=""
            style={{
              width: 80, height: 80, borderRadius: "50%", objectFit: "cover",
              cursor: uploadingAvatar ? "default" : "pointer", opacity: uploadingAvatar ? 0.6 : 1,
            }}
            onClick={uploadingAvatar ? undefined : handlePickAvatar}
            title={t("button_change_avatar", "Change avatar")}
          />
          {uploadingAvatar && <p>{t("status_uploading", "Uploading...")}</p>}
        </div>
        <div className="settings-field">
          <label>{t("field_display_name", "Display name")}</label>
          <input type="text" value={displayname} onChange={(e) => setDisplayname(e.target.value)} />
        </div>
        <div className="settings-field">
          <label>{t("field_description", "About")}</label>
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} />
        </div>
        {error && <p className="settings-form-error">{error}</p>}
        {success && <p className="settings-form-success">{t("status_profile_updated", "Profile updated")}</p>}
      </form>
    </Modal>
  );
}
