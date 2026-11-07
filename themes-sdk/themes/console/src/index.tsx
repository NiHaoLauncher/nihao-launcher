import type { LauncherTheme, ThemeContext, ThemeSettingField } from "@shared/theme/types";
import ConsoleModalChrome from "./ConsoleModalChrome";
import ConsoleBlank from "./ConsoleBlank";
import ConsoleShell from "./ConsoleShell";
import OnlineService from "./OnlineService";
import { attachRatchetScroll } from "./ratchetScroll";
import { attachConsoleScrollbars } from "./consoleScrollbar";
import varsCss from "./vars.css?inline";
import modalCss from "./modal.css?inline";
import settingsCss from "./settings.css?inline";
import LoadingScreen from "./LoadingScreen";

/**
 * "Console": dark panels, hairline outlines, a monospace console for navigation with an ordinary
 * UI inside it, and animation in coarse steps. Everything here is what it changes relative to the
 * built-in "Simple" theme: tokens (sharper corners, monospace font), motion (all Console's own;
 * the launcher only asks for `motion.modalCloseMs`), structure (`slots.Shell`, `BlankShell`,
 * `ModalChrome`, `OnlineService`, `LoadingScreen`) and style (`bare` plus its own `css`).
 */
/** What Console lets the user change (Settings > Appearance, while Console is active). */
const settings: ThemeSettingField[] = [
  {
    key: "accent",
    label: "Accent colour",
    type: "select",
    default: "blue",
    options: [
      { value: "blue", label: "Blue" },
      { value: "green", label: "Green" },
      { value: "amber", label: "Amber" },
      { value: "violet", label: "Violet" },
    ],
  },
  {
    key: "blinkingCursor",
    label: "Blinking cursor",
    description: "The cursor after the active category and at the end of the footer line.",
    type: "toggle",
    default: true,
  },
];

const ACCENTS: Record<string, [string, string]> = {
  blue: ["#4a90d9", "#69acf5"],
  green: ["#3fa86b", "#6fd39a"],
  amber: ["#d9992b", "#f0bb59"],
  violet: ["#8a63d2", "#ad8cee"],
};

/** The theme for the user's current setting values (`ctx.settings`); called again whenever they
 *  change, which is what makes the settings preview live. */
const build = (ctx: ThemeContext): Partial<LauncherTheme> => ({
  colors: {
    accent: ACCENTS[String(ctx.settings.accent)]?.[0] ?? ACCENTS.blue[0],
    accentLight: ACCENTS[String(ctx.settings.accent)]?.[1] ?? ACCENTS.blue[1],
    background: "#191919",
    surface: "rgb(32, 32, 32)",
    modalBackground: "#191919",
    mainbar: "#202020",
    lineStrong: "rgba(255, 255, 255, 0.5)",
    line: "rgba(255, 255, 255, 0.08)",
    control: "rgba(255, 255, 255, 0.05)",
    text: "white",
    textMuted: "#666",
    textDisabled: "#666",
    ok: "#3fb950",
    warn: "#e3b341",
    danger: "#ff6b6b",
    dangerStrong: "#dc3545",
    fg: "#ffffff",
    shade: "#000000",
  },
  radii: {
    base: "12px",
    modal: "12px",
    panel: "6px",
    card: "14px",
    control: "4px",
  },
  fonts: {
    mono: 'Consolas, "Courier New", monospace',
  },
  // A closing modal stays mounted this long so `modal-off` can play (matches --c-modal-close).
  motion: { modalCloseMs: 340 },
  bare: true,
  css:
    varsCss + "\n" + modalCss + "\n" + settingsCss +
    (ctx.settings.blinkingCursor === false
      ? "\n.category-btn.active::after, .modal-footer-prompt > i { animation: none; opacity: 1; }\n"
      : ""),
  slots: { Shell: ConsoleShell, BlankShell: ConsoleBlank, ModalChrome: ConsoleModalChrome, OnlineService, LoadingScreen },
  // Run against every modal window: the wheel lands in notches, and the scrollbar is drawn by us
  // (its handle moves cell by cell).
  behaviors: {
    modal(root) {
      const stopWheel = attachRatchetScroll(root);
      const stopBars = attachConsoleScrollbars(root);
      return () => {
        stopWheel();
        stopBars();
      };
    },
  },
});

export default { settings, theme: build };
