import { ReactNode } from "react";

export type SettingsFieldType = "text" | "number" | "select" | "toggle" | "slider";

export interface SettingsField {
  key: string;
  label: string;
  type: SettingsFieldType;
  defaultValue: string | number | boolean;
  options?: string[];
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  marks?: number[];
  /** Shown as a hover hint on the option. */
  hint?: string;
}

export interface ConfirmOptions {
  message: string;
  confirmText?: string;
  cancelText?: string;
  variant?: "primary" | "danger";
  /** Icons for a `danger` dialog (see `ConfirmModal`). */
  icon?: ReactNode | null;
  confirmIcon?: ReactNode | null;
}

export interface OpenModalOptions {
  title: string;
  content: ReactNode;
  size?: "small" | "medium" | "large" | "full";
  /** Fixed height (px, or a CSS length string) instead of following the content — see `Modal`. */
  height?: "auto" | number | string;
  layout?: "default" | "categories";
  categories?: { id: string | number; label: string; icon?: ReactNode }[];
  activeCategory?: string | number;
  onCategoryChange?: (categoryId: string | number) => void;
  showCloseButton?: boolean;
  closeOnBackdrop?: boolean;
  closeOnEscape?: boolean;
}

export type ToastVariant = "success" | "error" | "info";

export interface ToastOptions {
  message: string;
  variant?: ToastVariant;
  /** Milliseconds before auto-dismiss. Default 5000. */
  duration?: number;
}

/** One button a game module puts into the launcher's quick panel (the second group in the top
 *  bar, shown only while that game's page is open). */
export interface QuickPanelItem {
  /** Stable id within the module — keeps React's identity (and hover state) across updates. */
  id: string;
  /** Tooltip / accessible name. */
  label: string;
  /** Either a square image (URL or data URI) or a React node — e.g. an inline `<svg>` component
   *  (`import Icon from './icon.svg?react'`), which takes the button's text colour via
   *  `currentColor`. Without one the label's first letters are shown. */
  icon?: string | ReactNode;
  onClick: () => void;
  disabled?: boolean;
  /** Highlights the button, e.g. for the currently open section. */
  active?: boolean;
}

export interface LauncherBridge {
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  openModal: (options: OpenModalOptions) => void;
  closeModal: () => void;
  /** Shows a transient on-screen notification (top-right stack) — e.g. a background job's
   *  success/failure once its modal may already be closed. Rendered by the launcher itself
   *  (`ToastProvider`), not the module, so it survives the module's own UI unmounting. */
  toast: (options: ToastOptions) => void;
  /**
   * Replaces this module's quick-panel buttons (`[]` to clear), shown only while its page is open.
   * Call from an effect and read current state through a ref in each `onClick`.
   */
  setQuickPanel: (items: QuickPanelItem[]) => void;
  language: string;
  /**
   * Bumps when the launcher dictionary (`window.__NIHAO_I18N__`) is replaced; re-render on it to
   * show new text, since `t()`/`T` read that global.
   */
  languageRevision?: number;
  setLanguage: (lang: string) => void;
  moduleId?: string;
  /**
   * What the launcher mounted this module's UI for: `"page"` (default) is the whole game page;
   * `"home"` is the launcher's main page, which wants only a compact banner about the game (what
   * was played last, a way to continue) and nothing else: no routes, no quick-panel buttons.
   */
  view?: "page" | "home";
  /**
   * Opens this game's page, optionally with a deep link the module then reads from
   * `pendingDeepLink` (like `nihaolauncher://<game>/<kind>/<segments>`): how a home banner sends the
   * player on to what it shows.
   */
  openGame?: (link?: { kind: string; segments: string[]; data?: unknown }) => void;
  /** Tells the launcher the `pendingDeepLink` was handled. Without it the link stays until the game page closes. */
  consumeDeepLink?: () => void;
  /** The user-configured install path for this game (from the Settings screen), if set. */
  gamePath?: string;
  /**
   * This game's saved values from the general "Game settings" tab (e.g. `{ ram: 8192 }`), so a
   * module can fall back to the general setting.
   */
  gameSettings?: Record<string, any>;
  /**
   * Whether the launcher account is signed in. The session credential never reaches the module
   * frontend (the backend pushes it to the module's own backend), so the module only uses this
   * flag to decide which UI to offer.
   */
  signedIn?: boolean;
  /**
   * Nickname entered during first-run onboarding, if any: the default for the module's first local
   * profile. May be absent, so keep an own fallback placeholder.
   */
  defaultNickname?: string;
  /**
   * Reports this module playing (or stopped, on `null`) to Discord Rich Presence; takes precedence
   * over the host's generic "Browsing <game>" state.
   */
  reportPlayingActivity?: (activity: PlayingActivity | null) => void;
  /**
   * Hides (`true`) or brings back (`false`) the launcher window around a running game. Hiding only
   * happens if the user's "Hide launcher while game is running" setting is on; restoring always does.
   */
  setLauncherHidden?: (hidden: boolean) => void;
  /**
   * Set when a `nihaolauncher://` deep link targeted this module (the leading game-id segment is
   * already stripped). Consume once; don't re-act on a stale reference.
   */
  pendingDeepLink?: { kind: string; segments: string[]; data?: unknown } | null;
}

/**
 * Minimal external store holding the current `LauncherBridge` (zustand's vanilla API fits).
 * Actions keep a stable identity; only data fields produce a new snapshot.
 */
export interface BridgeStore {
  getState: () => LauncherBridge;
  subscribe: (listener: () => void) => () => void;
}

export interface PlayingActivity {
  /** The instance/save/modpack name — Discord's "details" line under the "state" line. */
  detail: string;
  /** The in-game nickname the session is actually running under, if the module has such a
   *  concept — shown as the small image badge's hover tooltip. */
  nickname?: string;
  /** An optional Discord activity button (max one used today) — e.g. "Play together" pointing
   *  at a `nihaolauncher://` deep link (see `deeplink.rs`) for a session worth inviting a friend
   *  into. Omit for a session with nothing to invite anyone to. */
  joinButton?: { label: string; url: string };
  /** What the player is doing right now, if the module can tell — Discord shows it instead of the
   *  plain "Playing <game>" line. Omit when unknown. */
  status?: "menu" | "singleplayer" | "multiplayer";
  /** A public https image for Discord's large image (e.g. a modpack icon), replacing the game's
   *  own art. `largeText` is its hover tooltip. */
  largeImage?: string;
  largeText?: string;
  /** A second activity button, e.g. a link to the modpack's page on its service. */
  linkButton?: { label: string; url: string };
}

export interface Lang {
  id: string;
  language: string;
  [key: string]: any;
}