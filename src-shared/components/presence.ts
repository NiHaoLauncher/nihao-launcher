import { useEffect, useState } from "react";
import { getMotion } from "../theme/motion";

/** How long a closing modal stays mounted so the theme's exit animation can play (ms) — the
 *  active theme's `motion.modalCloseMs`. */
export const modalCloseMs = (): number => getMotion().modalCloseMs;

/** True when the launcher's "Interface animations" switch is off (it lives on `<html>`; this
 *  library is shared with game modules, so it reads the attribute instead of a store). */
export const animationsOff = (): boolean =>
  typeof document !== "undefined" && document.documentElement.dataset.animations === "off";

/**
 * Keeps something mounted for `ms` after `open` turns false, so it can play an exit animation:
 * `present` says whether to render at all, `closing` whether it is in that exit phase.
 * With animations off the exit is skipped.
 */
export function usePresence(open: boolean, ms: number = modalCloseMs()) {
  const [present, setPresent] = useState(open);

  useEffect(() => {
    if (open) {
      setPresent(true);
      return;
    }
    const timer = setTimeout(() => setPresent(false), animationsOff() ? 0 : ms);
    return () => clearTimeout(timer);
  }, [open, ms]);

  return { present: open || present, closing: !open && present };
}
