import * as React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import { launcherAssetNames, launcherAssetUrl } from "./launcherAssets";

/**
 * What a theme bundle builds its components with. `react` and `react/jsx-runtime` are externals
 * mapped to these (see `themes-sdk`), so theme components run on the launcher's own React; a
 * second copy would break hooks.
 */
declare global {
  interface Window {
    __NIHAO__?: {
      React: typeof React;
      jsxRuntime: typeof jsxRuntime;
      /** The launcher's own images by name (also passed to `theme(ctx)` as `ctx.assets.launcher`). */
      launcherAsset: (name: string) => string | undefined;
      launcherAssetNames: () => string[];
    };
  }
}

window.__NIHAO__ = { React, jsxRuntime, launcherAsset: launcherAssetUrl, launcherAssetNames };
