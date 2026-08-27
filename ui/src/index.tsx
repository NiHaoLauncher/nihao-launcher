import React from 'react';
import ReactDOM from 'react-dom/client';
import { PagesBrowser } from './minecraftPages';
import { MemoryRouter } from 'react-router-dom';
import { LauncherBridgeContext } from '@shared';
// `?inline` gets the CSS back as a plain string instead of Vite emitting a separate
// `dist_ui/index.css` — this UI renders straight into the host's document (no shadow root,
// see MinecraftUI below), and nothing on the host/Rust side ever loads a plugin's CSS file on
// its own (`get_ui_bundle` only embeds the JS). Bundling the CSS into the JS itself is what
// actually gets it in front of the browser at all, in every load path (prod bundle and the
// dev server alike) instead of only whichever one happened to also fetch the separate file.
import minecraftCss from './minecraft.css?inline';

export const LOADERS = [
  { value: "vanilla", label: "Vanilla" },
  //{ value: "forge", label: "Forge" },
  { value: "fabric", label: "Fabric" },
  //{ value: "quilt", label: "Quilt" },
  { value: "neoforge", label: "NeoForge" },
];

// (Re)inserts this plugin's <style> tag on every connect — cheap, and means dev-mode's
// unique-tag-per-reload flow always picks up the freshest CSS instead of leaving a stale
// tag from an earlier reload sitting in <head> forever.
const STYLE_TAG_ATTR = "data-plugin-style";
function injectStyles() {
  document.head.querySelector(`style[${STYLE_TAG_ATTR}="minecraft"]`)?.remove();
  const style = document.createElement("style");
  style.setAttribute(STYLE_TAG_ATTR, "minecraft");
  style.textContent = minecraftCss;
  document.head.appendChild(style);
}

class MinecraftUI extends HTMLElement {
  private root: ReactDOM.Root | null = null;
  private _launcherBridge: any = null;

  set launcherBridge(val: any) {
    console.log("SET LAUNCHER BRIDGE CALLED:", val);
    this._launcherBridge = val;
    this.render();
  }

  get launcherBridge() {
    return this._launcherBridge;
  }

  connectedCallback() {
    console.log("CONNECTED CALLBACK CALLED");
    injectStyles();
    this.render();
  }

  private render() {
    console.log("RENDER CALLED, BRIDGE IS:", this._launcherBridge);
    if (!this.isConnected) return;

    if (!this.root) {
      this.root = ReactDOM.createRoot(this);
    }

    this.root.render(
      <React.StrictMode>
        <LauncherBridgeContext.Provider value={this._launcherBridge}>
          <MemoryRouter>
            <PagesBrowser />
          </MemoryRouter>
        </LauncherBridgeContext.Provider>
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

// In production this is always 'minecraft-ui'. In dev mode the host generates a fresh,
// unique tag per load (passed via this module's own URL query string) — custom elements
// can never be re-registered under the same tag once defined, so without this, editing
// the UI source would require a full app restart to ever see the change again.
const TAG_NAME = new URL(import.meta.url).searchParams.get('tag') || 'minecraft-ui';

if (!customElements.get(TAG_NAME)) {
  customElements.define(TAG_NAME, MinecraftUI);
}
