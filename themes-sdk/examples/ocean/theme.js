/*
 * Example NiHao theme: "Ocean". Written by hand so it needs no build step; a theme made with the
 * SDK is the same thing — a script that defines `NihaoThemeEntry` with the theme as its default
 * export — just compiled from TypeScript. Copy this folder into `themes/` next to the launcher.
 *
 * Folder layout:  theme.json  theme.js  icon.svg (the preview in the theme list)  assets/wave.svg
 *
 * It shows what a theme can do beyond colours:
 *  - settings:  `settings` declares what the user can change; `theme(ctx)` receives the values
 *  - assets:    `ctx.assets.own("wave.svg")` is a file from this theme's assets/ folder (also the
 *               CSS variable `--asset-wave-svg`); `ctx.assets.launcher("libraryGames.png")` is a
 *               picture the launcher itself ships
 *  - structure: a Shell with its own top bar (the launcher badge, then the quick panel)
 */
var NihaoThemeEntry = (function () {
  "use strict";

  // The launcher's own React — a theme must not bring a second copy (hooks would break).
  var h = window.__NIHAO__.React.createElement;

  var settings = [
    { key: "waves", label: "Waves in the modal headers", type: "toggle", default: true },
    { key: "badge", label: "Launcher badge in the top bar", type: "toggle", default: true }
  ];

  function theme(ctx) {
    var s = ctx.settings;
    var badge = ctx.assets.launcher("libraryGames.png"); // a picture shipped by the launcher itself

    // Same pieces as the built-in shell, arranged differently. `regions` are ready-made, working
    // elements; place them anywhere.
    function OceanShell(props) {
      var regions = props.regions;
      return h(
        "main",
        { className: "mainLayout", style: { overflow: "visible" } },
        h(
          "div",
          { className: "splitHorizontal", style: { width: "100%", flex: "1", minHeight: "0", display: "flex", flexDirection: "row" } },
          h(
            "div",
            { style: { backgroundColor: "var(--main-background-color)", width: "100%", flex: "1", minHeight: "0", borderRadius: "var(--border-radius)", display: "flex", flexDirection: "column", overflow: "hidden" } },
            regions.dragRegion,
            h(
              "div",
              { className: "mainbar", style: { display: "flex", height: "50px", zIndex: "5", flexShrink: "0" } },
              h("div", { style: { width: "250px", padding: "7px" } }, s.badge && badge ? h("img", { src: badge, alt: "", style: { height: "34px" } }) : null),
              regions.quickPanels,
              regions.windowControls
            ),
            h("div", { style: { overflowY: "auto", flex: "1", minHeight: "0" } }, props.children)
          )
        ),
        regions.progress
      );
    }

    return {
      colors: {
        accent: "#14b8a6",
        accentLight: "#5eead4",
        background: "#0b1a1f",
        surface: "#10252b",
        modalBackground: "#0e2026",
        mainbar: "#12292f"
      },
      radii: { modal: "4px", panel: "2px", card: "6px", control: "2px" },
      // The theme's own file as a CSS variable: url("data:...") — ready for background-image.
      css: s.waves ? ".modal-header { background: var(--asset-wave-svg) center bottom / 100% 100% no-repeat; }" : "",
      slots: { Shell: OceanShell }
    };
  }

  return { default: { settings: settings, theme: theme } };
})();
