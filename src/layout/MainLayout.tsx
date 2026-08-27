import { Outlet, useNavigate } from "react-router-dom";
import AccountIcon from "../assets/profile.png";
import GameLibraryIcon from "../assets/libraryGames.png";
import WinBar from "../components/WinBar";
import InstallIndicator from "../components/InstallIndicator";
import "./MainLayout.css";
import { ReactNode, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/tauri";
import { computeEtapPercent, computeOverallPercent, useInstallStatus } from "../hooks/useInstallStatus";
import { useAuth } from "../context/AuthContext";
import { getGameConfig, GameConfig } from "../games/GameRegistry";

export default function MainLayout({ children }: { children?: ReactNode }) {
  const navigate = useNavigate();
  const { status } = useAuth();
  const [modules, setModules] = useState<string[]>([]);
  const [devModule, setDevModule] = useState<string | null>(null);
  const [configs, setConfigs] = useState<Record<string, GameConfig>>({});
  const installs = useInstallStatus(modules);
  // The bottom bar shows one install as a full progress bar; any others running at the same
  // time show as mini spinners in its top-right corner (see InstallIndicator).
  const activeInstall = installs[0] ?? null;
  const otherInstalls = installs.slice(1);

  useEffect(() => {
    // Fetch list of loaded modules
    invoke("list_modules").then((res: any) => {
      setModules(res);
    }).catch(console.error);

    // Fetch dev module status
    invoke("get_dev_module").then((res: any) => {
      setDevModule(res);
    }).catch(console.error);
  }, []);

  // One config fetch per loaded module (name/icon/banner) — feeds the mainbar's small
  // module tiles below.
  useEffect(() => {
    let cancelled = false;
    modules.forEach((mod) => {
      getGameConfig(mod).then((cfg) => {
        if (!cancelled) setConfigs((prev) => ({ ...prev, [mod]: cfg }));
      }).catch(console.error);
    });
    return () => { cancelled = true; };
  }, [modules]);

  return (
    <main className="mainLayout" style={{ overflow: "visible" }}>
      <div style={{backgroundColor:"var(--main-background-color)", width:"100%", height:"100%", borderRadius:"var(--border-radius)", display:"flex", flexDirection:"column", overflow:"hidden"}}>
        <div style={{position:"absolute",top:"0",left:"0",zIndex:"999", width:"100%", height:"20px"}} data-tauri-drag-region/>
        {/* MAINBAR */}
        <div className="mainbar" style={{display:"flex",height:"50px", zIndex:"5", flexShrink:"0"}}>
          <div style={{width:"250px",padding:"7px"}} />
          <div className="quick-panel" style={{}}>
            {/* GAMES */}
            {modules.map(mod => {
              const cfg = configs[mod];
              const badge = cfg?.icon ?? cfg?.banner;
              return (
                <div
                  className="hyperlink"
                  key={mod}
                  onClick={() => navigate(`/gm/${mod}`)}
                  style={{
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    borderRadius: "8px",
                    overflow: "hidden",
                    backgroundColor: mod === devModule ? "rgba(0, 255, 0, 0.2)" : "rgba(255,255,255,0.1)",
                    fontSize: "12px",
                    fontWeight: "bold",
                    color: "white",
                    position: "relative",
                    border: mod === devModule ? "1px solid #00ff00" : "none",
                    boxShadow: mod === devModule ? "0 0 10px rgba(0, 255, 0, 0.3)" : "none"
                  }}
                  title={(cfg?.name ?? mod) + (mod === devModule ? " (Development Mode)" : "")}
                >
                  {badge ? (
                    <img src={badge} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                  ) : (
                    mod.substring(0, 2).toUpperCase()
                  )}
                  {mod === devModule && (
                    <div style={{
                      position: "absolute",
                      top: "-5px",
                      right: "-5px",
                      backgroundColor: "#00ff00",
                      color: "black",
                      fontSize: "8px",
                      padding: "1px 3px",
                      borderRadius: "4px",
                      fontWeight: "900"
                    }}>
                      DEV
                    </div>
                  )}
                </div>
              );
            })}
            <img
              className="hyperlink"
              src={GameLibraryIcon}
              onClick={() => navigate("/home")}
              style={{cursor: "pointer"}}
              title="Your library"
            />
            {status === "authenticated" && (
              <>
                <p style={{fontSize:"28px", margin:"0", padding:"0 7px 0 7px", opacity: 0.3}}>|</p>
                <img
                  className="hyperlink"
                  src={AccountIcon}
                  onClick={() => navigate("/profile")}
                  style={{cursor: "pointer"}} />
              </>
            )}
          </div>
          <WinBar/>
        </div>
        {/* CONTENT BODY */}
        <div style={{overflowY:"auto", flex:"1", minHeight:"0"}}>
          {children ?? <Outlet />}
        </div>
      </div>
      {/* PROGRESS LINE — bottom install progress: name, game, overall + current-stage progress.
          Any other installs running concurrently show as mini spinners in the corner. */}
      <div className={`progress${activeInstall ? " visible" : ""}`}>
        {activeInstall && (
          <div className="progress-content">
            <div className="progress-header" style={otherInstalls.length > 0 ? {paddingRight: `${otherInstalls.length * 20 + 12}px`} : undefined}>
              <span className="progress-name">{activeInstall.progress.name}</span>
              {(() => {
                const cfg = configs[activeInstall.module];
                const badge = cfg?.icon ?? cfg?.banner;
                return badge ? (
                  <img className="progress-game" src={badge} title={cfg?.name ?? activeInstall.module} alt="" />
                ) : (
                  <span className="progress-game progress-game-fallback" title={cfg?.name ?? activeInstall.module}>
                    {activeInstall.module.substring(0, 2).toUpperCase()}
                  </span>
                );
              })()}
              <span className="progress-stage">
                {activeInstall.progress.etap} ({activeInstall.progress.current_etaps}/{activeInstall.progress.total_etaps}) · {activeInstall.progress.status}
                {activeInstall.progress.filename ? ` — ${activeInstall.progress.filename}` : ""}
              </span>
            </div>
            <div className="line" style={{width: `${computeOverallPercent(activeInstall.progress)}%`}}/>
            <div className="details-line" style={{width: `${computeEtapPercent(activeInstall.progress)}%`}}/>
            <InstallIndicator installs={otherInstalls} />
          </div>
        )}
      </div>
    </main>
  )
}