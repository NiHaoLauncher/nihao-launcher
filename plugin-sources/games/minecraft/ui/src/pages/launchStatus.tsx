// The two modals around a game run: the startup stages, and the crash report with an AI prompt.
// Their look and motion (`pt-*` cards, `ls-*`, `cr-*`) is CSS only, so "Interface animations" off stops it.
import { useEffect, useRef, useState } from "react";
import { open as openExternalUrl } from "@tauri-apps/api/shell";
import { t } from "@shared/components/Translate";
import { Modal } from "@shared/index";
import { useCallModule } from "@shared/modules";
import { useBridge } from "@shared";
import CheckIcon from "@shared/assets/icons/check.svg?react";
import CopyIcon from "@shared/assets/icons/copy.svg?react";
import ExternalLinkIcon from "@shared/assets/icons/external-link.svg?react";
import FolderIcon from "@shared/assets/icons/folder.svg?react";
import GamepadIcon from "@shared/assets/icons/gamepad.svg?react";
import PowerIcon from "@shared/assets/icons/power.svg?react";
import TerminalIcon from "@shared/assets/icons/terminal.svg?react";
import WarningIcon from "@shared/assets/icons/warning.svg?react";
import { ModpackProfile } from "./types";
import { JOINING_SERVER } from "./helpers";

const stageLabels = () => [
  t("minecraft.launch.stage_prepare", "Preparing game files"),
  t("minecraft.launch.stage_start", "Starting Java"),
  t("minecraft.launch.stage_mods", "Loading mods"),
  t("minecraft.launch.stage_resources", "Loading resources"),
];
/** Index of the last stage: the game is up. */
export const READY_STAGE = 4;

/**
 * How far startup got (0 = preparing files, `READY_STAGE` = up), from the client log (best-effort
 * markers): the highest one seen wins. `Sound engine started` is the title screen; joining a world
 * or server also proves the game is up.
 */
export function detectLaunchStage(log: string[], running: boolean): number {
  if (!running) return 0;
  let stage = 1;
  for (const l of log) {
    if (/Sound engine started|Starting integrated minecraft server/.test(l) || JOINING_SERVER.test(l)) return READY_STAGE;
    if (/Reloading ResourceManager|Created: \d+x\d+x\d+/.test(l)) stage = Math.max(stage, 3);
    else if (/Loading \d+ mods|FMLLoader|Found \d+ mod/.test(l)) stage = Math.max(stage, 2);
  }
  return stage;
}

/** Log line severity for colouring: errors and stack traces stand out, warnings are muted yellow. */
const lineClass = (l: string) =>
  /\b(FATAL|ERROR)\b|Exception|Caused by:|^\s+at /.test(l) ? "ls-line-err" : /\bWARN\b/.test(l) ? "ls-line-warn" : "";

function LogView({ log, empty, follow }: { log: string[]; empty: string; follow?: boolean }) {
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (follow && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [log, follow]);
  return (
    <pre className="ls-log" ref={ref}>
      {log.length > 0 ? log.map((l, i) => <span key={i} className={lineClass(l)}>{l + "\n"}</span>) : empty}
    </pre>
  );
}

