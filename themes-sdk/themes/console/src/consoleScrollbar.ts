
// One character cell of height: the handle's position and size are whole cells, so it jumps like
// text. Also the bar's width and the shortest handle (in cells).
const CELL = 8;
const BAR_WIDTH = 12;
const MIN_CELLS = 2;

/**
 * A console-style scrollbar for `el`, drawn as an overlay next to it (the native one is hidden in
 * CSS meanwhile): a dotted rail with a block handle that moves in whole cells, which a native
 * scrollbar can't do. Supports dragging and rail clicks. Returns a cleanup function. The overlay
 * lives in `el`'s parent (made positioned if needed).
 */
export function attachConsoleScrollbar(el: HTMLElement): () => void {
  const host = el.parentElement;
  if (!host) return () => {};

  const hostWasStatic = getComputedStyle(host).position === "static";
  if (hostWasStatic) host.style.position = "relative";

  const bar = document.createElement("div");
  bar.className = "console-scrollbar";
  bar.setAttribute("aria-hidden", "true");
  const thumb = document.createElement("div");
  thumb.className = "console-scrollbar-thumb";
  bar.appendChild(thumb);
  host.appendChild(bar);
  // Only now is the native scrollbar hidden (see Modal.css) — never hide it without a replacement
  // actually being in place.
  el.classList.add("has-console-scrollbar");

  let trackPx = 0;
  let thumbPx = 0;
  let range = 0;

  let raf = 0;
  const update = () => {
    raf = 0;
    const scrollH = el.scrollHeight;
    const clientH = el.clientHeight;
    range = scrollH - clientH;
    if (range <= 1) {
      bar.style.display = "none";
      return;
    }
    bar.style.display = "block";

    const trackCells = Math.max(MIN_CELLS, Math.floor(clientH / CELL));
    const thumbCells = Math.max(MIN_CELLS, Math.min(trackCells, Math.round((trackCells * clientH) / scrollH)));
    const topCells = Math.round((el.scrollTop / range) * (trackCells - thumbCells));

    trackPx = trackCells * CELL;
    thumbPx = thumbCells * CELL;
    bar.style.top = `${el.offsetTop + el.clientTop}px`;
    bar.style.left = `${el.offsetLeft + el.clientLeft + el.clientWidth - BAR_WIDTH}px`;
    bar.style.height = `${trackPx}px`;
    thumb.style.height = `${thumbPx}px`;
    thumb.style.transform = `translateY(${topCells * CELL}px)`;
  };
  const schedule = () => {
    if (!raf) raf = requestAnimationFrame(update);
  };

  el.addEventListener("scroll", schedule, { passive: true });
  const resize = new ResizeObserver(schedule);
  resize.observe(el);
  if (el.firstElementChild) resize.observe(el.firstElementChild);
  // Content changing size without `el` itself resizing (a list growing inside a fixed-height pane).
  const mutations = new MutationObserver(schedule);
  mutations.observe(el, { childList: true, subtree: true, characterData: true });

  const onThumbDown = (e: PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const startY = e.clientY;
    const startScroll = el.scrollTop;
    thumb.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const free = trackPx - thumbPx;
      if (free > 0) el.scrollTop = startScroll + ((ev.clientY - startY) * range) / free;
    };
    const up = (ev: PointerEvent) => {
      thumb.releasePointerCapture(ev.pointerId);
      thumb.removeEventListener("pointermove", move);
      thumb.removeEventListener("pointerup", up);
    };
    thumb.addEventListener("pointermove", move);
    thumb.addEventListener("pointerup", up);
  };
  thumb.addEventListener("pointerdown", onThumbDown);

  const onBarDown = (e: PointerEvent) => {
    if (e.target !== bar) return;
    e.stopPropagation();
    const y = e.clientY - bar.getBoundingClientRect().top;
    const thumbTop = thumb.getBoundingClientRect().top - bar.getBoundingClientRect().top;
    el.scrollTop += (y < thumbTop ? -1 : 1) * el.clientHeight * 0.9;
  };
  bar.addEventListener("pointerdown", onBarDown);

  schedule();

  return () => {
    if (raf) cancelAnimationFrame(raf);
    el.removeEventListener("scroll", schedule);
    resize.disconnect();
    mutations.disconnect();
    bar.remove();
    el.classList.remove("has-console-scrollbar");
    if (hostWasStatic) host.style.position = "";
  };
}

/** True for an element that really scrolls vertically by the user's hand right now. */
function isScrollable(el: HTMLElement): boolean {
  if (el.scrollHeight <= el.clientHeight + 1) return false;
  const overflowY = getComputedStyle(el).overflowY;
  return overflowY === "auto" || overflowY === "scroll";
}

/**
 * Gives every scrollable element inside `root` the console scrollbar, including ones that appear
 * later. Returns a cleanup function.
 */
export function attachConsoleScrollbars(root: HTMLElement): () => void {
  const attached = new Map<HTMLElement, () => void>();

  const scan = () => {
    for (const [el, detach] of attached) {
      if (!root.contains(el)) {
        detach();
        attached.delete(el);
      }
    }
    root.querySelectorAll<HTMLElement>("*").forEach((el) => {
      if (attached.has(el) || el.classList.contains("console-scrollbar")) return;
      if (isScrollable(el)) attached.set(el, attachConsoleScrollbar(el));
    });
  };

  // Content changes constantly in a live modal; look again only once it has settled for a moment.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const scheduleScan = () => {
    clearTimeout(timer);
    timer = setTimeout(scan, 120);
  };
  const mutations = new MutationObserver((records) => {
    // Our own overlay being added/removed must not trigger another scan.
    if (records.every((r) => [...r.addedNodes, ...r.removedNodes].every((n) => (n as HTMLElement).classList?.contains("console-scrollbar")))) return;
    scheduleScan();
  });
  mutations.observe(root, { childList: true, subtree: true });
  scan();

  return () => {
    clearTimeout(timer);
    mutations.disconnect();
    attached.forEach((detach) => detach());
    attached.clear();
  };
}
