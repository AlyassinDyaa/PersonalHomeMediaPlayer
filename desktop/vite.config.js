import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  root: '.',
  base: './',
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // The renderer only ever runs inside Electron's Chromium, so there is no
    // reason to down-level for legacy browser targets.
    target: 'esnext',
    rollupOptions: {
      input: {
        // The browse UI, and the transparent playback overlay drawn over mpv.
        main: path.resolve(process.cwd(), 'index.html'),
        overlay: path.resolve(process.cwd(), 'overlay.html'),
      },
    },
  },
  server: {
    port: 5183,
    strictPort: true,
  },
});
