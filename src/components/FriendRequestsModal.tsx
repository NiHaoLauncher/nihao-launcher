import { useEffect, useState } from "react";
import { Modal, t } from "@shared";
import {
  FriendRequest,
  acceptFriendRequest,
  declineFriendRequest,
  getFriendRequests,
} from "../launcher/api";
import "./FriendRequestsModal.css";
import CheckIcon from "@shared/assets/icons/check.svg?react";
import CloseIcon from "@shared/assets/icons/close.svg?react";

function initials(name: string): string {
  return name.trim().slice(0, 2).toUpperCase() || "?";
}



/**
 * `GET /friends/requests`, both directions (see API.md). Incoming can be accepted or declined;
 * outgoing only shows as pending (no cancel endpoint yet).
 */
export default function FriendRequestsModal(
  { isOpen, onClose }: { isOpen: boolean; onClose: () => void }
) {
  const [incoming, setIncoming] = useState<FriendRequest[]>([]);
  const [outgoing, setOutgoing] = useState<FriendRequest[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyLogin, setBusyLogin] = useState<string | null>(null);

  function refresh() {
    getFriendRequests()
      .then((res) => {
        setIncoming(res.incoming);
        setOutgoing(res.outgoing);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }

  useEffect(() => {
    if (isOpen) refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  async function handleAccept(login: string) {
    setBusyLogin(login);
    setError(null);
    try {
      await acceptFriendRequest(login);
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyLogin(null);
    }
  }

  async function handleDecline(login: string) {
    setBusyLogin(login);
    setError(null);
    try {
      await declineFriendRequest(login);
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyLogin(null);
    }
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={t("title_friend_requests", "Friend requests")} size="small">
      <div className="settings-tab">
        <div className="settings-field">
          <label>{t("title_incoming_requests", "Incoming")}</label>
          {incoming.length === 0 ? (
            <p className="friend-request-hint">{t("status_no_incoming_requests", "No incoming requests")}</p>
          ) : (
            <div className="friend-request-list">
              {incoming.map((r) => (
                <div key={r.login} className="friend-request-row">
                  <span className="friend-request-avatar">
                    {r.avatar ? <img src={r.avatar} alt="" /> : initials(r.displayname)}
                  </span>
                  <span className="friend-request-name">{r.displayname}</span>
                  <button
                    className="settings-icon-btn"
                    disabled={busyLogin === r.login}
                    title={t("button_accept_request", "Accept")}
                    onClick={() => handleAccept(r.login)}
                  >
                    <CheckIcon width={16} height={16} />
                  </button>
                  <button
                    className="settings-icon-btn"
                    disabled={busyLogin === r.login}
                    title={t("button_decline_request", "Decline")}
                    onClick={() => handleDecline(r.login)}
                  >
                    <CloseIcon width={16} height={16} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="settings-field">
          <label>{t("title_outgoing_requests", "Outgoing")}</label>
          {outgoing.length === 0 ? (
            <p className="friend-request-hint">{t("status_no_outgoing_requests", "No outgoing requests")}</p>
          ) : (
            <div className="friend-request-list">
              {outgoing.map((r) => (
                <div key={r.login} className="friend-request-row">
                  <span className="friend-request-avatar">
                    {r.avatar ? <img src={r.avatar} alt="" /> : initials(r.displayname)}
                  </span>
                  <span className="friend-request-name">{r.displayname}</span>
                  <span className="friend-request-hint">{t("status_pending", "Pending")}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {error && <p className="settings-form-error">{error}</p>}
      </div>
    </Modal>
  );
}
