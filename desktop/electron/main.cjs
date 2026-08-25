/**
 * Electron main process.
 *
 * Owns three things: the local API server (started in-process), the browse
 * window, and a dedicated playback window that mpv renders into.
 *
 * CommonJS deliberately: Electron's ESM entrypoint support is inconsistent
 * across versions, and the renderer's module format is independent of this.
 */

const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { MpvPlayer, resolveMpvPath } = require('./mpv.cjs');
const { startServerProcess } = require('./server-process.cjs');

const HERE = __dirname;
const PROJECT_ROOT = path.resolve(HERE, '..', '..');
const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL || null;

/** How often playback position is written back to the library. */
const PROGRESS_INTERVAL_MS = 5000;

let mainWindow = null;
let playerWindow = null;
let player = null;
let serverChild = null;
let serverPort = 8787;
let mpvPath = null;
let embedPlayer = false;
let lastProgressWrite = 0;

/** Read committed defaults plus any local overrides, without importing ESM. */
function readConfig() {
  const merged = {};
  for (const name of ['config.json', 'config.local.json']) {
    try {
      Object.assign(merged, JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, name), 'utf8')));
    } catch {
      // Absent or unreadable config files fall back to defaults.
    }
  }
  return merged;
}

async function startApiServer() {
  const config = readConfig();
  serverPort = Number(process.env.PORT || config.port || 8787);
  mpvPath = resolveMpvPath(config.mpvPath);
  embedPlayer = Boolean(config.embedPlayer);

  const started = await startServerProcess({
    entry: path.join(PROJECT_ROOT, 'server', 'src', 'index.js'),
    port: serverPort,
    cwd: PROJECT_ROOT,
    onLog: (line) => { if (line) console.log('[server]', line); },
  });

  serverChild = started.child;
  console.log('Media server running on Node ' + started.node.major + ' (' + started.node.path + ')');
}

function stopApiServer() {
  if (serverChild && serverChild.exitCode === null) {
    serverChild.kill();
    serverChild = null;
  }
}

function apiUrl(pathname) {
  return 'http://127.0.0.1:' + serverPort + pathname;
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 940,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0b0b0f',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(HERE, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());

  // External links open in the real browser, never inside the app shell.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  const startView = process.env.MEDIA_START_VIEW || '';
  if (DEV_SERVER_URL) {
    mainWindow.loadURL(DEV_SERVER_URL + (startView ? '#' + startView : ''));
  } else {
    mainWindow.loadFile(path.join(HERE, '..', 'dist', 'index.html'), startView ? { hash: startView } : undefined);
  }

  mainWindow.webContents.on('did-finish-load', () => {
    console.log('renderer loaded: ' + mainWindow.webContents.getURL());
  });

  mainWindow.webContents.on('console-message', (event, level, message) => {
    if (level >= 2) console.error('[renderer] ' + message);
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

/**
 * The window mpv draws into. Frameless and borderless so the embedded video
 * surface fills it completely, with no browser chrome visible around it.
 */
function createPlayerWindow() {
  playerWindow = new BrowserWindow({
    show: false,
    frame: false,
    fullscreen: true,
    backgroundColor: '#000000',
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false },
  });

  // Nothing is loaded into it: mpv owns the surface via --wid.
  playerWindow.on('closed', () => { playerWindow = null; });
  return playerWindow;
}

function nativeHandleOf(win) {
  const buffer = win.getNativeWindowHandle();
  return buffer.length === 8
    ? buffer.readBigUInt64LE().toString()
    : String(buffer.readUInt32LE());
}

async function writeProgress(videoId, position, duration, options) {
  const force = options && options.force;
  if (!videoId) return;
  const nowMs = Date.now();
  if (!force && nowMs - lastProgressWrite < PROGRESS_INTERVAL_MS) return;
  lastProgressWrite = nowMs;

  try {
    await fetch(apiUrl('/api/progress'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ videoId, position, duration }),
    });
  } catch {
    // A failed progress write is not worth interrupting playback for.
  }
}

function closePlayerWindow() {
  if (playerWindow && !playerWindow.isDestroyed()) {
    playerWindow.hide();
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.focus();
    mainWindow.webContents.send('player:closed');
  }
}

function registerIpc() {
  ipcMain.handle('app:info', () => ({
    apiBase: apiUrl(''),
    mpvPath,
    mpvAvailable: Boolean(mpvPath),
    platform: process.platform,
  }));

  ipcMain.handle('player:play', async (event, options) => {
    if (!mpvPath) {
      const message = 'mpv was not found. Install it, or set mpvPath in config.json.';
      dialog.showErrorBox('Cannot play video', message);
      return { ok: false, error: message };
    }

    // Embedded mode is opt-in and known to swallow input; see mpv.cjs.
    let windowHandle = null;
    if (embedPlayer) {
      if (!playerWindow || playerWindow.isDestroyed()) createPlayerWindow();
      playerWindow.show();
      playerWindow.focus();
      windowHandle = nativeHandleOf(playerWindow);
    }

    if (!player) {
      player = new MpvPlayer({ mpvPath, windowHandle, embed: embedPlayer });

      player.on('position', ({ videoId, position, duration }) => {
        writeProgress(videoId, position, duration);
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('player:position', { videoId, position, duration });
        }
      });

      player.on('stopped', async ({ videoId, position }) => {
        const duration = player ? player.state.duration : null;
        await writeProgress(videoId, position, duration, { force: true });
        closePlayerWindow();
      });

      player.on('log', (line) => {
        if (/error|failed/i.test(line)) console.error('[mpv]', line);
      });
    }

    try {
      await player.start(options);
      return { ok: true };
    } catch (error) {
      closePlayerWindow();
      return { ok: false, error: error.message };
    }
  });

  ipcMain.handle('player:stop', async () => {
    if (player) await player.stop();
    closePlayerWindow();
    return { ok: true };
  });

  ipcMain.handle('player:command', async (event, args) => {
    if (!player || !player.isRunning) return { ok: false, error: 'nothing is playing' };
    try {
      return { ok: true, data: await player.command(args) };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

  ipcMain.handle('player:state', () => ({
    running: Boolean(player && player.isRunning),
    ...(player ? player.state : {}),
  }));
}

app.whenReady().then(async () => {
  try {
    await startApiServer();
  } catch (error) {
    dialog.showErrorBox('Failed to start the media server', String(error && error.stack || error));
    app.quit();
    return;
  }

  registerIpc();
  createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', async () => {
  if (player) await player.stop();
  stopApiServer();
});

// The child server must not outlive the app, including on an abrupt exit.
process.on('exit', stopApiServer);
process.on('SIGINT', () => { stopApiServer(); process.exit(0); });
process.on('SIGTERM', () => { stopApiServer(); process.exit(0); });
