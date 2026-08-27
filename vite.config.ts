import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

console.info("dirname", __dirname);

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],
  resolve: {
    alias: {
      "@shared": path.resolve(__dirname, "./src-shared"),
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    host: "localhost",
    port: 1420,
    strictPort: true,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri` and the Cargo build output — `target/`
      // holds game install data too (see plugin-sources/games/*), and Vite/chokidar
      // holding a directory-watch handle on Windows blocks renaming/deleting it (this is
      // what broke the Minecraft plugin's Java-runtime install with "Access is denied").
      ignored: ["**/src-tauri/**", "**/target/**"],
    },
  },
}));
