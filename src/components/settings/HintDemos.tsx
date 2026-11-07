import { t } from "@shared";
import { useAuth } from "../../context/AuthContext";
import minecraftIcon from "../../assets/hints/minecraft.png";
import launcherIcon from "../../assets/hints/launcher.png";
import "./HintDemos.css";

/** Live (pure CSS) previews for HoverHint's `demo` — they play regardless of the "Interface animations" setting. */

/** The same window popping up with and without animation, looping. */
export function AnimationsDemo() {
  const pane = (label: string, cls: string) => (
    <div className="demo-anim-col">
      <div className="demo-anim-screen">
        <div className={`demo-anim-win ${cls}`}><i /><i /></div>
      </div>
      <span>{label}</span>
    </div>
  );
  return (
    <div className="demo demo-anim">
      {pane(t("value_on", "on"), "demo-anim-smooth")}
      {pane(t("value_off", "off"), "demo-anim-instant")}
    </div>
  );
}

const states = () => [
  t("presence_demo_menu", "In the menu"),
  t("presence_demo_singleplayer", "Playing singleplayer"),
  t("presence_demo_multiplayer", "Playing multiplayer"),
];

/** A Discord profile with the activity the launcher sets: Minecraft large, the launcher as the small badge. */
export function DiscordPresenceDemo() {
  const { user } = useAuth();
  const name = user?.displayname || user?.login || t("presence_demo_user", "Player");
  return (
    <div className="demo demo-discord">
      <div className="demo-discord-user">
        {user?.avatar
          ? <img className="demo-discord-avatar" src={user.avatar} alt="" />
          : <span className="demo-discord-avatar demo-discord-avatar-letter">{name.charAt(0).toUpperCase()}</span>}
        <b>{name}</b>
      </div>
      <div className="demo-discord-activity">
        <span className="demo-discord-head">{t("presence_demo_playing", "Playing")}</span>
        <div className="demo-discord-card">
          <div className="demo-discord-art">
            <img src={minecraftIcon} alt="" />
            <img className="demo-discord-badge" src={launcherIcon} alt="" />
          </div>
          <div className="demo-discord-text">
            <b>NiHao Launcher</b>
            <span>{t("presence_demo_pack", "My modpack")}</span>
            <span className="demo-discord-states">
              {states().map((s, i) => <em key={i} style={{ animationDelay: `${i * 3}s` }}>{s}</em>)}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
