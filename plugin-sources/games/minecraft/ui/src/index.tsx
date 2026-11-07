import React, { useState } from 'react';
import ReactDOM from 'react-dom/client';
import { PagesBrowser } from './minecraftPages';
import { HomeBanner } from './pages/homeBanner';
import { MemoryRouter } from 'react-router-dom';
import { BridgeStoreContext, LauncherBridgeContext, useBridge } from '@shared';
import type { BridgeStore, LauncherBridge } from '@shared';
// `?inline` returns the CSS as a string: this UI renders into the host's document (no shadow root)
// and the host never loads a plugin's CSS file (`get_ui_bundle` embeds only the JS), so the CSS is
// bundled into the JS and injected as a <style> tag.
import minecraftCss from './minecraft.css?inline';

export const LOADERS = [
  { value: "vanilla", label: "Vanilla" },
  { value: "fabric", label: "Fabric" },
  { value: "neoforge", label: "NeoForge" },
];

// (Re)inserted on every connect so dev mode's unique tag per reload always gets the freshest CSS,
// not a stale tag left in <head>.
const STYLE_TAG_ATTR = "data-plugin-style";
function injectStyles() {
  document.head.querySelector(`style[${STYLE_TAG_ATTR}="minecraft"]`)?.remove();
  const style = document.createElement("style");
  style.setAttribute(STYLE_TAG_ATTR, "minecraft");
  style.textContent = minecraftCss;
  document.head.appendChild(style);
}

/** Re-renders the whole UI when the host's dictionary changes (`t()` reads a global, not React
 *  state) — without remounting, so open modals and page state survive a language switch. */
function Root() {
  useBridge((b) => b.languageRevision);
  const view = useBridge((b) => b.view);
  const link = useBridge((b) => b.pendingDeepLink);
  // The home banner hands over the modpack it shows: start on its page, not on the list. The link is
  // not consumed here: in dev mode the host mounts a second element right after the first, which must
  // find it too.
  const [startAt] = useState(() => (link?.kind === "open-modpack" && link.data ? [{ pathname: "/play", state: link.data }] : undefined));
  if (view === "home") return <HomeBanner />;
  return (
    <MemoryRouter initialEntries={startAt}>
      <PagesBrowser />
    </MemoryRouter>
  );
}

class MinecraftUI extends HTMLElement {
  private root: ReactDOM.Root | null = null;
  private _bridgeStore: BridgeStore | null = null;
  private _launcherBridge: LauncherBridge | null = null;

  set launcherBridgeStore(val: BridgeStore | null) {
    if (val === this._bridgeStore) return;
    this._bridgeStore = val;
    this.render();
  }

  get launcherBridgeStore() {
    return this._bridgeStore;
  }

  /** Legacy static bridge (older hosts) — superseded by `launcherBridgeStore`. */
  set launcherBridge(val: LauncherBridge | null) {
    this._launcherBridge = val;
    this.render();
  }

  get launcherBridge() {
    return this._launcherBridge;
  }

  connectedCallback() {
    // A custom element defaults to `display: inline` (no box height), so `height: 100%` inside the
    // UI would resolve to `auto` and long pages would grow past the window. Set display/size
    // directly on the element (the dev tag changes per reload, see TAG_NAME). Must happen here,
    // not in the constructor: the Custom Elements spec forbids a constructor adding attributes
    // (`.style` writes one) and Chromium throws on `createElement`.
    this.style.display = "block";
    this.style.height = "100%";
    this.style.minHeight = "0";
    this.style.overflow = "hidden";
    injectStyles();
    this.render();
  }

  private render() {
    // Nothing to show until the host hands over its bridge; rendering earlier would mount the UI
    // without a module id and render it all again.
    if (!this.isConnected || (!this._bridgeStore && !this._launcherBridge)) return;

    if (!this.root) {
      this.root = ReactDOM.createRoot(this);
    }

    this.root.render(
      <React.StrictMode>
        <BridgeStoreContext.Provider value={this._bridgeStore}>
          <LauncherBridgeContext.Provider value={this._launcherBridge}><Root /></LauncherBridgeContext.Provider>
        </BridgeStoreContext.Provider>
      </React.StrictMode>
    );
  }

  disconnectedCallback() {
    if (this.root) {
      const r = this.root;
      this.root = null;
      r.unmount();
    }
  }
}

// Always 'minecraft-ui' in production; dev mode gets a fresh unique tag per load via the module
// URL's query string, since a custom element can't be re-registered under the same tag.
const TAG_NAME = new URL(import.meta.url).searchParams.get('tag') || 'minecraft-ui';

if (!customElements.get(TAG_NAME)) {
  customElements.define(TAG_NAME, MinecraftUI);
}
