import { invoke } from "@tauri-apps/api/tauri";
import type { LauncherTheme, ThemeAssets, ThemeContext, ThemeSlots } from "@shared";
import "./host";
import { simpleTheme } from "./simple";
import { launcherAssetNames, launcherAssetUrl } from "./launcherAssets";
import { resolveSettings, sanitizeSchema } from "@shared/theme/settings";

export { resolveSettings, sanitizeSchema };

/** A theme found in the `themes/` folder (from the backend — `hash` is of the exact bundle bytes). */
export interface ThemeInfo {
  id: string;
  name: string;
  version: string;
  author: string | null;
  hash: string;
  /** Preview icon (a data URI), if the theme has one. */
  icon: string | null;
}

export interface ThemeBundle {
  info: ThemeInfo;
  code: string;
  /** The theme's own files: name -> data URI. */
  assets: Record<string, string>;
}

export const listThemes = () => invoke<ThemeInfo[]>("list_themes");
export const fetchThemeBundle = (id: string) => invoke<ThemeBundle>("get_theme_bundle", { id });

/** The global a bundle must define: `var NihaoThemeEntry = ...` (an IIFE build with that name). */
const ENTRY = "NihaoThemeEntry";

/**
 * Runs a theme bundle as a classic script inside a function (no leaking globals) and returns what
 * it exports; a throw or syntax error comes back as an Error. Executes arbitrary code: only for a
 * bundle whose hash the user approved.
 */
export function runThemeCode(code: string): unknown {
  const w = window as unknown as Record<string, unknown>;
  w.__NIHAO_THEME_OUT__ = undefined;
  w.__NIHAO_THEME_ERR__ = undefined;

  // A syntax error never reaches the try/catch (the script fails to parse), so listen for it too.
  let scriptError: string | undefined;
  const onError = (e: ErrorEvent) => { scriptError = e.message; e.preventDefault(); };
  window.addEventListener("error", onError);

  const script = document.createElement("script");
  script.text =
    `(function(){try{\n${code}\n;` +
    `window.__NIHAO_THEME_OUT__=typeof ${ENTRY}!=="undefined"?${ENTRY}:undefined;` +
    `}catch(e){window.__NIHAO_THEME_ERR__=e;}})();`;
  try {
    document.head.appendChild(script);
  } finally {
    script.remove();
    window.removeEventListener("error", onError);
  }

  const thrown = w.__NIHAO_THEME_ERR__;
  const out = w.__NIHAO_THEME_OUT__;
  delete w.__NIHAO_THEME_OUT__;
  delete w.__NIHAO_THEME_ERR__;

  if (thrown) throw thrown instanceof Error ? thrown : new Error(String(thrown));
  if (scriptError) throw new Error(scriptError);
  if (out === undefined) throw new Error(`the bundle did not define ${ENTRY}`);
  return out;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Lays `over` on `base` key by key, keeping only values of the base's type, so a typo can't poison
 * the theme with `NaN`.
 */
function mergeInto<T extends object>(base: T, over: unknown): T {
  if (!isPlainObject(over)) return base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, baseValue] of Object.entries(base)) {
    const value = over[key];
    if (value === undefined) continue;
    if (isPlainObject(baseValue)) out[key] = mergeInto(baseValue, value);
    else if (typeof value === typeof baseValue && (typeof value !== "number" || Number.isFinite(value))) out[key] = value;
  }
  return out as T;
}

const SLOT_NAMES: (keyof ThemeSlots)[] = ["Shell", "BlankShell", "ModalChrome", "OnlineService", "LoadingScreen"];

/** A React component: a function, or a memo/forwardRef object. Anything else is dropped. */
const isComponent = (v: unknown) =>
  typeof v === "function" || (isPlainObject(v) && "$$typeof" in v);

function makeAssets(own: Record<string, string>): ThemeAssets {
  return {
    own: (name) => own[name],
    launcher: launcherAssetUrl,
    ownNames: () => Object.keys(own).sort(),
    launcherNames: launcherAssetNames,
  };
}

/**
 * Turns a bundle's exports into a complete theme: a plain theme object, or one with `settings` and
 * `theme(ctx)`. Missing tokens fall back to the built-in "Simple" theme; only known slots that are
 * components are taken. Identity comes from the manifest, never from the code.
 */
export function buildTheme(
  exported: unknown,
  info: Pick<ThemeInfo, "id" | "name" | "version" | "author">,
  saved?: unknown,
  ownAssets: Record<string, string> = {},
): LauncherTheme {
  const mod = isPlainObject(exported) && "default" in exported ? exported.default : exported;
  const def = isPlainObject(mod) ? mod : {};

  const settings = sanitizeSchema(def.settings);
  const settingValues = resolveSettings(settings, saved);
  const ctx: ThemeContext = { settings: settingValues, assets: makeAssets(ownAssets) };
  // A throwing `theme(ctx)` counts as a failed load; the caller falls back.
  const produced = typeof def.theme === "function" ? (def.theme as (c: ThemeContext) => unknown)(ctx) : def;
  const partial = isPlainObject(produced) ? produced : {};

  const slots: Partial<ThemeSlots> = {};
  if (isPlainObject(partial.slots)) {
    for (const name of SLOT_NAMES) {
      const component = partial.slots[name];
      if (isComponent(component)) (slots as Record<string, unknown>)[name] = component;
    }
  }

  return {
    id: info.id,
    name: info.name,
    version: info.version,
    author: info.author ?? undefined,
    colors: mergeInto(simpleTheme.colors, partial.colors),
    radii: mergeInto(simpleTheme.radii, partial.radii),
    fonts: mergeInto(simpleTheme.fonts, partial.fonts),
    motion: mergeInto(simpleTheme.motion, partial.motion),
    bare: partial.bare === true ? true : undefined,
    behaviors: isPlainObject(partial.behaviors) && typeof partial.behaviors.modal === "function"
      ? { modal: partial.behaviors.modal as (root: HTMLElement) => () => void }
      : undefined,
    css: typeof partial.css === "string" ? partial.css : undefined,
    slots: Object.keys(slots).length > 0 ? slots : undefined,
    settings: settings.length > 0 ? settings : undefined,
    settingValues: settings.length > 0 ? settingValues : undefined,
    ownAssets: Object.keys(ownAssets).length > 0 ? ownAssets : undefined,
  };
}

/** Runs a fetched bundle and builds the theme with the given saved settings. See `runThemeCode`
 *  for the trust requirement. */
export function instantiateTheme(bundle: ThemeBundle, saved?: unknown): LauncherTheme {
  return buildTheme(runThemeCode(bundle.code), bundle.info, saved, bundle.assets);
}
