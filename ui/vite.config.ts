import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
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
