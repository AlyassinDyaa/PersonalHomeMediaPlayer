/**
 * Supervises the API server as a child process.
 *
 * The server runs under the system Node rather than inside Electron for two
 * reasons. It is the architecture the project already commits to — a separate
 * process so network clients can be added later without restructuring — and
 * Electron bundles Node 20, which predates the built-in `node:sqlite` module
 * the database layer uses.
 */

const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

/** Where to look for a system Node when it is not simply on PATH. */
const NODE_CANDIDATES = [
  'C:/Program Files/nodejs/node.exe',
  'C:/Program Files (x86)/nodejs/node.exe',
  process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'nodejs/node.exe') : null,
  process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs/nodejs/node.exe') : null,
  '/usr/bin/node',
  '/usr/local/bin/node',
  '/opt/homebrew/bin/node',
].filter(Boolean);

/** Minimum Node version that provides `node:sqlite` without a flag. */
const MINIMUM_NODE_MAJOR = 22;

function versionOf(nodePath) {
  try {
    const result = spawnSync(nodePath, ['--version'], { encoding: 'utf8', timeout: 5000 });
    if (result.status !== 0) return null;
    const match = String(result.stdout).trim().match(/^v(\d+)\./);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

/**
 * Find a usable Node binary.
 * @returns {{path: string, major: number} | null}
 */
function resolveNodePath(preferred) {
  const candidates = [preferred, process.env.MEDIAPLAYER_NODE, 'node', ...NODE_CANDIDATES].filter(Boolean);

  for (const candidate of candidates) {
    // "node" relies on PATH; the others must exist on disk.
    if (candidate !== 'node' && !fs.existsSync(candidate)) continue;
    const major = versionOf(candidate);
    if (major && major >= MINIMUM_NODE_MAJOR) return { path: candidate, major };
  }
  return null;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Start the server and resolve once it answers on /api/health.
 * @param {{entry: string, port: number, cwd: string, onLog?: (line: string) => void}} options
 */
async function startServerProcess({ entry, port, cwd, nodePath = null, env: extraEnv = {}, onLog = () => {} }) {
  const node = resolveNodePath(nodePath);
  if (!node) {
    throw new Error(
      'Node ' + MINIMUM_NODE_MAJOR + ' or newer is required to run the media server, '
      + 'but none was found. Install Node from nodejs.org, or set MEDIAPLAYER_NODE '
      + 'to the full path of a node executable.',
    );
  }

  const env = { ...process.env, ...extraEnv, PORT: String(port) };
  // Electron sets this for its own helper processes. It must not reach a real
  // Node child, where it changes how the runtime starts up.
  delete env.ELECTRON_RUN_AS_NODE;

  const child = spawn(node.path, [entry], {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout.on('data', (chunk) => onLog(String(chunk).trimEnd()));
  child.stderr.on('data', (chunk) => onLog(String(chunk).trimEnd()));

  let exited = null;
  child.on('exit', (code, signal) => { exited = { code, signal }; });

  // Poll until the server answers, so the window never loads against a dead API.
  const healthUrl = 'http://127.0.0.1:' + port + '/api/health';
  for (let attempt = 0; attempt < 100; attempt++) {
    if (exited) {
      throw new Error('The media server exited immediately (code ' + exited.code + '). Check the log for details.');
    }
    try {
      const response = await fetch(healthUrl);
      if (response.ok) return { child, node };
    } catch {
      // Not listening yet.
    }
    await sleep(100);
  }

  child.kill();
  throw new Error('The media server did not become ready in time.');
}

module.exports = { startServerProcess, resolveNodePath, MINIMUM_NODE_MAJOR };
