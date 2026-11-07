import { FormEvent, useState } from "react";
import { Modal, t } from "@shared";
import { sendFriendRequest } from "../launcher/api";

/**
 * `POST /friends/{login}/request`: a mutual request becomes a friendship at once (see API.md);
 * otherwise it stays pending in "Friend requests" until accepted.
 */
export default function InviteFriendModal(
  { isOpen, onClose }: { isOpen: boolean; onClose: () => void }
) {
  const [login, setLogin] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  function handleClose() {
    setLogin("");
    setError(null);
    setSent(false);
    onClose();
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const target = login.trim();
    if (!target) return;
    setSending(true);
    setError(null);
    try {
      await sendFriendRequest(target);
      setSent(true);
      setLogin("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      title={t("title_invite_friend", "Invite a friend")}
      size="small"
      footer={
        <button type="submit" form="invite-friend-form" className="settings-save-btn" disabled={sending || !login.trim()}>
          {sending ? t("save_button_processing", "Saving...") : t("button_send_request", "Send request")}
        </button>
      }
    >
      <form id="invite-friend-form" className="settings-tab" onSubmit={handleSubmit}>
        <div className="settings-field">
          <label>{t("field_login", "Login")}</label>
          <input
            type="text"
            value={login}
            onChange={(e) => { setLogin(e.target.value); setSent(false); }}
            autoFocus
          />
        </div>
        {error && <p className="settings-form-error">{error}</p>}
        {sent && <p className="settings-form-success">{t("status_request_sent", "Friend request sent")}</p>}
      </form>
    </Modal>
  );
}
