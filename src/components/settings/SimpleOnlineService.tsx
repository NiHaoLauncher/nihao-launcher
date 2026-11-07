import { t } from "@shared";
import type { LinkState, OnlineServiceProps } from "@shared";
import RefreshIcon from "@shared/assets/icons/refresh.svg?react";

/** The dot colour classes of the plain design, per link state. */
const DOT: Record<LinkState, string> = {
  locked: "authenticated",
  standby: "anonymous",
  searching: "connecting",
  lost: "unavailable",
};


/** The built-in Online Service page: a plain row per connection. A theme replaces it with its own
 *  (`slots.OnlineService`); the props are the same. */
export default function SimpleOnlineService(p: OnlineServiceProps) {
  return (
    <div className="settings-tab">
      <h3>{t("title_online_service", "Online Service")}</h3>

      <div className="settings-online-status">
        <span className={`settings-status-dot settings-status-${DOT[p.uplink.state]}`} />
        <span className="settings-online-status-text">
          {p.uplink.label} • {p.uplink.account}
        </span>
        <div className="settings-online-actions">
          <button
            className={`settings-icon-btn settings-refresh-btn${p.refreshing ? " refreshing" : ""}`}
            title={t("button_refresh", "Refresh")}
            disabled={p.refreshing}
            onClick={p.onRefresh}
          >
            <RefreshIcon width={18} height={18} />
          </button>
          {p.canSignIn && (
            <button className="settings-secondary-btn" onClick={p.onSignIn}>
              {t("button_login", "Sign in")}
            </button>
          )}
        </div>
      </div>

      {p.servers.map((svc) => (
        <div className="settings-online-status" key={svc.id}>
          {svc.icon && <img src={svc.icon} alt="" className="settings-service-icon" />}
          <span className={`settings-status-dot settings-status-${DOT[svc.state]}`} />
          <span className="settings-online-status-text">
            {svc.name} • {svc.label}
          </span>
        </div>
      ))}

      {p.canManageProfile && (
        <button className="settings-secondary-btn settings-manage-profile-btn" onClick={p.onManageProfile}>
          {t("button_manage_profile", "Manage profile")}
        </button>
      )}
    </div>
  );
}
