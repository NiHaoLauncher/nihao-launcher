import { DEFAULT_MOTION } from "@shared/theme/motion";
import type { LauncherTheme, ThemeSettingField } from "@shared/theme/types";
import { resolveSettings } from "@shared/theme/settings";

/**
 * "Simple": the built-in theme and the base every folder theme is laid over (a theme only says
 * what it changes). Plain on purpose: dark panels, ordinary modal frame, browser scrollbar, no
 * animation. App.css carries the same values as fallbacks.
 */
const base: LauncherTheme = {
  id: "simple",
  name: "Simple",
  version: "1.0.0",
  author: "NiHao",
  colors: {
    accent: "#4a90d9",
    accentLight: "#69acf5",
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
    card: "10px",
    control: "6px",
  },
  fonts: {
    mono: 'Consolas, "Courier New", monospace',
  },
  motion: DEFAULT_MOTION,
};

/** What the user can change in the built-in theme (Settings > Appearance). */
export const simpleSettings: ThemeSettingField[] = [
  { key: "accent", label: "Main colour", type: "color", default: "#4a90d9" },
  {
    key: "quickPanel",
    label: "Quick panel position",
    description: "Where the row of game shortcuts sits.",
    type: "select",
    default: "top",
    options: [
      { value: "top", label: "Top" },
      { value: "bottom", label: "Bottom" },
      { value: "left", label: "Left" },
      { value: "right", label: "Right" },
    ],
  },
];

/** A lighter shade of `#rrggbb` (mixed with white) — the accent's "light" companion colour. */
function lighten(hex: string, amount = 0.28): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex) ?? /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(hex);
  if (!m) return hex;
  const full = m[1].length === 6 ? m[1] : m.slice(1, 4).map((c) => c + c).join("");
  const ch = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
  return "#" + ch.map((v) => Math.round(v + (255 - v) * amount).toString(16).padStart(2, "0")).join("");
}

/** The built-in theme for the given saved setting values (anything missing/invalid = default). */
export function buildSimpleTheme(saved?: unknown): LauncherTheme {
  const values = resolveSettings(simpleSettings, saved);
  const accent = String(values.accent);
  return {
    ...base,
    colors: { ...base.colors, accent, accentLight: lighten(accent) },
    settings: simpleSettings,
    settingValues: values,
  };
}

/** The built-in theme with its default settings — also the base every folder theme is laid over. */
export const simpleTheme: LauncherTheme = buildSimpleTheme();
