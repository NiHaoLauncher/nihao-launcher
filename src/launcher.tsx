import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { invoke } from "@tauri-apps/api/tauri";
import { getGameConfig, GameConfig } from "./games/GameRegistry";
import { useClient } from "./context/ClientContext";
import "./launcher.css";

export function ConnectPage() {
  return
}

/**
 * Result of a plugin's optional `get_home_preview`, shown in the hover flyout as a count
 * ("Modpacks: 3"). `label` names what `items` lists. A plugin without the command is skipped.
 */
interface HomePreview {
  label?: string;
  items?: string[];
}

/** Every installed game/module as a tile. */
export function LibraryPage() {
  const navigate = useNavigate();
  const { localClient } = useClient();
  const [modules, setModules] = useState<string[]>([]);
  const [configs, setConfigs] = useState<Record<string, GameConfig>>({});
  const [previews, setPreviews] = useState<Record<string, HomePreview | null>>({});
  const [hovered, setHovered] = useState<string | null>(null);

  useEffect(() => {
    invoke("list_modules").then((res: any) => setModules(res)).catch(console.error);
  }, []);

  useEffect(() => {
    let cancelled = false;
    modules.forEach((mod) => {
      getGameConfig(mod).then((cfg) => {
        if (!cancelled) setConfigs((prev) => ({ ...prev, [mod]: cfg }));
      }).catch(console.error);
    });
    return () => { cancelled = true; };
  }, [modules]);

  // Fetched lazily on first hover and cached; most sessions hover only a few tiles.
  function handleHover(mod: string) {
    setHovered(mod);
    if (previews[mod] !== undefined) return;
    const path = localClient?.games?.[mod]?.path ?? configs[mod]?.defaultPath;
    if (!path) return;
    invoke("call_module", { module: mod, method: "get_home_preview", args: { path } })
      .then((res: any) => setPreviews((prev) => ({ ...prev, [mod]: res ?? null })))
      .catch(() => setPreviews((prev) => ({ ...prev, [mod]: null })));
  }

  if (modules.length === 0) {
    return (
      <div style={{ padding: "24px", color: "var(--text-secondary-color)" }}>
        No games installed yet.
      </div>
    );
  }

  return (
    <div className="home-games-grid">
      {modules.map((mod) => {
        const cfg = configs[mod];
        const preview = previews[mod];
        const isHovered = hovered === mod;
        return (
          <div
            key={mod}
            className={`home-game-tile${hovered && !isHovered ? " dimmed" : ""}`}
            onClick={() => navigate(`/gm/${mod}`)}
            onMouseEnter={() => handleHover(mod)}
            onMouseLeave={() => setHovered((h) => (h === mod ? null : h))}
          >
            {cfg?.banner ? (
              <img src={cfg.banner} className="home-game-tile-img" />
            ) : (
              <div className="home-game-tile-placeholder">{mod.substring(0, 2).toUpperCase()}</div>
            )}

            <div className={`home-game-tile-flyout${isHovered ? " visible" : ""}`}>
              {cfg?.banner && <img src={cfg.banner} className="home-game-tile-flyout-img" />}
              <div className="home-game-tile-flyout-info">
                <div className="home-game-tile-flyout-name">{cfg?.name ?? mod}</div>
                {preview?.items && preview.label && (
                  <div className="home-game-tile-flyout-stat">
                    <span className="home-game-tile-flyout-stat-label">{preview.label}</span>
                    <span className="home-game-tile-flyout-stat-value">{preview.items.length}</span>
                  </div>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
