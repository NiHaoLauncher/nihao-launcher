import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/tauri";
import { getVersion } from "@tauri-apps/api/app";
import { open as openExternalUrl } from "@tauri-apps/api/shell";
import { t } from "@shared";
import { getGameConfig, GameAbout } from "../../games/GameRegistry";
import NIHAO_ICON from "@shared/assets/nihao-icon.png";
import ExternalLinkIcon from "@shared/assets/icons/external-link.svg?react";

const LAUNCHER_LINKS = [
  { label: "GitHub", url: "https://github.com/BogdanCater/nihao-launcher" },
  { label: "GitLab", url: "https://gitlab.com/BogdanCater/nihao-launcher" },
];

function Links({ links }: { links: { label: string; url: string }[] }) {
  return (
    <div className="settings-about-links">
      {links.map((l) => (
        <button key={l.url} className="settings-secondary-btn" onClick={() => openExternalUrl(l.url).catch(console.error)}>
          {l.label}
          <ExternalLinkIcon width={14} height={14} />
        </button>
      ))}
    </div>
  );
}

/** Settings > About: the launcher's own version and links, then one block per installed game
 *  module that declares `about` in its config (only its own info). */
export default function AboutSettingsTab() {
  const [version, setVersion] = useState("");
  const [games, setGames] = useState<{ id: string; name: string; icon?: string; about: GameAbout }[]>([]);

  useEffect(() => {
    getVersion().then(setVersion).catch(console.error);
    invoke<string[]>("list_modules")
      .then((ids) => Promise.all(ids.map(async (id) => ({ id, cfg: await getGameConfig(id) }))))
      .then((all) =>
        setGames(all.filter((g) => g.cfg.about).map((g) => ({ id: g.id, name: g.cfg.name, icon: g.cfg.icon || undefined, about: g.cfg.about! }))),
      )
      .catch(console.error);
  }, []);

  return (
    <div className="settings-tab">
      <div className="settings-about-card settings-about-main">
        <img src={NIHAO_ICON} alt="" className="settings-about-logo" />
        <div className="settings-about-main-text">
          <div className="settings-about-head">
            <h3>NiHao Launcher</h3>
            {version && <span className="settings-about-version">v{version}</span>}
          </div>
          <p className="settings-hint">{t("about_launcher_description", "A modular launcher for games, their mods and modpacks.")}</p>
          <Links links={LAUNCHER_LINKS} />
        </div>
      </div>

      {games.map((g) => (
        <div className="settings-about-card" key={g.id}>
          <div className="settings-about-head">
            {g.icon && <img src={g.icon} alt="" className="settings-service-icon" />}
            <h3>{g.name}</h3>
            {g.about.version && <span className="settings-about-version">v{g.about.version}</span>}
          </div>
          {g.about.description && <p className="settings-hint">{t(`${g.id}.about.description`, g.about.description)}</p>}
          {g.about.links && <Links links={g.about.links} />}
          {g.about.components?.map((c) => (
            <div className="settings-about-component" key={c.name}>
              <div className="settings-about-head">
                <h4>{c.name}</h4>
                {c.version && <span className="settings-about-version">v{c.version}</span>}
              </div>
              {c.description && <p className="settings-hint">{t(`${g.id}.about.${c.name.toLowerCase().replace(/[^a-z0-9]+/g, "_")}.description`, c.description)}</p>}
              {c.links && <Links links={c.links} />}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
