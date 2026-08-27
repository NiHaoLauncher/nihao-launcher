import { useState } from "react";
import { t } from "@shared";
import { useAuth } from "../../context/AuthContext";
import GetUserData from "../../launcher/Authorization";
import ManageProfileModal from "./ManageProfileModal";

function RefreshIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true">
      <path d="M12 5V2L7 6l5 4V7a5 5 0 1 1-4.9 6H5.06A7 7 0 1 0 12 5Z" />
    </svg>
  );
}

export default function OnlineServiceTab() {
  const { status, user, reconnect } = useAuth();
  const [showLogin, setShowLogin] = useState(false);
  const [manageProfileOpen, setManageProfileOpen] = useState(false);

  const connected = status === "authenticated" || status === "anonymous";
  const connectionLabel = status === "connecting"
    ? t("status_connecting", "Connecting...")
    : connected
      ? t("status_connected", "Connected")
      : t("status_disconnected", "Not connected");

  const loginLabel = status === "authenticated"
    ? t("status_signed_in", "Signed in") + (user ? ` (${user.displayname})` : "")
    : t("status_signed_out", "Not signed in");

  function handleLoginClick() {
    setShowLogin(true);
  }

  return (
    <div className="settings-tab">
      <h3>{t("title_online_service", "Online Service")}</h3>

      <div className="settings-online-status">
        <span className={`settings-status-dot settings-status-${status}`} />
        <span className="settings-online-status-text">
          {connectionLabel} • {loginLabel}
        </span>
        <div className="settings-online-actions">
          <button
            className="settings-icon-btn"
            title={t("button_refresh", "Refresh")}
            disabled={status === "connecting"}
            onClick={reconnect}
          >
            <RefreshIcon />
          </button>
          {status === "anonymous" && !showLogin && (
            <button className="settings-secondary-btn" onClick={handleLoginClick}>
              {t("button_login", "Sign in")}
            </button>
          )}
        </div>
      </div>

      {status === "anonymous" && showLogin && (
        <div className="settings-online-login">
          <GetUserData />
        </div>
      )}

      {status === "authenticated" && (
        <button className="settings-secondary-btn settings-manage-profile-btn" onClick={() => setManageProfileOpen(true)}>
          {t("button_manage_profile", "Manage profile")}
        </button>
      )}

      <ManageProfileModal isOpen={manageProfileOpen} onClose={() => setManageProfileOpen(false)} />
    </div>
  );
}
