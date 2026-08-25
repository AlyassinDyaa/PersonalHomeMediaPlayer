/**
 * Development launcher: start Vite, then Electron pointed at it.
 * Keeps both in one terminal and shuts down cleanly together.
 */

import { createServer } from 'vite';
import { spawn } from 'node:child_process';
import electron from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const server = await createServer({ configFile: path.join(ROOT, 'vite.config.js') });
await server.listen();

const url = server.resolvedUrls?.local?.[0];
if (!url) {
  console.error('Vite did not report a local URL');
  process.exit(1);
}
console.log('Renderer running at ' + url);

const child = spawn(electron, [ROOT], {
  stdio: 'inherit',
  env: { ...process.env, VITE_DEV_SERVER_URL: url },
});

const shutdown = async () => {
  await server.close();
  process.exit(0);
};

child.on('close', shutdown);
process.on('SIGINT', () => { child.kill(); });
process.on('SIGTERM', () => { child.kill(); });
