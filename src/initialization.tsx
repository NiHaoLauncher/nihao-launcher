import { useEffect, useRef, useState } from "react";
import Loading from "./assets/loading.gif";
import { invoke } from "@tauri-apps/api";
import { listen } from "@tauri-apps/api/event";
import { useClient } from "./context/ClientContext";
import { useModal } from "./context/ModalContext";
import { useAuth } from "./context/AuthContext";
import BlankLayout from "./layout/BlankLayout";
import ConnectionLayout from "./layout/ConnectionLayout";
import { GameBanner, GameSettings } from "./games/Games";
import { getGameConfig, saveGameSettings } from "./games/GameRegistry";
import { LocalClient } from "./launcher/UserProfile";
import GetUserData from "./launcher/Authorization";
import { Navigate } from "react-router-dom";
import { T } from "@shared";
import { useInitLanguage } from "./context/LanguageContext";

interface UpdateInfo {
  server: string;
  args: string[];
  version: string;
  min_updater_version: string;
  url: string;
  source: string;
  description: string;
  path_notes: string[];
  image: string;
}
interface LauncherUpdateManifest {
  lates_update: UpdateInfo;
}

export function InitPage() {
  const { localClient, setLocalClient, markLocalClientLoaded } = useClient();
  const { status, error, skipConnecting } = useAuth();
  const { confirm, openModal, closeModal } = useModal();
  const initLanguage = useInitLanguage();
  const [title, setTitle] = useState("Initialization")
  const [showNewUser, setShowNewUser] = useState(false);
  const [redirect, setRedirect] = useState(false);
  // Set once a returning user's profile (with a previously-linked account) has loaded —
  // keeps this screen up, retrying quietly in the background, until the reconnect succeeds
  // or the user skips it, instead of racing ahead to /home with no visible feedback.
  const [awaitingConnection, setAwaitingConnection] = useState(false);
  const rejectionHandledRef = useRef(false);
  const [updateProgress, setUpdateProgress] = useState<{ current: number; total: number } | null>(null);
  const [updatePrompt, setUpdatePrompt] = useState<{ info: UpdateInfo; resolve: (accepted: boolean) => void } | null>(null);
  const [changelog, setChangelog] = useState<{ info: UpdateInfo; resolve: () => void } | null>(null);

  function askUpdateConfirmation(info: UpdateInfo): Promise<boolean> {
    return new Promise((resolve) => {
      setUpdatePrompt({
        info,
        resolve: (accepted) => {
          setUpdatePrompt(null);
          resolve(accepted);
        },
      });
    });
  }

  function showChangelog(info: UpdateInfo): Promise<void> {
    return new Promise((resolve) => {
      setChangelog({
        info,
        resolve: () => {
          setChangelog(null);
          resolve();
        },
      });
    });
  }

  async function checkForUpdate() {
    let manifest: LauncherUpdateManifest | null;
    try {
      manifest = await invoke("check_for_update", {});
    } catch (e) {
      console.warn(`Update check failed, skipping: ${e}`);
      return;
    }
    if (!manifest) return;

    const info = manifest.lates_update;
    const accepted = await askUpdateConfirmation(info);
    if (!accepted) return;

    setTitle("Downloading update");
    setUpdateProgress({ current: 0, total: 0 });
    const unlisten = await listen<{ status: string; current: number; total: number }>("update-progress", (event) => {
      setUpdateProgress({ current: event.payload.current, total: event.payload.total });
      if (event.payload.status === "extracting") {
        setTitle("Installing update");
      }
    });
    try {
      await invoke("install_update", { manifest });
    } finally {
      unlisten();
    }

    setTitle("Restarting");
    await invoke("relaunch_app", {});
    // The process exits here; keep the UI frozen until it actually does.
    await new Promise(() => {});
  }

  async function showPendingChangelogIfAny() {
    let info: UpdateInfo | null;
    try {
      info = await invoke("take_pending_update_info", {});
    } catch (e) {
      console.warn(`Failed to read pending changelog: ${e}`);
      return;
    }
    if (!info) return;
    await showChangelog(info);
  }

  useEffect(() => {
    const loading = async () => {
      await checkForUpdate();
      await showPendingChangelogIfAny();
      try {
        setTitle("Getting you info")
        const profile: LocalClient = await invoke("init_local_data", {});
        setLocalClient(profile);
        initLanguage(localClient?.interface.language ?? "en_us");
        if (profile.client) {
          // Previously linked an account — wait here for AuthContext's reconnect (it retries
          // on its own) instead of racing ahead to /home with no visible feedback.
          setTitle("Connecting to server");
          setAwaitingConnection(true);
        } else {
          setRedirect(true);
        }
      } catch (e) {
        if (e == "data_not_alive") {
          setTitle("Setup you info")
          setShowNewUser(true);
        }
        console.info(`Error init localdata: ${e}`)
      } finally {
        // Resolved either way (found a profile, or confirmed there isn't one yet) — AuthContext
        // was waiting on this before it could safely decide whether to probe the server.
        markLocalClientLoaded();
      }
    };
    loading();
    // Intentionally run once on mount only: `setLocalClient` is re-created on every
    // ClientProvider render (e.g. when initLanguage() below updates language state),
    // and re-running this effect would show the update confirmation twice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!awaitingConnection) return;
    if (status === "authenticated") {
      closeModal(); // no-op if the relogin modal below was never opened
      setRedirect(true);
      return;
    }
    if (status !== "anonymous" || rejectionHandledRef.current) return;

    if (!error) {
      // Stream just ended with no explicit reason from the server — nothing to show a
      // modal about, so just continue rather than blocking on it.
      setRedirect(true);
      return;
    }

    // The server actively rejected the stored session (not merely unreachable) — ask
    // whether to sign in again or keep going offline, instead of dropping it silently.
    rejectionHandledRef.current = true;
    confirm({
      message: error,
      confirmText: "Relogin",
      cancelText: "Offline",
      variant: "primary",
    }).then((relogin) => {
      if (!relogin) {
        setRedirect(true);
        return;
      }
      openModal({
        title: "Sign in",
        size: "small",
        showCloseButton: false,
        closeOnBackdrop: false,
        closeOnEscape: false,
        content: (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "1rem" }}>
            <GetUserData />
            <button onClick={() => { skipConnecting(); closeModal(); setRedirect(true); }}>
              <T k="button.skipNetwork" />
            </button>
          </div>
        ),
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [awaitingConnection, status, error]);

  if (showNewUser) {
    return <NewUser />;
  }
  if (redirect) {
    return <Navigate to="/home" />
  }

  return (
    <ConnectionLayout>
      <div style={{ display: "grid", placeItems: "center", justifyContent: "center", alignItems: "center" }}>
        <h1>{title}</h1>
        <img src={Loading} style={{ imageRendering: "pixelated", width: "150px" }} />
        {updateProgress && (
          <div style={{ width: "300px", height: "8px", background: "#ddd", borderRadius: "4px", overflow: "hidden", marginTop: "1rem" }}>
            <div style={{
              width: `${updateProgress.total > 0 ? Math.min(100, (updateProgress.current / updateProgress.total) * 100) : 0}%`,
              height: "100%",
              background: "var(--main-color)",
              transition: "width 0.2s",
            }} />
          </div>
        )}
        {awaitingConnection && (
          <button
            onClick={() => { skipConnecting(); setRedirect(true); }}
            style={{ marginTop: "1rem" }}
          ><T k="button.skipNetwork" /></button>
        )}
      </div>
      {updatePrompt && (
        <UpdateInfoModal
          info={updatePrompt.info}
          mode="confirm"
          onConfirm={() => updatePrompt.resolve(true)}
          onDismiss={() => updatePrompt.resolve(false)}
        />
      )}
      {changelog && (
        <UpdateInfoModal
          info={changelog.info}
          mode="info"
          onDismiss={() => changelog.resolve()}
        />
      )}
    </ConnectionLayout>
  );
}

/* ============================================================
   Update info / changelog modal
   ============================================================ */

function resolveUpdateImageUrl(image: string): string {
  if (!image) return "";
  if (/^https?:\/\//i.test(image)) return image;
  return `https://drive.usercontent.google.com/u/0/uc?id=${image}`;
}

function UpdateInfoModal({
  info,
  mode,
  onConfirm,
  onDismiss,
}: {
  info: UpdateInfo;
  mode: "confirm" | "info";
  onConfirm?: () => void;
  onDismiss: () => void;
}) {
  const [imageFailed, setImageFailed] = useState(false);
  const imageUrl = resolveUpdateImageUrl(info.image);

  return (
    <div className="modal-overlay">
      <div className="modal-container modal-size-medium">
        <div className="modal-header">
          <h3>{mode === "confirm" ? "Update available" : "What's new"} — {info.version}</h3>
        </div>
        <div className="modal-body">
          <div className="modal-content">
            {imageUrl && !imageFailed && (
              <img
                src={imageUrl}
                onError={() => setImageFailed(true)}
                style={{ width: "100%", borderRadius: "8px", marginBottom: "1rem", display: "block" }}
              />
            )}
            {info.description && <p style={{ marginTop: 0 }}>{info.description}</p>}
            {info.path_notes.length > 0 && (
              <ul style={{ paddingLeft: "1.2rem", margin: 0 }}>
                {info.path_notes.map((line, i) =>
                  line.startsWith("[") && line.endsWith("]") ? (
                    <li key={i} style={{ listStyle: "none", marginLeft: "-1.2rem", fontWeight: "bold", marginTop: i === 0 ? 0 : "0.75rem" }}>
                      {line}
                    </li>
                  ) : (
                    <li key={i}>{line.replace(/^-\s*/, "")}</li>
                  )
                )}
              </ul>
            )}
          </div>
        </div>
        <div className="modal-footer confirm-actions">
          {mode === "confirm" && (
            <button onClick={onDismiss} type="button">Later</button>
          )}
          <button className="btn-primary" onClick={mode === "confirm" ? onConfirm : onDismiss} type="button">
            {mode === "confirm" ? "Update" : "Close"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ============================================================
   NewUser - Multi-step onboarding flow
   ============================================================ */

type OnboardingStep = "language" | "policy" | "get-to-know" | "setup-games" | "network-connect" | "final-setup" | "restarting";

function NewUser() {
  const { setLocalClient, language } = useClient();
  const { confirm } = useModal();
  const { refreshToken } = useAuth();

  const [step, setStep] = useState<OnboardingStep>("language");
  const [selectedLanguage, setSelectedLanguage] = useState<string | null>(null);
  const [policyAccepted, setPolicyAccepted] = useState(false);
  const [nickname, setNickname] = useState("");
  const [selectedGames, setSelectedGames] = useState<string[]>([]);

  function finalSetupF() {
    // If NetworkStep logged the user in, `refreshToken` is already sitting in AuthContext —
    // it couldn't be persisted to disk earlier because this is the first time a local
    // profile (and thus local.data) is created at all.
    let data: LocalClient = {
      client: refreshToken,
      interface: {
        language: selectedLanguage ?? "en_us",
        hide_in_game_running: true,
      },
      games: {},
    };
    setLocalClient(data);
    invoke("save_local_data", { data })
      .catch((e) => console.error(`Error saving LocalClient: ${e}`));

    // The nickname asked for here goes straight into Minecraft's own "Nickname" setting, in
    // its game.nihao (not local.data — see GameSettingsTab.tsx / local.rs's save_game_settings),
    // the exact same field the Minecraft Settings tab itself reads and writes, so this is a
    // single source of truth rather than a separate onboarding-only copy that could drift.
    // Written unconditionally even if Minecraft isn't among the selected games — harmless,
    // and saves having to ask again if it's installed later.
    getGameConfig("minecraft")
      .then((cfg) => saveGameSettings(cfg.defaultPath, { nickname: nickname.trim() || "Player" }))
      .catch((e) => console.error(`Error saving Minecraft nickname: ${e}`));

    handleNext();
  }

  function handleNext() {
    if (step === "language") {
      setStep("policy");
    } else if (step === "policy") {
      setStep("get-to-know");
    } else if (step === "get-to-know") {
      confirm({
        message: language?.["startup.setup_games.questionLabel"],
        confirmText: language?.["button.yes"],
        cancelText: language?.["button.no"],
        variant: "primary",
      }).then((result: boolean) => {
        if (result) {
          setStep("setup-games");
        } else {
          setStep("network-connect");
        }
      });
    } else if (step === "setup-games") {
      console.log("Onboarding complete:", { selectedLanguage, policyAccepted, nickname, selectedGames });
      setStep("network-connect");
    } else {
      setStep("final-setup");
    }
  }

  function handleBack() {
    if (step === "policy") {
      setStep("language");
    } else if (step === "get-to-know") {
      setStep("policy");
    }
  }

  if (step === "restarting") {
    return (<Navigate to="/" />)
  }

  return (
    <BlankLayout>
      <div style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        padding: "2rem",
        boxSizing: "border-box",
      }}>
        {/* Step content */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
          {step === "language" && (
            <LanguageSelectionStep
              selectedLanguage={selectedLanguage}
              onSelectLanguage={setSelectedLanguage}
            />
          )}
          {step === "policy" && (
            <PolicyAcceptanceStep
              accepted={policyAccepted}
              onAccept={setPolicyAccepted}
            />
          )}
          {step === "get-to-know" && (
            <GetToKnowStep
              nickname={nickname}
              onNicknameChange={setNickname}
              selectedGames={selectedGames}
              onGamesChange={setSelectedGames}
            />
          )}
          {step === "setup-games" && (
            <GameSetup selectedGames={selectedGames} />
          )}
          {step === "network-connect" && (
            <NetworkStep setupFunction={finalSetupF} />
          )}
          {step === "final-setup" && (
            <FinalStep />
          )}
        </div>

        {/* Navigation buttons */}
        <div style={{ display: "flex", justifyContent: "space-between", marginTop: "2rem" }}>
          {step == "policy" || step == "get-to-know" ? (
            <button
              onClick={handleBack}
              style={styles.buttonSecondary}
            >
              <T k="button.back" />
            </button>
          ) : (
            <div />
          )}

          {step === "policy" && !policyAccepted ? (
            <button
              disabled
              style={{ ...styles.buttonPrimary, opacity: 0.5, cursor: "not-allowed" }}
            >
              <T k="button.next" />
            </button>
          ) : (step === "language" && !selectedLanguage) ? (
            <button
              disabled
              style={{ ...styles.buttonPrimary, opacity: 0.5, cursor: "not-allowed" }}
            />
          ) : (step === "get-to-know" && (!nickname.trim() || selectedGames.length === 0)) ? (
            <button
              disabled
              style={{ ...styles.buttonPrimary, opacity: 0.5, cursor: "not-allowed" }}
            >
              <T k="button.next" />
            </button>
          ) : (step !== "network-connect" && step !== "final-setup") ? (
            <button
              onClick={handleNext}
              style={styles.buttonPrimary}
            >
              <T k="button.next" />
            </button>
          ) : (step === "final-setup") ? (
            <button
              onClick={() => setStep("restarting")}
              style={styles.buttonFinal}
            >
              <T k="button.finish" />
            </button>
          ) : (<></>)}
        </div>

        {/* Step indicator dots */}
        <div style={{ display: "flex", justifyContent: "center", gap: "0.5rem", marginTop: "1.5rem" }}>
          {(["language", "policy", "get-to-know", 'network-connect', 'final-setup'] as OnboardingStep[]).map((s) => (
            <div
              key={s}
              style={{
                width: "10px",
                height: "10px",
                borderRadius: "50%",
                backgroundColor: step === s ? "var(--main-color)" : "#ccc",
                transition: "background-color 0.3s",
              }}
            />
          ))}
        </div>
      </div>
    </BlankLayout>
  );
}

/* ============================================================
   Step 1: Language Selection
   ============================================================ */

function LanguageSelectionStep({
  selectedLanguage,
  onSelectLanguage
}: {
  selectedLanguage: string | null;
  onSelectLanguage: (lang: string) => void;
}) {
  const [languages, setLanguages] = useState<{ id: string, title: string }[]>([]);
  const initLanguage = useInitLanguage();
  const { language: glbLang } = useClient();

  useEffect(() => {
    invoke("get_lang_list", {})
      .then((result: any) => {
        if (Array.isArray(result)) {
          const langs = result.map(([id, title]: [string, string]) => ({ id, title }));
          setLanguages(langs);
        }
      })
      .catch((err) => {
        console.error("Failed to load language list:", err);
        setLanguages([
          { id: "en_us", title: "English" }
        ]);
      });
  }, []);

  return (
    <div style={{ textAlign: "center" }}>
      <h1 style={{ fontSize: "2.5rem", marginBottom: "1rem", color: "var(--main-color)" }}>
        {glbLang == null ? translationsLanguage.title : <T k="startup.welcome.title" />}
      </h1>
      <p style={{ fontSize: "1.2rem", marginBottom: "2rem", color: "var(--text-secondary-color)" }}>
        {glbLang == null ? translationsLanguage.subtitle : <T k="startup.welcome.subtitle" />}
      </p>

      <div style={{ display: "flex", gap: "1rem", flexWrap: "wrap", justifyContent: "center" }}>
        {languages.map((lang) => (
          <button
            key={lang.id}
            onClick={() => { initLanguage(lang.id); onSelectLanguage(lang.id); }}
            style={{
              ...styles.languageButton,
              borderColor: selectedLanguage === lang.id ? "var(--main-color)" : "#ccc",
              backgroundColor: selectedLanguage === lang.id ? "var(--main-color)" : "transparent",
              color: selectedLanguage === lang.id ? "white" : "var(--main-color)",
            }}
          >
            {lang.title}
          </button>
        ))}
      </div>
    </div>
  );
}

/* ============================================================
   Step 2: Policy Acceptance
   ============================================================ */

function PolicyAcceptanceStep({
  accepted,
  onAccept
}: {
  accepted: boolean;
  onAccept: (value: boolean) => void;
}) {
  const [policyText, setPolicyText] = useState<string>("");

  useEffect(() => {
    fetch("/POLICY.md")
      .then((res) => res.text())
      .then((text) => setPolicyText(text))
      .catch((err) => {
        console.error("Failed to load policy:", err);
        setPolicyText("Privacy Policy & Terms of Service\n\nPlease review our policies.");
      });
  }, []);

  return (
    <div style={{
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      width: "100%",
      maxWidth: "600px",
    }}>
      <h1 style={{ fontSize: "2rem", marginBottom: "1rem", color: "var(--main-color)" }}>
        <T k="startup.policy.title" />
      </h1>

      <div style={{
        flex: 1,
        width: "100%",
        padding: "1.5rem",
        backgroundColor: "var(--surface-color, #f5f5f5)",
        borderRadius: "var(--border-radius, 8px)",
        marginBottom: "1.5rem",
        overflowY: "auto",
        maxHeight: "200px",
        border: "1px solid var(--border-color, #ddd)",
        whiteSpace: "pre-wrap",
        lineHeight: "1.6",
        color: "var(--text-secondary-color)",
      }}>
        {policyText || "Loading policy..."}
      </div>

      <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", cursor: "pointer" }}>
        <input
          type="checkbox"
          checked={accepted}
          onChange={(e) => onAccept(e.target.checked)}
          style={{ width: "18px", height: "18px", cursor: "pointer" }}
        />
        <span><T k="startup.policy.acceptCheckbox" /></span>
      </label>
    </div>
  );
}

/* ============================================================
   Step 3: Get to Know You
   ============================================================ */

function GetToKnowStep({
  nickname,
  onNicknameChange,
  selectedGames,
  onGamesChange,
}: {
  nickname: string;
  onNicknameChange: (value: string) => void;
  selectedGames: string[];
  onGamesChange: (games: string[]) => void;
}) {
  const { language } = useClient();

  function toggleGame(game: string) {
    if (selectedGames.includes(game)) {
      onGamesChange(selectedGames.filter(g => g !== game));
    } else {
      onGamesChange([...selectedGames, game]);
    }
  }

  const nicknameLabel = language?.["startup.get_to_know.nicknameLabel"] ?? "Nickname";
  const nicknamePlaceholder = language?.["startup.get_to_know.nicknamePlaceholder"] ?? "Enter your nickname...";
  const gamesLabel = language?.["startup.get_to_know.gamesLabel"] ?? "Select your games";

  return (
    <div style={{
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      width: "100%",
      maxWidth: "500px",
    }}>
      <h1 style={{ fontSize: "2rem", marginBottom: "1.5rem", color: "var(--main-color)" }}>
        <T k="startup.get_to_know.title" />
      </h1>

      {/* Nickname input */}
      <div style={{ width: "100%", marginBottom: "2rem" }}>
        <label style={{ display: "block", marginBottom: "0.5rem", fontWeight: "bold" }}>
          {nicknameLabel}
        </label>
        <input
          type="text"
          value={nickname}
          onChange={(e) => onNicknameChange(e.target.value)}
          placeholder={nicknamePlaceholder}
          style={{
            width: "100%",
            padding: "0.75rem 1rem",
            fontSize: "1rem",
            borderRadius: "var(--border-radius, 8px)",
            border: "1px solid var(--border-color, #ddd)",
            boxSizing: "border-box",
            outline: "none",
          }}
        />
      </div>

      {/* Game selection */}
      <div style={{ width: "100%" }}>
        <label style={{ display: "block", marginBottom: "0.75rem", fontWeight: "bold" }}>
          {gamesLabel}
        </label>
        <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", justifyContent: "center" }}>
          {/* We'll list games that are currently loaded/available */}
          <GameListSelection selectedGames={selectedGames} onToggle={toggleGame} />
        </div>
      </div>
    </div>
  );
}

function GameListSelection({ selectedGames, onToggle }: { selectedGames: string[], onToggle: (id: string) => void }) {
  const [modules, setModules] = useState<string[]>([]);

  useEffect(() => {
    invoke("list_modules").then((res: any) => setModules(res)).catch(console.error);
  }, []);

  return (
    <>
      {modules.map(mod => (
        <div
          key={mod}
          onClick={() => onToggle(mod)}
          style={{
            padding: "10px 20px",
            backgroundColor: selectedGames.includes(mod) ? "var(--main-color)" : "var(--second-background-color)",
            borderRadius: "10px",
            cursor: "pointer",
            fontWeight: "bold",
            color: "white",
            border: "2px solid " + (selectedGames.includes(mod) ? "var(--main-color)" : "transparent")
          }}
        >
          {mod.toUpperCase()}
        </div>
      ))}
      {modules.length === 0 && <p style={{ fontSize: "0.8rem", opacity: 0.5 }}>No modules loaded. Check your plugins folder.</p>}
    </>
  );
}

function GameSetup({ selectedGames }: { selectedGames: string[] }) {
  const [activeGame, setActiveGame] = useState<string | null>(null);
  const [gameConfig, setGameConfig] = useState<{
    name: string;
    banner: string;
    defaultPath: string;
    settingsFields?: any[];
  } | null>(null);
  const [gamePath, setGamePath] = useState("");
  const [gameValues, setGameValues] = useState<Record<string, any>>({});

  useEffect(() => {
    if (activeGame) {
      getGameConfig(activeGame).then((config) => {
        setGameConfig(config);
        setGamePath(config.defaultPath);
        setGameValues({});
      }).catch(console.error);
    }
  }, [activeGame]);

  // Phase 1: show all banners
  if (!activeGame || !gameConfig) {
    return (
      <div style={{ textAlign: "center" }}>
        <h1 style={{ fontSize: "1.5rem", marginBottom: "1.5rem", color: "var(--main-color)" }}>
          <T k="startup.setup_games.title" />
        </h1>
        <div style={{ display: "flex", gap: "1rem", flexWrap: "wrap", justifyContent: "center" }}>
          {selectedGames.map((gameId) => {
            return (
              <div
                key={gameId}
                onClick={() => setActiveGame(gameId)}
                style={{
                  padding: "20px",
                  backgroundColor: "var(--second-background-color)",
                  borderRadius: "12px",
                  cursor: "pointer",
                  minWidth: "150px"
                }}
              >
                {gameId.toUpperCase()}
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  // Phase 2: settings for active game
  return (
    <div style={{
      display: "flex",
      gap: "2rem",
      width: "100%",
      maxWidth: "800px",
      alignItems: "flex-start",
    }}>
      {/* Left: banner (click to go back) */}
      <div style={{ cursor: "pointer" }} onClick={() => setActiveGame(null)}>
        <GameBanner
          src={gameConfig.banner}
          onClick={() => setActiveGame(null)}
        />
        <p style={{
          margin: "0.5rem 0 0 0",
          fontSize: "0.85rem",
          color: "var(--text-secondary-color)",
          fontStyle: "italic",
          textAlign: "center",
        }}>
          ← <T k="startup.setup_games.back" />
        </p>
      </div>

      {/* Right: settings panel */}
      <div style={{
        display: "flex",
        flexDirection: "column",
        gap: "1rem",
        flex: 1,
      }}>
        <GameSettings
          gameId={activeGame}
          gameName={gameConfig.name}
          defaultPath={gameConfig.defaultPath}
          settingsFields={gameConfig.settingsFields}
          currentPath={gamePath}
          currentValues={gameValues}
          onPathChange={setGamePath}
          onValueChange={(key, value) => setGameValues({ ...gameValues, [key]: value })}
        />
      </div>
    </div>
  );
}

function NetworkStep({ setupFunction }: { setupFunction: () => void }) {
  const { status, user, error, retry } = useAuth();
  const [skipped, setSkipped] = useState(false);

  // The status shown here might be a stale verdict from a check that ran silently way
  // earlier (before the user even reached this step) — retry so they see a real, fresh
  // connecting attempt on this screen, the same as at launcher startup.
  useEffect(() => {
    retry();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Once the server confirms the login, move on automatically.
  useEffect(() => {
    if (status === "authenticated" && !skipped) {
      setupFunction();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "1rem" }}>
      {status === "connecting" && (
        <>
          <h1>{user ? `Connected as ${user.displayname}` : "Connecting..."}</h1>
          <img src={Loading} style={{ imageRendering: "pixelated", width: "150px" }} />
        </>
      )}
      {status === "anonymous" && (
        <>
          <h1>Sign in</h1>
          {error && <p style={{ color: "#ff6b6b", fontSize: "0.85rem", margin: 0 }}>{error}</p>}
          <GetUserData />
        </>
      )}
      {status === "unavailable" && (
        <p style={{ opacity: 0.7, textAlign: "center" }}>Server unavailable — you can continue offline.</p>
      )}
      <button
        onClick={() => { setSkipped(true); setupFunction(); }}
        style={{ marginTop: "10%", display: skipped ? "none" : "block" }}
      ><T k="button.skipNetwork" /></button>
    </div>
  )
}

function FinalStep({ }: {}) {
  return (
    <>
      <h1 style={{ fontSize: "2.5rem", marginBottom: "1rem", color: "var(--main-color)" }}>
        <T k="startup.final_setup.title" />
      </h1>
      <p style={{ fontSize: "1.2rem", marginBottom: "2rem", color: "var(--text-secondary-color)" }}>
        <T k="startup.final_setup.subtitle" />
      </p>
    </>
  )
}

/* ============================================================
   Styles
   ============================================================ */

const styles: Record<string, React.CSSProperties> = {
  buttonPrimary: {
    padding: "0.75rem 2rem",
    fontSize: "1rem",
    borderRadius: "var(--border-radius, 8px)",
    border: "none",
    backgroundColor: "var(--main-color)",
    color: "white",
    cursor: "pointer",
    transition: "all 0.2s",
    fontWeight: "bold",
  },
  buttonFinal: {
    padding: "0.75rem 2rem",
    fontSize: "1rem",
    borderRadius: "var(--border-radius, 8px)",
    border: "none",
    backgroundColor: "var(--main-color)",
    color: "white",
    cursor: "pointer",
    transition: "all 0.2s",
    fontWeight: "bold",
    width: "70%",
    margin: "0 auto 0 auto",
  },
  buttonSecondary: {
    padding: "0.75rem 2rem",
    fontSize: "1rem",
    borderRadius: "var(--border-radius, 8px)",
    border: "1px solid var(--hr-color)",
    backgroundColor: "transparent",
    color: "inherit",
    cursor: "pointer",
    transition: "all 0.2s",
  },
  languageButton: {
    padding: "1rem 2rem",
    fontSize: "1.1rem",
    borderRadius: "var(--border-radius, 8px)",
    border: "2px solid",
    cursor: "pointer",
    transition: "all 0.2s",
    minWidth: "150px",
    fontWeight: "bold",
  },
};

/* ============================================================
   Translations
   ============================================================ */

const translationsLanguage = {
  title: "Welcome to NiHao",
  subtitle: "Please select your preferred language",
};