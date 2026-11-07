import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { invoke } from "@tauri-apps/api/tauri";
import { t } from "@shared";
import { useClient } from "../context/ClientContext";
import { getGameConfig } from "../games/GameRegistry";
import { GameModuleRenderer } from "../games/GameLoader";
import { NewsFeed } from "./NewsFeed";
import { HomeWidgets } from "./HomeWidgets";
import "./HomePage.css";

/**
 * The launcher's main page: the game played last, shown by that game's own module (a `view: "home"`
 * mount, so the banner looks like the game), and the news feed (the launcher's and the modules'). Which game
 * is the last one comes from each module's optional `get_home_preview().last_played`.
 */
export function HomePage() {
  const navigate = useNavigate();
  const { localClient } = useClient();
  const [lastGame, setLastGame] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const modules = (await invoke("list_modules").catch(() => [])) as string[];
      const played = await Promise.all(modules.map(async (id) => {
        const path = localClient?.games?.[id]?.path ?? (await getGameConfig(id).catch(() => null))?.defaultPath;
        if (!path) return null;
        const preview: any = await invoke("call_module", { module: id, method: "get_home_preview", args: { path } }).catch(() => null);
        return typeof preview?.last_played === "number" ? { id, at: preview.last_played as number } : null;
      }));
      if (cancelled) return;
      const newest = played.flatMap((p) => (p ? [p] : [])).sort((a, b) => b.at - a.at)[0];
      setLastGame(newest?.id ?? null);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="home-page">
      <section className="home-hero">
        {lastGame ? (
          <GameModuleRenderer gameId={lastGame} view="home" />
        ) : lastGame === null ? (
          <div className="home-empty">
            <h2>{t("home.empty_title", "Nothing played yet")}</h2>
            <p>{t("home.empty_hint", "Pick a game in your library and start it, it will show up here.")}</p>
            <button className="btn-primary" onClick={() => navigate("/library")}>{t("home.open_library", "Open library")}</button>
          </div>
        ) : null}
      </section>
      <NewsFeed />
      <HomeWidgets />
    </div>
  );
}
