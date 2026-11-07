import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { invoke } from "@tauri-apps/api/tauri";
import { t } from "@shared";
import { useClient } from "../context/ClientContext";
import { getGameConfig, type GameConfig } from "../games/GameRegistry";
import { friendStatus, useSocial } from "../state/Social";

interface Game {
  id: string;
  config: GameConfig | null;
  /** The module's optional `get_home_preview`: `label` names what `items` lists. */
  preview: { label?: string; items?: string[] } | null;
}

/** The games installed, each with the count its module reports (modpacks, ...). */
function useGames(): Game[] {
  const { localClient } = useClient();
  const [games, setGames] = useState<Game[]>([]);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const ids = (await invoke("list_modules").catch(() => [])) as string[];
      const list = await Promise.all(ids.map(async (id): Promise<Game> => {
        const config = await getGameConfig(id).catch(() => null);
        const path = localClient?.games?.[id]?.path ?? config?.defaultPath;
        const preview = path
          ? ((await invoke("call_module", { module: id, method: "get_home_preview", args: { path } }).catch(() => null)) as Game["preview"])
          : null;
        return { id, config, preview };
      }));
      if (!cancelled) setGames(list);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return games;
}

/** Extra blocks of the main page; the page shows them only when the window is big enough. */
export function HomeWidgets() {
  const navigate = useNavigate();
  const games = useGames();
  const friends = useSocial((s) => s.friends);
  const online = friends.filter((f) => friendStatus(f) === "online");

  return (
    <div className="home-widgets">
      <section className="home-widget">
        <h3 className="news-title">{t("home.games", "Your games")}</h3>
        <div className="home-widget-list">
          {games.map((g) => (
            <button type="button" key={g.id} className="home-widget-row" onClick={() => navigate(`/gm/${g.id}`)}>
              {g.config?.icon ? <img src={g.config.icon} alt="" /> : <span className="home-widget-noicon">{g.id.slice(0, 2).toUpperCase()}</span>}
              <span>{g.config?.name ?? g.id}</span>
              {g.preview?.items && g.preview.label && <small>{g.preview.label}: {g.preview.items.length}</small>}
            </button>
          ))}
        </div>
      </section>
      <section className="home-widget">
        <h3 className="news-title">{t("home.friends_online", "Friends online")} · {online.length}</h3>
        <div className="home-widget-list">
          {online.length === 0 && <p className="news-empty">{t("home.friends_none", "Nobody is online")}</p>}
          {online.slice(0, 6).map((f) => (
            <button type="button" key={f.login} className="home-widget-row" onClick={() => navigate(`/profile/${f.login}`)}>
              {f.avatar ? <img src={f.avatar} alt="" /> : <span className="home-widget-noicon">{f.displayname.slice(0, 2).toUpperCase()}</span>}
              <span>{f.displayname}</span>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}
