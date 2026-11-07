import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import svgr from "vite-plugin-svgr";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

console.info("dirname", __dirname);

export default defineConfig(async () => ({
  plugins: [
    react(),
    // `import Icon from '...svg?react'` -> an inline <svg> component (not an <img>); sized and
    // coloured by CSS (`currentColor`).
    svgr({ svgrOptions: { icon: true } }),
  ],
  resolve: {
    alias: {
      "@shared": path.resolve(__dirname, "./src-shared"),
    },
  },

  // Tauri-specific Vite options. Keep `clearScreen` off so Rust errors stay visible.
  clearScreen: false,
  // Tauri expects a fixed port; fail if it is taken.
  server: {
    host: "localhost",
    port: 1420,
    strictPort: true,
    watch: {
      // Ignore `src-tauri` and `target/`: `target/` holds game install data too, and
      // Vite/chokidar's directory watch on Windows blocks renaming/deleting it (it broke the
      // Minecraft Java-runtime install with "Access is denied").
      ignored: ["**/src-tauri/**", "**/target/**"],
    },
  },
}));
