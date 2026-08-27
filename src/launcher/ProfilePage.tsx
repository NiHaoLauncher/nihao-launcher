import { useEffect, useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { invoke } from "@tauri-apps/api/tauri";
import { t } from "@shared";
import { useAuth } from "../context/AuthContext";
import AccountIcon from "../assets/profile.png";
import "./ProfilePage.css";

type GameInfoState =
  | { status: "loading" }
  | { status: "ready"; data: Record<string, any> }
  | { status: "error" };

export default function ProfilePage() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [modules, setModules] = useState<string[]>([]);
  const [activeModule, setActiveModule] = useState<string | null>(null);
  const [gameInfo, setGameInfo] = useState<Record<string, GameInfoState>>({});

  useEffect(() => {
    invoke("list_modules").then((res: any) => {
      const list = res as string[];
      setModules(list);
      setActiveModule((current) => current ?? list[0] ?? null);
    }).catch(console.error);
  }, []);

  // Each installed module runs its own server (see API.md) that identifies the user and
  // reports activity — `get_user_info` is the generic method contract for that. A module
  // that hasn't implemented it yet fails cleanly ("Method not found in service"), so this
  // just shows an "unavailable" state for that tab rather than breaking the page.
  useEffect(() => {
    if (!activeModule || gameInfo[activeModule]) return;
    setGameInfo((prev) => ({ ...prev, [activeModule]: { status: "loading" } }));
    invoke("call_module", { module: activeModule, method: "get_user_info", args: {} })
      .then((data: any) => {
        setGameInfo((prev) => ({ ...prev, [activeModule]: { status: "ready", data: data ?? {} } }));
      })
      .catch(() => {
        setGameInfo((prev) => ({ ...prev, [activeModule]: { status: "error" } }));
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeModule]);

  if (!user) {
    return <Navigate to="/home" />;
  }

  async function handleLogout() {
    await logout();
    navigate("/home");
  }

  const activeInfo = activeModule ? gameInfo[activeModule] : null;

  return (
    <div className="profile-page">
      <aside className="profile-sidebar">
        <img
          src={user.avatar || AccountIcon}
          className="profile-avatar"
        />
        <h2 className="profile-name">{user.displayname}</h2>
        <p className="profile-login">@{user.login}</p>

        {user.role && (
          <div className="profile-field">
            <label>{t("title_role", "Role")}</label>
            <p>{user.role}</p>
          </div>
        )}

        <button className="profile-logout-btn" onClick={handleLogout}>
          {t("button_logout", "Log out")}
        </button>
      </aside>

      <section className="profile-games">
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
      </section>
    </div>
  );
}
