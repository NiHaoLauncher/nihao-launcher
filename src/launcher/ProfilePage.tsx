import { useEffect, useState } from "react";
import { Navigate, useParams } from "react-router-dom";
import { invoke } from "@tauri-apps/api/tauri";
import { t } from "@shared";
import { useAuth } from "../context/AuthContext";
import { Profile, acceptFriendRequest, declineFriendRequest, getProfile, getUserProfile, sendFriendRequest } from "./api";
import AccountIcon from "../assets/profile.png";
import CustomizeProfileModal from "./CustomizeProfileModal";
import "./ProfilePage.css";

type GameInfoState =
  | { status: "loading" }
  | { status: "ready"; data: Record<string, any> }
  | { status: "error" };

type FriendAction = "idle" | "sending" | "accepting" | "declining";

/**
 * `/profile` (own account) or `/profile/:login` (someone else's, from a friend row in
 * `SocialPanel`). Both endpoints return the same shape; `{login}` also carries `friendship`, which
 * decides the action button.
 */
export default function ProfilePage() {
  const { login: routeLogin } = useParams<{ login?: string }>();
  const { user: myUser, status, patchUser } = useAuth();
  const signedIn = status === "authenticated";
  const isOwn = !routeLogin || routeLogin === myUser?.login;

  const [profile, setProfile] = useState<Profile | null>(null);
  const [profileLoading, setProfileLoading] = useState(true);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [customizeOpen, setCustomizeOpen] = useState(false);
  const [friendAction, setFriendAction] = useState<FriendAction>("idle");
  const [friendError, setFriendError] = useState<string | null>(null);

  const [modules, setModules] = useState<string[]>([]);
  const [activeModule, setActiveModule] = useState<string | null>(null);
  const [gameInfo, setGameInfo] = useState<Record<string, GameInfoState>>({});

  useEffect(() => {
    if (!signedIn) return;
    let cancelled = false;
    setProfileLoading(true);
    setProfileError(null);
    setFriendError(null);
    // `/profile/:login?` re-renders the same mounted component on navigation, so clear the
    // previous profile or it stays on screen during (or after a failed) fetch.
    setProfile(null);
    const fetcher = isOwn ? getProfile() : getUserProfile(routeLogin!);
    fetcher
      .then((p) => { if (!cancelled) setProfile(p); })
      .catch((e) => { if (!cancelled) setProfileError(String(e)); })
      .finally(() => { if (!cancelled) setProfileLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signedIn, routeLogin, isOwn]);

  // Per-game info is own-account only: this device's installed modules report their state
  // (`get_user_info`). The server doesn't expose anyone's games yet.
  useEffect(() => {
    if (!isOwn) return;
    invoke("list_modules").then((res: any) => {
      const list = res as string[];
      setModules(list);
      setActiveModule((current) => current ?? list[0] ?? null);
    }).catch(console.error);
  }, [isOwn]);

  useEffect(() => {
    if (!isOwn || !activeModule || gameInfo[activeModule]) return;
    setGameInfo((prev) => ({ ...prev, [activeModule]: { status: "loading" } }));
    invoke("call_module", { module: activeModule, method: "get_user_info", args: {} })
      .then((data: any) => {
        setGameInfo((prev) => ({ ...prev, [activeModule]: { status: "ready", data: data ?? {} } }));
      })
      .catch(() => {
        setGameInfo((prev) => ({ ...prev, [activeModule]: { status: "error" } }));
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeModule, isOwn]);

  if (!myUser) {
    return <Navigate to="/home" />;
  }

  async function handleSendFriendRequest() {
    if (!signedIn || !profile) return;
    setFriendAction("sending");
    setFriendError(null);
    try {
      await sendFriendRequest(profile.login);
      setProfile((prev) => (prev ? { ...prev, friendship: "request_sent" } : prev));
    } catch (e) {
      setFriendError(String(e));
    } finally {
      setFriendAction("idle");
    }
  }

  async function handleAcceptFriendRequest() {
    if (!signedIn || !profile) return;
    setFriendAction("accepting");
    setFriendError(null);
    try {
      await acceptFriendRequest(profile.login);
      setProfile((prev) => (prev ? { ...prev, friendship: "friends" } : prev));
    } catch (e) {
      setFriendError(String(e));
    } finally {
      setFriendAction("idle");
    }
  }

  async function handleDeclineFriendRequest() {
    if (!signedIn || !profile) return;
    setFriendAction("declining");
    setFriendError(null);
    try {
      await declineFriendRequest(profile.login);
      setProfile((prev) => (prev ? { ...prev, friendship: "none" } : prev));
    } catch (e) {
      setFriendError(String(e));
    } finally {
      setFriendAction("idle");
    }
  }

  const activeInfo = activeModule ? gameInfo[activeModule] : null;
  const displayName = profile?.displayname ?? (isOwn ? myUser.displayname : routeLogin ?? "");
  const login = profile?.login ?? (isOwn ? myUser.login : routeLogin ?? "");
  const avatar = profile?.avatar ?? (isOwn ? myUser.avatar : null);

  return (
    <div className="profile-page">
      <aside className="profile-sidebar">
        <img src={avatar || AccountIcon} className="profile-avatar" />
        <h2 className="profile-name">{displayName}</h2>
        <p className="profile-login">@{login}</p>

        {profile?.description && (
          <div className="profile-field">
            <label>{t("title_description", "About")}</label>
            <p>{profile.description}</p>
          </div>
        )}

        {profileLoading && <p className="profile-games-empty">{t("loading", "Loading...")}</p>}
        {profileError && <p className="profile-games-empty">{profileError}</p>}

        {isOwn ? (
          <button className="profile-logout-btn" onClick={() => setCustomizeOpen(true)}>
            {t("button_customize_profile", "Customize")}
          </button>
        ) : (
          profile && (
            <>
              {profile.friendship === "none" && (
                <button className="profile-logout-btn" onClick={handleSendFriendRequest} disabled={friendAction === "sending"}>
                  {friendAction === "sending" ? t("status_sending", "Sending...") : t("button_add_friend", "Add friend")}
                </button>
              )}
              {profile.friendship === "request_sent" && (
                <button className="profile-logout-btn" disabled>
                  {t("status_request_sent", "Request sent")}
                </button>
              )}
              {profile.friendship === "request_received" && (
                <div style={{ display: "flex", gap: "0.5rem", width: "100%" }}>
                  <button
                    className="profile-logout-btn"
                    style={{ flex: 1 }}
                    onClick={handleAcceptFriendRequest}
                    disabled={friendAction !== "idle"}
                  >
                    {t("button_accept", "Accept")}
                  </button>
                  <button
                    className="profile-logout-btn"
                    style={{ flex: 1, backgroundColor: "var(--second-background-color)", color: "var(--text-color)" }}
                    onClick={handleDeclineFriendRequest}
                    disabled={friendAction !== "idle"}
                  >
                    {t("button_decline", "Decline")}
                  </button>
                </div>
              )}
              {profile.friendship === "friends" && (
                <p className="profile-games-empty">{t("status_already_friends", "Already friends")}</p>
              )}
              {friendError && <p className="profile-games-empty">{friendError}</p>}
            </>
          )
        )}
      </aside>

      <section className="profile-games">
        {isOwn ? (
          <>
            <div className="profile-games-tabs">
              {modules.map((mod) => (
                <button
                  key={mod}
                  className={"profile-games-tab" + (mod === activeModule ? " active" : "")}
                  onClick={() => setActiveModule(mod)}
                >
                  {mod.charAt(0).toUpperCase() + mod.slice(1)}
                </button>
              ))}
              {modules.length === 0 && (
                <p className="profile-games-empty">{t("profile_no_games", "No game modules installed")}</p>
              )}
            </div>

            <div className="profile-games-content">
              {activeInfo?.status === "loading" && (
                <p className="profile-games-empty">{t("loading", "Loading...")}</p>
              )}
              {activeInfo?.status === "error" && (
                <p className="profile-games-empty">
                  {t("profile_game_unavailable", "This game hasn't published any profile info yet")}
                </p>
              )}
              {activeInfo?.status === "ready" && (
                Object.keys(activeInfo.data).length === 0 ? (
                  <p className="profile-games-empty">{t("profile_game_no_data", "No info reported for this game")}</p>
                ) : (
                  <div className="profile-games-fields">
                    {Object.entries(activeInfo.data).map(([key, value]) => (
                      <div key={key} className="profile-field">
                        <label>{key}</label>
                        <p>{typeof value === "object" ? JSON.stringify(value) : String(value)}</p>
                      </div>
                    ))}
                  </div>
                )
              )}
            </div>
          </>
        ) : (
          <div className="profile-games-content">
            <p className="profile-games-empty">{t("profile_no_games", "No game modules installed")}</p>
          </div>
        )}
      </section>

      <CustomizeProfileModal
        isOpen={customizeOpen}
        onClose={() => setCustomizeOpen(false)}
        profile={profile}
        onUpdated={(p) => {
          setProfile(p);
          // Patch `useAuth().user` now; otherwise readers only see this after the next reconnect's
          // `auth` event.
          patchUser({ displayname: p.displayname, avatar: p.avatar, description: p.description });
        }}
      />
    </div>
  );
}
