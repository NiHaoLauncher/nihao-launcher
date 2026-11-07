import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import svgr from 'vite-plugin-svgr';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [
    react(),
    // `import Icon from '...svg?react'` gives an inline <svg> component. The SVGs ship with a
    // fixed 800px size and black fill: size is left to CSS and the fill becomes `currentColor`, so
    // the host can colour them.
    svgr({
      svgrOptions: {
        icon: true,
        replaceAttrValues: { '#000': 'currentColor', '#000000': 'currentColor' },
      },
    }),
  ],
  resolve: {
    alias: {
      "@shared": path.resolve(__dirname, "../../../../src-shared"),
    },
  },
  server: {
    cors: true
  },
  build: {
    lib: {
      entry: 'src/index.tsx',
      name: 'MinecraftUI',
      fileName: 'index',
      formats: ['iife'],
    },
    outDir: '../dist_ui',
    emptyOutDir: true,
  },
  define: {
    'process.env': {},
  },
});
