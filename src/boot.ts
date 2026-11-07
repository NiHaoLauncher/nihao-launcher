import { animationsOff } from "@shared";

/** How long the start icon (`#boot` in index.html) stays up, counted from the page load (ms). */
const BOOT_MS = 1100;

/** Fades the start icon out once the app has something to show in its place. */
export function hideBoot() {
  const el = document.getElementById("boot");
  if (!el) return;
  setTimeout(() => {
    el.classList.add("done");
    setTimeout(() => el.remove(), 500);
  }, animationsOff() ? 0 : Math.max(0, BOOT_MS - performance.now()));
}
