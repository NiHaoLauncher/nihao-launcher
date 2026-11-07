import { useState } from "react";
import type { AuthUser } from "../launcher/api";
import { t } from "@shared";
import { friendStatus, useSocial, useSocialSync, type FriendStatus } from "../state/Social";
import InviteFriendModal from "./InviteFriendModal";
import FriendRequestsModal from "./FriendRequestsModal";
import "./SocialPanel.css";
import PersonPlusIcon from "@shared/assets/icons/person-plus.svg?react";
import PeopleIcon from "@shared/assets/icons/people.svg?react";

function initials(name: string): string {
  return name.trim().slice(0, 2).toUpperCase() || "?";
}



/**
 * The friends view (fills the friends window): own account pinned on top, invite/requests buttons,
 * friends list below. No routing, no knowledge of the launcher's session; the caller says who the
 * player is and what a profile click does.
 */
export default function SocialPanel({
  user,
  own,
  onOpenProfile,
}: {
  user: AuthUser;
  own: FriendStatus;
  /** `login` = a friend's profile; omitted = the player's own. */
  onOpenProfile: (login?: string) => void;
}) {
  const friends = useSocial((s) => s.friends);
  const incomingCount = useSocial((s) => s.incomingCount);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [requestsOpen, setRequestsOpen] = useState(false);

  useSocialSync(true);

  // The requests modal changes the incoming count itself; refresh the badge on close instead of
  // waiting for the poll.
  function handleRequestsClose() {
    setRequestsOpen(false);
    void useSocial.getState().refresh();
  }

  return (
    <>
      {/*
       * ME, pinned at the top. No endpoint reads back the launcher's own activity yet, so being
       * authenticated counts as "online" here.
       */}
      <div className="social-me" onClick={() => onOpenProfile()} role="button" title={t("title_view_profile", "View profile")}>
        <span className={`social-avatar-wrap social-status-${own}`}>
          {user.avatar ? (
            <img className="social-avatar" src={user.avatar} alt="" />
          ) : (
            <span className="social-avatar social-avatar-fallback">{initials(user.displayname)}</span>
          )}
        </span>
        <span className="social-friend-info">
          <span className="social-friend-name">{user.displayname}</span>
          <span className="social-friend-activity">
            {own === "playing" ? t("social_playing", "Playing") : own === "online" ? t("social_online", "Online") : t("social_offline", "Offline")}
          </span>
        </span>
      </div>

      <div className="social-actions">
        <button className="social-action-btn" onClick={() => setInviteOpen(true)} title={t("button_invite_friend", "Invite a friend")}>
          <PersonPlusIcon width={16} height={16} />
          <span>{t("button_invite", "Invite")}</span>
        </button>
        <button className="social-action-btn" onClick={() => setRequestsOpen(true)} title={t("title_friend_requests", "Friend requests")}>
          <PeopleIcon width={16} height={16} />
          <span>{t("button_requests", "Requests")}</span>
          {incomingCount > 0 && <span className="social-badge">{incomingCount}</span>}
        </button>
      </div>

      <InviteFriendModal isOpen={inviteOpen} onClose={() => setInviteOpen(false)} />
      <FriendRequestsModal isOpen={requestsOpen} onClose={handleRequestsClose} />

      <div className="social-content">
        {friends.length === 0 ? (
          <span className="social-empty">{t("social_no_friends", "No friends yet")}</span>
        ) : (
          friends.map((f) => (
            <div
              key={f.login}
              className="social-friend"
              onClick={() => onOpenProfile(f.login)}
              role="button"
              title={f.displayname}
            >
              <span className={`social-avatar-wrap social-status-${friendStatus(f)}`}>
                {f.avatar ? (
                  <img className="social-avatar" src={f.avatar} alt="" />
                ) : (
                  <span className="social-avatar social-avatar-fallback">{initials(f.displayname)}</span>
                )}
              </span>
              <span className="social-friend-info">
                <span className="social-friend-name">{f.displayname}</span>
                <span className="social-friend-activity">
                  {friendStatus(f) === "online" ? t("social_online", "Online") : t("social_offline", "Offline")}
                </span>
              </span>
            </div>
          ))
        )}
      </div>
    </>
  );
}
