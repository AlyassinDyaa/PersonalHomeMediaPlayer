import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

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
  },
  server: {
    port: 5183,
    strictPort: true,
  },
});
