import { useEffect } from "react";

/** Runs the active theme's `behaviors.modal` (if it has one) against a modal's window element for
 *  as long as the modal is mounted. The launcher itself attaches nothing — a custom scrollbar, a
 *  wheel feel and the like are the theme's. Read at mount time from `window`, so it works inside
 *  game modules' bundles too. */
export function useModalBehaviors(ref: { current: HTMLElement | null }, deps: unknown[]) {
  useEffect(() => {
    const root = ref.current;
    const attach = window.__NIHAO_BEHAVIORS__?.modal;
    if (!root || !attach) return;
    try {
      return attach(root);
    } catch (e) {
      console.error("Theme modal behavior failed:", e);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
