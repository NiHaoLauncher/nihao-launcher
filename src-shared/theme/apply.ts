import type { LauncherTheme } from "./types";

/** Every CSS custom property a theme sets. Names that already existed in the launcher's
 *  stylesheets (`--main-color`, ...) keep them; new ones are `--nh-*`. */
export function themeVars(theme: LauncherTheme): Record<string, string> {
  const c = theme.colors;
  const r = theme.radii;
  return {
    "--main-color": c.accent,
    "--main-second-color": c.accentLight,
    "--main-background-color": c.background,
    "--second-background-color": c.surface,
    "--modal-background-color": c.modalBackground,
    "--mainbar-background-color": c.mainbar,
    "--hr-color": c.lineStrong,
    "--border-subtle": c.line,
    "--control-background-color": c.control,
    "--text-color": c.text,
    "--text-secondary-color": c.textMuted,
    "--text-disabled-color": c.textDisabled,
    "--nh-ok": c.ok,
    "--nh-warn": c.warn,
    "--nh-danger": c.danger,
    "--nh-danger-strong": c.dangerStrong,
    "--nh-fg": c.fg,
    "--nh-shade": c.shade,
    "--border-radius": r.base,
    "--nh-radius-modal": r.modal,
    "--nh-radius-panel": r.panel,
    "--nh-radius-card": r.card,
    "--nh-radius-control": r.control,
    "--nh-font-mono": theme.fonts.mono,
  };
}

const THEME_CSS_ID = "nihao-theme-css";

/**
 * `logo.png` -> `logo-png`; `icons/a_b.svg` -> `icons-a_b-svg`: a safe CSS custom-property name.
 */
const cssName = (s: string) => s.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");

/** Variables a theme's *content* sets, on top of the tokens: `--ts-<key>` for each of its
 *  settings, `--asset-<name>` (`url("...")`) for each of its own files. */
function contentVars(theme: LauncherTheme): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(theme.settingValues ?? {})) {
    out[`--ts-${cssName(key)}`] = String(value);
  }
  for (const [name, url] of Object.entries(theme.ownAssets ?? {})) {
    out[`--asset-${cssName(name)}`] = `url("${url}")`;
  }
  return out;
}

/** The content variables currently set, so the next theme can remove what it doesn't redefine. */
let appliedContentVars: string[] = [];

/**
 * Makes `theme` active: tokens become CSS custom properties on `<html>`, slots/behaviors are
 * published for the shared components, extra CSS is injected. Idempotent.
 */
export function applyTheme(theme: LauncherTheme, root: HTMLElement = document.documentElement) {
  for (const [name, value] of Object.entries(themeVars(theme))) {
    root.style.setProperty(name, value);
  }
  const content = contentVars(theme);
  for (const name of appliedContentVars) if (!(name in content)) root.style.removeProperty(name);
  for (const [name, value] of Object.entries(content)) root.style.setProperty(name, value);
  appliedContentVars = Object.keys(content);
  window.__NIHAO_MOTION__ = theme.motion;
  window.__NIHAO_SLOTS__ = theme.slots;
  window.__NIHAO_BEHAVIORS__ = theme.behaviors;
  root.dataset.theme = theme.id;
  root.toggleAttribute("data-nh-bare", theme.bare === true);

  let style = document.getElementById(THEME_CSS_ID) as HTMLStyleElement | null;
  if (theme.css) {
    if (!style) {
      style = document.createElement("style");
      style.id = THEME_CSS_ID;
      document.head.appendChild(style);
    }
    style.textContent = theme.css;
  } else {
    style?.remove();
  }
}
