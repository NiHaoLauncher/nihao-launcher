
// The scroll position moves in notches of STEP pixels, and each frame covers EASE of the remaining
// distance, so the motion still eases out.
const STEP = 6;
const EASE = 0.2;

/** True when the launcher's "Interface animations" switch is off (it lives on `<html>`). */
const animationsOff = () => document.documentElement.dataset.animations === "off";

const LINE_PX = 16;
const PAGE_PX = 400;

/**
 * Nearest element between `from` and `root` that can scroll vertically in the direction of `dy`
 * (not already at that end, else the parent scrolls).
 */
function scrollableFor(from: HTMLElement | null, root: HTMLElement, dy: number): HTMLElement | null {
  for (let el = from; el; el = el.parentElement) {
    const overflowY = getComputedStyle(el).overflowY;
    if ((overflowY === "auto" || overflowY === "scroll") && el.scrollHeight > el.clientHeight) {
      const max = el.scrollHeight - el.clientHeight;
      if (dy > 0 ? el.scrollTop < max - 0.5 : el.scrollTop > 0.5) return el;
    }
    if (el === root) break;
  }
  return null;
}

/**
 * Compromise between smooth and stepped wheel scrolling: eases toward its target but lands only on
 * a coarse grid (`STEP`). Handles wheel events for scrollable elements inside `root`; does nothing
 * when "Interface animations" is off. Returns a cleanup function.
 */
export function attachRatchetScroll(root: HTMLElement): () => void {
  const running = new WeakMap<HTMLElement, { target: number; raf: number }>();

  function onWheel(e: WheelEvent) {
    if (animationsOff() || e.ctrlKey || e.shiftKey || e.deltaY === 0) return;
    const dy = e.deltaMode === 1 ? e.deltaY * LINE_PX : e.deltaMode === 2 ? e.deltaY * PAGE_PX : e.deltaY;
    const el = scrollableFor(e.target as HTMLElement, root, dy);
    if (!el) return;
    e.preventDefault();

    const max = el.scrollHeight - el.clientHeight;
    const state = running.get(el) ?? { target: el.scrollTop, raf: 0 };
    if (!state.raf) state.target = el.scrollTop;
    state.target = Math.max(0, Math.min(max, state.target + dy));
    running.set(el, state);

    if (state.raf) return;
    const tick = () => {
      const current = el.scrollTop;
      const diff = state.target - current;
      if (Math.abs(diff) <= 1) {
        el.scrollTop = state.target;
        state.raf = 0;
        return;
      }
      let next = Math.round((current + diff * EASE) / STEP) * STEP;
      // Rounding must never stall the motion: always advance at least one notch (or arrive).
      if (next === current) next = current + Math.sign(diff) * Math.min(STEP, Math.abs(diff));
      el.scrollTop = next;
      state.raf = requestAnimationFrame(tick);
    };
    state.raf = requestAnimationFrame(tick);
  }

  // Not passive: the default wheel scroll has to be cancelled for ours to take over.
  root.addEventListener("wheel", onWheel, { passive: false });
  return () => root.removeEventListener("wheel", onWheel);
}
