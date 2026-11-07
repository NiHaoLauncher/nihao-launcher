import { useEffect, useRef, useState } from "react";
import Loading from "./assets/loading.gif";
import { invoke } from "@tauri-apps/api";
import { listen } from "@tauri-apps/api/event";
import { useClient } from "./context/ClientContext";
import { useModal } from "./context/ModalContext";
import { useToast } from "./context/ToastContext";
import { useAuth } from "./context/AuthContext";
import BlankLayout from "./layout/BlankLayout";
import LoadingScreen from "./layout/LoadingScreen";
import { GameBanner, GameSettings } from "./games/Games";
import { getGameConfig, saveGameSettings, GameConfig } from "./games/GameRegistry";
import "./launcher.css";
import { LocalClient } from "./launcher/UserProfile";
import GetUserData from "./launcher/Authorization";
import { Navigate } from "react-router-dom";
import { T, t, Modal, modalCloseMs, animationsOff } from "@shared";
import { useLocalization } from "./state/Localization";
import { useLoginModal } from "./hooks/useLoginModal";

/** A newer release (`UpdateInfo` in updater.rs); `description` is its text. */
interface UpdateInfo {
  version: string;
  description: string;
}

export function InitPage() {
  const { setLocalClient, markLocalClientLoaded } = useClient();
  const { status, error, skipConnecting } = useAuth();
  const { confirm, closeModal } = useModal();
  const { showToast } = useToast();
  const openLoginModal = useLoginModal();
  const initLanguage = useLocalization((s) => s.load);
  const [title, setTitle] = useState("Initialization")
  const [showNewUser, setShowNewUser] = useState(false);
  const [redirect, setRedirect] = useState(false);
  // Set once a returning, previously-linked user's profile has loaded: keeps this screen up while
  // the reconnect retries, until it succeeds or the user skips.
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
    let info: UpdateInfo | null;
    try {
      info = await invoke("check_for_update", {});
    } catch (e) {
      console.warn(`Update check failed, skipping: ${e}`);
      return;
    }
    if (!info) return;

    const accepted = await askUpdateConfirmation(info);
    if (!accepted) return;

    setTitle(t("update.status_downloading", "Downloading update"));
    setUpdateProgress({ current: 0, total: 0 });
    const unlisten = await listen<{ status: string; current: number; total: number }>("update-progress", (event) => {
      setUpdateProgress({ current: event.payload.current, total: event.payload.total });
      if (event.payload.status === "extracting") {
        setTitle(t("update.status_installing", "Installing update"));
      }
    });
    try {
      await invoke("install_update", {});
    } catch (e) {
      // A download that stalled or a release that does not check out must not keep the launcher from
      // starting: say so and carry on with the version that is installed.
      console.warn(`Update failed: ${e}`);
      setUpdateProgress(null);
      setTitle(t("init.status_getting_info", "Getting you info"));
      showToast({ message: `${t("update.failed", "The update failed, the launcher starts as it is")}: ${e}`, variant: "error", duration: 10000 });
      return;
    } finally {
      unlisten();
    }

    setTitle(t("update.status_restarting", "Restarting"));
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
      // Load the profile (and its language) before the update flow so the update modal uses the
      // saved language.
      setTitle(t("init.status_getting_info", "Getting you info"));
      let profile: LocalClient | null = null;
      try {
        profile = await invoke<LocalClient>("init_local_data", {});
        setLocalClient(profile);
        initLanguage(profile.interface.language ?? "en_us");
      } catch (e) {
        console.info(`Error init localdata: ${e}`)
      }

      await checkForUpdate();
      await showPendingChangelogIfAny();

      if (profile) {
        if (profile.linked) {
          // Previously linked: wait for AuthContext's reconnect instead of racing ahead to /home.
          setTitle(t("init.status_connecting_server", "Connecting to server"));
          setAwaitingConnection(true);
        } else {
          setRedirect(true);
        }
      } else {
        setTitle(t("init.status_setup_info", "Setup you info"));
        setShowNewUser(true);
      }
      markLocalClientLoaded();
    };
    loading();
    // Mount-only on purpose: `setLocalClient` changes identity on every ClientProvider render, and
    // a rerun would show the update confirmation twice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!awaitingConnection) return;
    if (status === "authenticated") {
      closeModal();
      setRedirect(true);
      return;
    }
    if (status !== "anonymous" || rejectionHandledRef.current) return;

    if (!error) {
      setRedirect(true);
      return;
    }

    // The server rejected the stored session (not merely unreachable): ask whether to sign in
    // again or continue offline.
    rejectionHandledRef.current = true;
    confirm({
      message: error,
      confirmText: t("init.relogin_confirm", "Relogin"),
      cancelText: t("init.relogin_cancel", "Offline"),
      variant: "primary",
    }).then((relogin) => {
      if (!relogin) {
        setRedirect(true);
        return;
      }
      openLoginModal({
        dismissible: false,
        extra: (
          <button onClick={() => { skipConnecting(); closeModal(); setRedirect(true); }}>
            <T k="button.skipNetwork" />
          </button>
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

  const progress = updateProgress
    ? (updateProgress.total > 0 ? Math.min(100, (updateProgress.current / updateProgress.total) * 100) : 0)
    : null;

  return (
    <>
      <LoadingScreen
        title={title}
        image={Loading}
        progress={progress}
        onSkip={awaitingConnection ? () => { skipConnecting(); setRedirect(true); } : undefined}
        skipLabel={<T k="button.skipNetwork" />}
      />
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
    </>
  );
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
  // Close first so the shared Modal plays its exit; the parent unmounts the moment an answer is
  // reported.
  const [open, setOpen] = useState(true);
  const answer = (report?: () => void) => {
    setOpen(false);
    setTimeout(() => report?.(), animationsOff() ? 0 : modalCloseMs());
  };

  return (
    <Modal
      isOpen={open}
      onClose={() => answer(onDismiss)}
      title={`${mode === "confirm" ? t("update.title_available", "Update available") : t("update.title_whats_new", "What's new")} — ${info.version}`}
      size="medium"
      // an update decision must be made on purpose, not by a stray click or Escape
      closeOnBackdrop={false}
      closeOnEscape={false}
      showCloseButton={false}
      footer={
        <>
          {mode === "confirm" && (
            <button onClick={() => answer(onDismiss)} type="button">{t("update.later", "Later")}</button>
          )}
          <button
            className="btn-primary"
            onClick={() => answer(mode === "confirm" ? onConfirm : onDismiss)}
            type="button"
          >
            {mode === "confirm" ? t("update.now", "Update") : t("close_button", "Close")}
          </button>
        </>
      }
    >
      {info.description && <p style={{ marginTop: 0 }}>{info.description}</p>}
    </Modal>
  );
}

type OnboardingStep = "language" | "policy" | "get-to-know" | "setup-games" | "network-connect" | "final-setup" | "restarting";

function NewUser() {
  const { setLocalClient } = useClient();
  const language = useLocalization((s) => s.language);
  const { confirm } = useModal();
  const { status: authStatus } = useAuth();

  const [step, setStep] = useState<OnboardingStep>("language");
  const [selectedLanguage, setSelectedLanguage] = useState<string | null>(null);
  const [policyAccepted, setPolicyAccepted] = useState(false);
  const [nickname, setNickname] = useState("");
  const [selectedGames, setSelectedGames] = useState<string[]>([]);
  // Per-game path and settings edited in the "setup-games" step; only games the user opened appear.
  const [gameSetups, setGameSetups] = useState<Record<string, GameSetupState>>({});

  function finalSetupF() {
    // If NetworkStep logged in, the backend already holds the refresh token (`save_local_data`
    // writes it into local.data); `linked` just mirrors that.
    let data: LocalClient = {
      linked: authStatus === "authenticated",
      // Account-wide default nickname, bridged to every module as
      // `LauncherBridge.defaultNickname`.
      nickname: nickname.trim() || undefined,
      interface: {
        language: selectedLanguage ?? "en_us",
        hide_in_game_running: true,
        discord_presence_enabled: false,
        animations_enabled: true,
      },
      games: Object.fromEntries(
        selectedGames.filter((id) => gameSetups[id]).map((id) => [id, { path: gameSetups[id].path }]),
      ),
    };
    setLocalClient(data);
    invoke("save_local_data", { data })
      .then(() => Promise.all(selectedGames.filter((id) => gameSetups[id]).map(async (id) => {
        const { path, values } = gameSetups[id];
        const cfg = await getGameConfig(id);
        // Only the module's declared settings, same as `GameSettingsTab`.
        const own = Object.fromEntries(
          (cfg.settingsFields ?? []).filter((f) => values[f.key] !== undefined).map((f) => [f.key, values[f.key]]),
        );
        await saveGameSettings(path, own);
      })))
      .catch((e) => console.error(`Error saving LocalClient: ${e}`));

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
            <GameSetup
              selectedGames={selectedGames}
              setups={gameSetups}
              onSetupChange={(id, setup) => setGameSetups((prev) => ({ ...prev, [id]: setup }))}
            />
          )}
          {step === "network-connect" && (
            <NetworkStep setupFunction={finalSetupF} />
          )}
          {step === "final-setup" && (
            <FinalStep />
          )}
        </div>

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

function LanguageSelectionStep({
  selectedLanguage,
  onSelectLanguage
}: {
  selectedLanguage: string | null;
  onSelectLanguage: (lang: string) => void;
}) {
  const [languages, setLanguages] = useState<{ id: string, title: string }[]>([]);
  const initLanguage = useLocalization((s) => s.load);
  const glbLang = useLocalization((s) => s.language);

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
  const language = useLocalization((s) => s.language);

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

      <div style={{ width: "100%" }}>
        <label style={{ display: "block", marginBottom: "0.75rem", fontWeight: "bold" }}>
          {gamesLabel}
        </label>
        <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", justifyContent: "center" }}>
          <GameListSelection selectedGames={selectedGames} onToggle={toggleGame} />
        </div>
      </div>
    </div>
  );
}

/**
 * Same tile look as the Game Library (`home-game-tile-*` CSS) as a toggle-select grid: picked
 * tiles get a checkmark badge, no hover flyout.
 */
function GameListSelection({ selectedGames, onToggle }: { selectedGames: string[], onToggle: (id: string) => void }) {
  const [modules, setModules] = useState<string[]>([]);
  const [configs, setConfigs] = useState<Record<string, GameConfig>>({});

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

  return (
    <>
      {modules.map(mod => {
        const cfg = configs[mod];
        const selected = selectedGames.includes(mod);
        return (
          <div
            key={mod}
            className={`onboarding-game-tile${selected ? " selected" : ""}`}
            onClick={() => onToggle(mod)}
          >
            {cfg?.banner ? (
              <img src={cfg.banner} className="home-game-tile-img" alt="" />
            ) : (
              <div className="home-game-tile-placeholder">{mod.substring(0, 2).toUpperCase()}</div>
            )}
            <div className="onboarding-game-tile-name">{cfg?.name ?? mod.toUpperCase()}</div>
            {selected && <div className="onboarding-game-tile-check">✓</div>}
          </div>
        );
      })}
      {modules.length === 0 && <p style={{ fontSize: "0.8rem", opacity: 0.5 }}>No modules loaded. Check your plugins folder.</p>}
    </>
  );
}

interface GameSetupState {
  path: string;
  values: Record<string, any>;
}

function GameSetup({ selectedGames, setups, onSetupChange }: {
  selectedGames: string[];
  setups: Record<string, GameSetupState>;
  onSetupChange: (gameId: string, setup: GameSetupState) => void;
}) {
  const [activeGame, setActiveGame] = useState<string | null>(null);
  const [gameConfig, setGameConfig] = useState<{
    name: string;
    banner: string;
    defaultPath: string;
    settingsFields?: any[];
  } | null>(null);
  const setup = activeGame ? setups[activeGame] : undefined;
  const gamePath = setup?.path ?? gameConfig?.defaultPath ?? "";
  const gameValues = setup?.values ?? {};
  // Phase 1 needs every selected game's config (banner/name), not just the active one.
  const [phaseOneConfigs, setPhaseOneConfigs] = useState<Record<string, GameConfig>>({});

  useEffect(() => {
    if (activeGame) {
      getGameConfig(activeGame).then((config) => {
        setGameConfig(config);
        if (!setups[activeGame]) onSetupChange(activeGame, { path: config.defaultPath, values: {} });
      }).catch(console.error);
      // `setups` is read only to seed a first visit; re-running on its changes would loop.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }
  }, [activeGame]);

  useEffect(() => {
    let cancelled = false;
    selectedGames.forEach((gameId) => {
      getGameConfig(gameId).then((cfg) => {
        if (!cancelled) setPhaseOneConfigs((prev) => ({ ...prev, [gameId]: cfg }));
      }).catch(console.error);
    });
    return () => { cancelled = true; };
  }, [selectedGames]);

  if (!activeGame || !gameConfig) {
    return (
      <div style={{ textAlign: "center" }}>
        <h1 style={{ fontSize: "1.5rem", marginBottom: "1.5rem", color: "var(--main-color)" }}>
          <T k="startup.setup_games.title" />
        </h1>
        <div style={{ display: "flex", gap: "1rem", flexWrap: "wrap", justifyContent: "center" }}>
          {selectedGames.map((gameId) => {
            const cfg = phaseOneConfigs[gameId];
            return (
              <div key={gameId} className="home-game-tile" onClick={() => setActiveGame(gameId)}>
                {cfg?.banner ? (
                  <img src={cfg.banner} className="home-game-tile-img" alt="" />
                ) : (
                  <div className="home-game-tile-placeholder">{gameId.substring(0, 2).toUpperCase()}</div>
                )}
                <div className="onboarding-game-tile-name">{cfg?.name ?? gameId.toUpperCase()}</div>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div style={{
      display: "flex",
      gap: "2rem",
      width: "100%",
      maxWidth: "800px",
      alignItems: "flex-start",
    }}>
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
          onPathChange={(path) => onSetupChange(activeGame, { path, values: gameValues })}
          onValueChange={(key, value) => onSetupChange(activeGame, { path: gamePath, values: { ...gameValues, [key]: value } })}
        />
      </div>
    </div>
  );
}

function NetworkStep({ setupFunction }: { setupFunction: () => void }) {
  const { status, user, error, retry } = useAuth();
  const [skipped, setSkipped] = useState(false);

  // Retry so the user sees a fresh connecting attempt, not a stale earlier verdict.
  useEffect(() => {
    retry();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
          <h1>{user ? t("init.connecting_as", "Connected as {{name}}").replace("{{name}}", user.displayname) : t("init.connecting_ellipsis", "Connecting...")}</h1>
          <img src={Loading} style={{ imageRendering: "pixelated", width: "150px" }} />
        </>
      )}
      {status === "anonymous" && (
        <>
          <h1>{t("init.sign_in_title", "Sign in")}</h1>
          {error && <p style={{ color: "#ff6b6b", fontSize: "0.85rem", margin: 0 }}>{error}</p>}
          <GetUserData />
        </>
      )}
      {status === "unavailable" && (
        <p style={{ opacity: 0.7, textAlign: "center" }}>{t("init.server_unavailable", "Server unavailable — you can continue offline.")}</p>
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

const translationsLanguage = {
  title: "Welcome to NiHao",
  subtitle: "Please select your preferred language",
};