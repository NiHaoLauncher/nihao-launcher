import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/tauri";
import { t } from "@shared";
import SocialPanel from "../components/SocialPanel";
import { getProfile, type AuthUser } from "../launcher/api";
import { useClientStore } from "../state/Client";
import { useLocalization } from "../state/Localization";
import "../state/Theme";
import "./SocialWindow.css";

/** How often the account is re-checked while the window is open (the friends list has its own poll). */
const SESSION_MS = 20000;

/**
 * Root of the friends window: a second OS window running this app (`?window=social`, see
 * `main.tsx`). It has no connection of its own: the session lives in the launcher backend, shared
 * by both windows. Clicking a profile hands the route to the main window.
 */
export default function SocialWindow() {
  const [user, setUser] = useState<AuthUser | null | undefined>(undefined); // undefined = still asking
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    void useClientStore.getState().hydrate().then(() => {
      const lang = useClientStore.getState().localClient?.interface.language ?? "en_us";
      void useLocalization.getState().load(lang);
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    const check = () => {
      getProfile()
        .then((p) => { if (!cancelled) { setUser({ login: p.login, displayname: p.displayname, avatar: p.avatar ?? null }); setFailure(null); } })
        .catch((e) => { if (!cancelled) { setUser(null); setFailure(String(e)); } });
    };
    check();
    const interval = setInterval(check, SESSION_MS);
    return () => { cancelled = true; clearInterval(interval); };
  }, []);

  const openProfile = (login?: string) => {
    void invoke("show_main_and_navigate", { path: login ? `/profile/${encodeURIComponent(login)}` : "/profile" }).catch(console.error);
  };

  return (
    <div className="social-window">
      {user ? (
        // The session is valid; whether the player is in a game is known only to the main window.
        <SocialPanel user={user} own="online" onOpenProfile={openProfile} />
      ) : (
        <p className="social-window-note">
          {user === undefined
            ? t("social_window_loading", "Loading...")
            : t("social_window_signed_out", "Not signed in. Sign in from the launcher to see your friends.")}
          {failure && <small className="social-window-error">{failure}</small>}
        </p>
      )}
    </div>
  );
}