/** Seconds since mount, as `m:ss`. */
function useElapsed(): string {
  const [secs, setSecs] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setSecs((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, []);
  return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
}

/** Shown from Launch until the game is up; Close only closes this window, the game keeps starting. */
export function LaunchProgressModal({ stage, log, onKill, onClose }: { stage: number; log: string[]; onKill: () => void; onClose: () => void }) {
  const labels = stageLabels();
  const elapsed = useElapsed();
  return (
    <Modal
      isOpen
      onClose={onClose}
      title={t("minecraft.launch.starting_title", "Starting Minecraft")}
      size="large"
      footerHint={labels[Math.min(stage, labels.length - 1)] + "…"}
      footer={
        <>
          <button className="btn-danger with-icon" onClick={onKill}><PowerIcon />{t("minecraft.launch.starting_kill", "Kill")}</button>
          <button className="btn-primary" onClick={onClose}>{t("minecraft.launch.starting_close", "Close")}</button>
        </>
      }
    >
      <div className="pt-layout ls-layout">
        <div className="pt-main ls-stages">
          <div className="pt-hero pt-card">
            <span className="pt-badge ls-badge"><GamepadIcon /></span>
            <div className="pt-hero-text">
              <b>{labels[Math.min(stage, labels.length - 1)]}</b>
              <small>{t("minecraft.launch.starting_elapsed", "Elapsed")}: {elapsed}</small>
            </div>
          </div>
          <section className="pt-card">
            <div className="ls-bar"><i style={{ width: `${(stage / READY_STAGE) * 100}%` }} /></div>
            <ol className="ls-steps">
              {labels.map((label, i) => (
                <li key={label} className={i < stage ? "done" : i === stage ? "current" : ""}>
                  <span className="ls-mark">{i < stage ? <CheckIcon /> : i === stage ? <i className="ls-spinner" /> : null}</span>
                  {label}
                </li>
              ))}
            </ol>
          </section>
        </div>
        <section className="pt-card ls-console">
          <h4><TerminalIcon />{t("minecraft.launch.log_title", "Client log")}<small>{log.length}</small></h4>
          <LogView log={log} follow empty={t("minecraft.launch.console_empty", "Waiting for the game output…")} />
        </section>
      </div>
    </Modal>
  );
}

const AI_PLATFORMS: [string, string][] = [
  ["ChatGPT", "https://chatgpt.com/"],
  ["Claude", "https://claude.ai/new"],
  ["Gemini", "https://gemini.google.com/app"],
  ["DeepSeek", "https://chat.deepseek.com/"],
];

/** The log's tail is where a crash is, so the prompt carries only that. */
const PROMPT_LOG_LINES = 150;

/** Left: what happened and the error log. Right: a ready prompt to paste into an external AI (the launcher has none built in). */
export function CrashModal({ name, profile, log, exitCode, onClose }: {
  name: string;
  profile?: ModpackProfile;
  log: string[];
  exitCode: number | null;
  onClose: () => void;
}) {
  const call_module = useCallModule();
  const toast = useBridge((b) => b.toast);
  const [copiedPrompt, setCopiedPrompt] = useState(false);

  async function copy(text: string, done: () => void) {
    try {
      await navigator.clipboard.writeText(text);
      done();
    } catch (e) {
      console.error(e);
      toast?.({ message: String(e), variant: "error" });
    }
  }

  // The last exception-looking line that is not a stack frame: usually the root cause.
  const cause = [...log].reverse().find((l) => /Caused by:|\w(Exception|Error)\b/.test(l) && !/^\s+at /.test(l));
  const what = exitCode !== null ? `${t("minecraft.launch.crash_exit", "Exit code")}: ${exitCode}` : t("minecraft.launch.crash_killed", "The game was terminated unexpectedly");

  const prompt = [
    "Minecraft crashed. Help me find the cause and how to fix it.",
    `Modpack: ${profile?.display_name ?? name}${profile?.source ? ` (${profile.source.service}, ${profile.source.version_number})` : ""}`,
    `Minecraft ${profile?.version_id ?? "?"}, loader ${profile?.core ?? "?"} ${profile?.loader_version ?? ""}`.trim(),
    exitCode !== null ? `Exit code: ${exitCode}` : "",
    "",
    `Last ${PROMPT_LOG_LINES} lines of the log:`,
    log.slice(-PROMPT_LOG_LINES).join("\n"),
  ].join("\n");

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={t("minecraft.launch.crash_title", "The game crashed")}
      size="full"
      height="92vh"
      footerHint={what}
      footer={
        <>
          <button className="with-icon" onClick={() => call_module("open_modpack_folder", { name }).catch(console.error)}>
            <FolderIcon />{t("minecraft.modpacks_list.menu_open_folder", "Open folder")}
          </button>
          <button className="with-icon" onClick={() => copy(log.join("\n"), () => toast?.({ message: t("minecraft.launch.crash_copied", "Copied."), variant: "success" }))}>
            <CopyIcon />{t("minecraft.launch.crash_copy_log", "Copy log")}
          </button>
          <button className="btn-primary" onClick={onClose}>{t("minecraft.launch.crash_close", "Close")}</button>
        </>
      }
    >
      <div className="pt-layout cr-layout">
        <div className="pt-main cr-main">
          <div className="pt-hero pt-card cr-hero">
            <span className="pt-badge cr-badge"><WarningIcon /></span>
            <div className="pt-hero-text">
              <b>{profile?.display_name ?? name}</b>
              <small>{what}</small>
              {cause && <code className="cr-cause" title={cause}>{cause.trim()}</code>}
            </div>
          </div>
          <section className="pt-card ls-console cr-log">
            <h4><TerminalIcon />{t("minecraft.launch.crash_log", "Error log")}<small>{log.length}</small></h4>
            <LogView log={log} empty={t("minecraft.launch.crash_no_log", "The game left no output.")} />
          </section>
        </div>
        <section className="pt-card cr-ai">
          <p className="cr-ai-lead">{t("minecraft.launch.crash_ai_lead", "Let AI help you understand the crash: copy the prompt, then paste it into an AI of your choice.")}</p>
          <h4><span className="cr-step">1</span>{t("minecraft.launch.crash_ai_step1", "Copy the prompt to ask AI")}</h4>
          <button type="button" className="missing-btn primary cr-copy" onClick={() => copy(prompt, () => setCopiedPrompt(true))}>
            {copiedPrompt ? <CheckIcon /> : <CopyIcon />}
            {copiedPrompt ? t("minecraft.launch.crash_ai_copied", "Copied!") : t("minecraft.launch.crash_ai_copy", "Copy the prompt to ask AI")}
          </button>
          <h4><span className="cr-step">2</span>{t("minecraft.launch.crash_ai_step2", "Open an AI platform and paste the prompt")}</h4>
          {AI_PLATFORMS.map(([label, url]) => (
            <button key={label} type="button" className="cr-link" onClick={() => openExternalUrl(url).catch(console.error)}>
              {label}<ExternalLinkIcon />
            </button>
          ))}
        </section>
      </div>
    </Modal>
  );
}
