import { FormEvent, useState } from "react";
import { Modal } from "@shared";
import { t } from "@shared";
import { useAuth } from "../../context/AuthContext";

export default function ManageProfileModal({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const { changePassword } = useAuth();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [saving, setSaving] = useState(false);

  function handleClose() {
    setCurrentPassword("");
    setNewPassword("");
    setConfirmPassword("");
    setError(null);
    setSuccess(false);
    onClose();
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(false);
    if (newPassword !== confirmPassword) {
      setError(t("error_password_mismatch", "New passwords don't match"));
      return;
    }
    setSaving(true);
    try {
      await changePassword(currentPassword, newPassword);
      setSuccess(true);
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  const canSubmit = !saving && !!currentPassword && !!newPassword && !!confirmPassword;

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      title={t("title_manage_profile", "Manage profile")}
      size="small"
      footer={
        <button
          type="submit"
          form="change-password-form"
          className="settings-save-btn"
          disabled={!canSubmit}
        >
          {saving ? t("save_button_processing", "Saving...") : t("button_change_password", "Change password")}
        </button>
      }
    >
      <form id="change-password-form" className="settings-tab" onSubmit={handleSubmit}>
        <div className="settings-field">
          <label>{t("field_current_password", "Current password")}</label>
          <input
            type="password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            autoComplete="current-password"
          />
        </div>
        <div className="settings-field">
          <label>{t("field_new_password", "New password")}</label>
          <input
            type="password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            autoComplete="new-password"
          />
        </div>
        <div className="settings-field">
          <label>{t("field_confirm_password", "Confirm new password")}</label>
          <input
            type="password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            autoComplete="new-password"
          />
        </div>
        {error && <p className="settings-form-error">{error}</p>}
        {success && (
          <p className="settings-form-success">
            {t("status_password_changed", "Password changed successfully")}
          </p>
        )}
      </form>
    </Modal>
  );
}
