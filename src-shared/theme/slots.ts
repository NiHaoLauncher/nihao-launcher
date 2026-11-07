import type { ComponentType, ReactNode, Ref } from "react";

/**
 * Structures a theme may replace with its own components ("slots"). Each slot gets typed props
 * with everything it needs to draw; the logic stays in the launcher. A slot that throws is
 * replaced by the built-in one.
 */

/** The pieces the main window is made of; the shell only decides where they go. */
export interface ShellRegions {
  /** The launcher's quick panel: game tiles and the library — plus, while a game's page
   *  is open, that game's own group of buttons. */
  quickPanels: ReactNode;
  /**
   * Stands in for the account buttons while there is no signed-in session: a "connecting"
   * indicator or a "Sign in" button. Renders nothing when signed in or never signed in.
   */
  accountState?: ReactNode;
  /** The signed-in player's avatar with a status dot (click: their profile). Goes just before
   *  `socialToggle`. Optional, like it. */
  playerAvatar?: ReactNode;
  /**
   * Opens the friends list (its own OS window), with a badge of friends online. Far left of the
   * top bar; optional.
   */
  socialToggle?: ReactNode;
  /** Minimise / maximise / close. */
  windowControls: ReactNode;
  /** The install progress line (renders nothing when nothing is installing). */
  progress: ReactNode;
  /** An invisible strip across the top that drags the window. */
  dragRegion: ReactNode;
}

export interface ShellProps {
  regions: ShellRegions;
  /** The current page (a route's content). */
  children: ReactNode;
}

/** The frame of the launcher's one-off full-window pages (first-run setup, uninstall): the page
 *  fills it and the window controls sit in a corner. */
export interface BlankShellProps {
  /** Minimise / maximise / close. */
  windowControls: ReactNode;
  /** An invisible strip across the top that drags the window. */
  dragRegion: ReactNode;
  children: ReactNode;
}

export interface ModalChromeCategory {
  id: string | number;
  label: string;
  icon?: ReactNode;
}

/** Where a categories modal is in its list of pages. */
export interface ModalChromePage {
  /** Changes with the page: put it on the content's wrapper as `key` so a switch re-plays the
   *  content-in animation. */
  key: string;
  label?: string;
  /** 1-based. */
  index: number;
  total: number;
}

export interface ModalChromeProps {
  /**
   * Attach to the element that visually is the window: outside clicks close the modal, and wheel
   * scrolling/scrollbars are installed on it.
   */
  containerRef: Ref<HTMLDivElement>;
  /** True while the close animation plays. */
  closing: boolean;
  title: string;
  size: "small" | "medium" | "large" | "full";
  layout: "default" | "categories";
  /** A CSS length when the modal's height is fixed, otherwise undefined. */
  fixedHeight?: string;
  showCloseButton: boolean;
  /** No title bar: the content fills the window and the close button floats over it (top right).
   *  A theme's own frame may ignore this. */
  headerless?: boolean;
  onClose: () => void;
  footer?: ReactNode;
  /** Text for the footer's command line (e.g. what is about to change). */
  footerHint?: ReactNode;
  /** The pages of a categories modal (empty for a plain one). */
  categories: ModalChromeCategory[];
  /** The category that is selected (the page shown). */
  selectedCategory?: string | number;
  /** Switches to a category — immediately. A frame that wants the old page to play an exit first
   *  holds the click, plays it, and calls this when done. */
  onCategoryClick: (id: string | number) => void;
  /** Only for a categories modal. */
  page?: ModalChromePage;
  children: ReactNode;
}

/** How a link to a server is doing: `locked` connected, `searching` still trying, `standby` the
 *  server answers but nobody is signed in, `lost` no signal. */
export type LinkState = "locked" | "searching" | "standby" | "lost";

export interface OnlineServer {
  id: string;
  name: string;
  icon?: string;
  state: LinkState;
  /** Ready-made, translated: "Connected", "Not connected", ... */
  label: string;
}

/** Everything the Online Service page shows and does; the launcher does the work (connecting,
 *  polling, signing in), the slot only draws it. */
export interface OnlineServiceProps {
  /** The launcher's own connection. `account` is the signed-in line ("Signed in (name)"). */
  uplink: { state: LinkState; label: string; account: string };
  /** Game modules that have a server of their own. */
  servers: OnlineServer[];
  /** Sign-in is offered (server reachable, nobody signed in). */
  canSignIn: boolean;
  onSignIn: () => void;
  /** A reconnect is in progress (refresh is unavailable meanwhile). */
  refreshing: boolean;
  onRefresh: () => void;
  /** Signed in: "Manage profile" is offered. */
  canManageProfile: boolean;
  onManageProfile: () => void;
}

/** The screen shown while the launcher starts (reading the profile, checking for an update,
 *  connecting to the server). The launcher drives it; the slot only draws it. */
export interface LoadingScreenProps {
  /**
   * What the launcher is doing right now, translated ("Getting you info", "Connecting to server",
   * ...).
   */
  title: string;
  /** The launcher's own loading animation (an image URL) — use it or ignore it. */
  image: string;
  /** Update download progress, 0–100; `null` when nothing is being downloaded. */
  progress: number | null;
  /** Set while waiting for the server: lets the user continue offline. Absent otherwise. */
  onSkip?: () => void;
  /** The translated label for the skip button. */
  skipLabel: ReactNode;
}

/**
 * Code a theme runs against the launcher's windows. Unlike a slot (a component), this attaches
 * directly to the DOM — the place for things like a custom scrollbar or wheel feel.
 */
export interface ThemeBehaviors {
  /** Called with the window element of every modal once it is on screen (including modals inside
   *  game modules); returns the cleanup, called when it goes away. */
  modal?: (root: HTMLElement) => () => void;
}

export interface ThemeSlots {
  Shell: ComponentType<ShellProps>;
  BlankShell: ComponentType<BlankShellProps>;
  ModalChrome: ComponentType<ModalChromeProps>;
  OnlineService: ComponentType<OnlineServiceProps>;
  LoadingScreen: ComponentType<LoadingScreenProps>;
}
