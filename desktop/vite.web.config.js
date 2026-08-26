import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

/**
 * The build served to phones and tablets.
 *
 * Separate from the desktop build because it is a different program: it talks
 * to the server over HTTP rather than to Electron, plays through the browser's
 * own video element, and is laid out for a touch screen. Only the API client
 * and a few presentational pieces are shared.
 */
export default defineConfig({
  root: path.resolve(process.cwd(), 'web'),
  // Served from the root of the site, so absolute paths are correct.
  base: '/',
  plugins: [react()],
  resolve: {
    alias: { '/src': path.resolve(process.cwd(), 'src') },
  },
  build: {
    outDir: path.resolve(process.cwd(), 'dist-web'),
    emptyOutDir: true,
    // Real Safari, including a few years of it, rather than only the Chromium
    // that Electron happens to ship.
    target: ['safari14', 'chrome90'],
  },
});
