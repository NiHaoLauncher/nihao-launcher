import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import svgr from "vite-plugin-svgr";
import path from "path";
import { fileURLToPath } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));
/** Which theme to build: `THEME=<folder under themes-sdk/themes>` (see build.mjs). */
const id = process.env.THEME;
if (!id) throw new Error("Set THEME=<theme folder name> (build.mjs does this for you).");
const root = path.resolve(here, "themes", id);

/**
 * Builds one theme into a single `theme.js`: an IIFE defining `NihaoThemeEntry` (the default
 * export). `react` and `react/jsx-runtime` are EXTERNAL, mapped to the launcher's own copies
 * (`window.__NIHAO__`): a second React would break hooks.
 */
export default defineConfig({
  root,
  plugins: [react(), svgr({ svgrOptions: { icon: true } })],
  resolve: {
    alias: { "@shared": path.resolve(here, "../src-shared") },
  },
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  build: {
    outDir: path.resolve(here, "dist", id),
    emptyOutDir: true,
    cssCodeSplit: false,
    lib: {
      entry: path.resolve(root, "src/index.tsx"),
      name: "NihaoThemeEntry",
      formats: ["iife"],
      fileName: () => "theme.js",
    },
    rollupOptions: {
      external: ["react", "react/jsx-runtime"],
      output: {
        globals: {
          react: "window.__NIHAO__.React",
          "react/jsx-runtime": "window.__NIHAO__.jsxRuntime",
        },
      },
    },
  },
});
