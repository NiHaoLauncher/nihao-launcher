import type { ThemeBehaviors, ThemeSlots } from "./slots";

/**
 * The launcher's theme contract: colours, shapes, fonts plus the theme's own CSS, replacement
 * components (`slots`) and code attached to modals (`behaviors`). `applyTheme` turns the tokens
 * into CSS custom properties on `<html>`.
 */

/**
 * Colours. `fg`/`shade` are the base of every translucent overlay (derived with `color-mix`), so a
 * light theme only swaps these two.
 */
export interface ThemeColors {
  accent: string;
  accentLight: string;
  background: string;
  surface: string;
  modalBackground: string;
  mainbar: string;
  /** The loud divider (`--hr-color`). */
  lineStrong: string;
  /** The quiet hairline used for panel/modal outlines. */
  line: string;
  /** Fill of inputs and rows. */
  control: string;
  text: string;
  textMuted: string;
  textDisabled: string;
  ok: string;
  warn: string;
  danger: string;
  dangerStrong: string;
  fg: string;
  shade: string;
}

export interface ThemeRadii {
  /** The launcher's general corner radius (`--border-radius`). */
  base: string;
  modal: string;
  panel: string;
  card: string;
  control: string;
}

export interface ThemeFonts {
  /** Console-style text: titles bars, the menu, footer buttons, the stream of symbols. */
  mono: string;
}

/**
 * How long a closing modal stays mounted so the theme's exit animation can play (0 = goes at
 * once). Any other animation is the theme's own business.
 */
export interface ThemeMotion {
  modalCloseMs: number;
}

/**
 * One setting a theme offers (Settings > Appearance while the theme is active); the launcher
 * stores and returns the values.
 */
export type ThemeSettingField = { key: string; label: string; description?: string } & (
  | { type: "toggle"; default: boolean }
  | { type: "select"; default: string; options: { value: string; label: string }[] }
  | { type: "number"; default: number; min?: number; max?: number; step?: number }
  | { type: "color"; default: string }
  | { type: "text"; default: string; maxLength?: number }
);

export type ThemeSettingValue = string | number | boolean;
export type ThemeSettingValues = Record<string, ThemeSettingValue>;

/** Files a theme can use. Names are `/`-separated paths, e.g. `"logo.png"` or `"icons/refresh.svg"`;
 *  each resolves to a URL (a data URI or an asset URL) usable in `<img src>` or CSS `url()`. */
export interface ThemeAssets {
  /** A file from the theme's own `assets/` folder. */
  own: (name: string) => string | undefined;
  /** An image/icon the launcher itself ships (`"profile.png"`, `"libraryGames.png"`,
   *  `"shared/icons/refresh.svg"`, ...). */
  launcher: (name: string) => string | undefined;
  ownNames: () => string[];
  launcherNames: () => string[];
}

/** What a theme's `theme(ctx)` function receives. */
export interface ThemeContext {
  /** The user's values for this theme's settings, already checked against its declaration
   *  (a wrong type or an unknown choice falls back to the setting's default). */
  settings: ThemeSettingValues;
  assets: ThemeAssets;
}

export interface LauncherTheme {
  id: string;
  name: string;
  version: string;
  author?: string;
  colors: ThemeColors;
  radii: ThemeRadii;
  fonts: ThemeFonts;
  motion: ThemeMotion;
  /**
   * Styles everything itself: the built-in stylesheet is switched off (`<html data-nh-bare>`), so
   * `css` starts blank. Without it, `css` is laid over the built-in one.
   */
  bare?: boolean;
  /** Extra CSS appended after the launcher's own — for anything the tokens don't reach. */
  css?: string;
  /** The settings this theme declares (empty/absent = none). */
  settings?: ThemeSettingField[];
  /** The values in effect for them (defaults filled in). */
  settingValues?: ThemeSettingValues;
  /** The theme's own files (`assets/`), name -> URL — also exposed to CSS as `--asset-<name>`. */
  ownAssets?: Record<string, string>;
  /** Code a theme runs against the launcher's windows — see `ThemeBehaviors`. */
  behaviors?: ThemeBehaviors;
  /**
   * Components that replace parts of the launcher's structure (see `ThemeSlots`); anything left
   * out keeps the built-in Console structure.
   */
  slots?: Partial<ThemeSlots>;
}
