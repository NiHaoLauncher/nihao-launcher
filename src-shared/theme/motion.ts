import type { ThemeMotion } from "./types";

/** What is used when no theme has been applied (e.g. a game module's bundle running before/without
 *  the host's theme), and the base a folder theme's motion is laid over. */
export const DEFAULT_MOTION: ThemeMotion = { modalCloseMs: 160 };

declare global {
  interface Window {
    /** Set by the host when a theme is applied. A global, like the i18n dictionary: the shared
     *  library is bundled into game modules too, which can't see the host's stores. */
    __NIHAO_MOTION__?: ThemeMotion;
  }
}

/** The active theme's motion numbers. Read at
 *  the moment of use (never cached), so a theme change takes effect without a reload. */
export function getMotion(): ThemeMotion {
  return (typeof window !== "undefined" && window.__NIHAO_MOTION__) || DEFAULT_MOTION;
}
