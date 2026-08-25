/**
 * Electron main process.
 *
 * Owns three things: the local API server (started in-process), the browse
 * window, and a dedicated playback window that mpv renders into.
 *
 * CommonJS deliberately: Electron's ESM entrypoint support is inconsistent
 * across versions, and the renderer's module format is independent of this.
 */

const { app, BrowserWindow, ipcMain, shell, dialog, screen } = require('electron');
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
let overlayWindow = null;
let player = null;
let overlayState = { title: '', subtitles: [], audioTracks: [] };
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

/**
 * Transparent, always-on-top window that draws the playback controls over mpv.
 *
 * mpv owns a separate top-level window, so the controls cannot be drawn inside
 * it. This window floats above it instead. It is click-through by default and
 * only accepts mouse input while the pointer is over the control bar, which is
 * what keeps the video underneath behaving normally.
 */
function createOverlayWindow() {
  const display = screen.getPrimaryDisplay();
  const { x, y, width, height } = display.bounds;

  overlayWindow = new BrowserWindow({
    x,
    y,
    width,
    height,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(HERE, 'preload-overlay.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // 'screen-saver' sits above the ordinary topmost band that mpv's --ontop
  // uses, so the controls stay visible over fullscreen video.
  overlayWindow.setAlwaysOnTop(true, 'screen-saver');
  overlayWindow.setIgnoreMouseEvents(true, { forward: true });

  if (DEV_SERVER_URL) {
    overlayWindow.loadURL(DEV_SERVER_URL + 'overlay.html');
  } else {
    overlayWindow.loadFile(path.join(HERE, '..', 'dist', 'overlay.html'));
  }

  overlayWindow.on('closed', () => { overlayWindow = null; });
  return overlayWindow;
}

function sendOverlayState(patch) {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  overlayState = { ...overlayState, ...patch };
  overlayWindow.webContents.send('overlay:state', patch);
}

function showOverlay() {
  if (!overlayWindow || overlayWindow.isDestroyed()) createOverlayWindow();
  // Shown without focus so mpv keeps keyboard control (space, arrows, f).
  overlayWindow.showInactive();
  overlayWindow.setAlwaysOnTop(true, 'screen-saver');
  overlayWindow.setIgnoreMouseEvents(true, { forward: true });
}

function hideOverlay() {
  if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.hide();
}

/** Map mpv's track list into the shape the overlay renders. */
function describeTracks(tracks) {
  const label = (track) => {
    const parts = [];
    if (track.lang) parts.push(String(track.lang).toUpperCase());
    if (track.title) parts.push(track.title);
    if (track.codec && !track.title) parts.push(track.codec);
    if (!parts.length) parts.push('Track ' + track.id);
    if (track.external) parts.push('(file)');
    return parts.join(' · ');
  };

  const list = Array.isArray(tracks) ? tracks : [];
  return {
    subtitles: list.filter((t) => t.type === 'sub').map((t) => ({ id: t.id, label: label(t) })),
    audioTracks: list.filter((t) => t.type === 'audio').map((t) => ({ id: t.id, label: label(t) })),
  };
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
      player = new MpvPlayer({ mpvPath, windowHandle, embed: embedPlayer, useOverlay: !embedPlayer });

      player.on('position', ({ videoId, position, duration }) => {
        writeProgress(videoId, position, duration);
        sendOverlayState({ position, duration });
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('player:position', { videoId, position, duration });
        }
      });

      player.on('property', ({ name, value }) => {
        if (name === 'pause') sendOverlayState({ paused: Boolean(value) });
        else if (name === 'volume' && typeof value === 'number') sendOverlayState({ volume: value });
        else if (name === 'sid') sendOverlayState({ subtitleId: typeof value === 'number' ? value : null });
        else if (name === 'aid') sendOverlayState({ audioId: typeof value === 'number' ? value : null });
        else if (name === 'duration' && typeof value === 'number') sendOverlayState({ duration: value });
      });

      player.on('stopped', async ({ videoId, position }) => {
        const duration = player ? player.state.duration : null;
        await writeProgress(videoId, position, duration, { force: true });
        hideOverlay();
        closePlayerWindow();
      });

      player.on('log', (line) => {
        if (/error|failed/i.test(line)) console.error('[mpv]', line);
      });
    }

    try {
      await player.start(options);

      if (!embedPlayer) {
        overlayState = {
          title: options.title || '',
          position: options.startPosition || 0,
          duration: null,
          paused: false,
          volume: 100,
          subtitles: [],
          audioTracks: [],
          subtitleId: null,
          audioId: null,
        };
        showOverlay();
        sendOverlayState(overlayState);

        // Track lists are only available once mpv has loaded the file.
        player.getTracks()
          .then((tracks) => sendOverlayState(describeTracks(tracks)))
          .catch(() => { /* the overlay simply omits track menus */ });
      }

      return { ok: true };
    } catch (error) {
      hideOverlay();
      closePlayerWindow();
      return { ok: false, error: error.message };
    }
  });

  ipcMain.on('overlay:ready', (event) => {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.webContents.send('overlay:state', overlayState);
    }
  });

  ipcMain.on('overlay:interactive', (event, interactive) => {
    if (!overlayWindow || overlayWindow.isDestroyed()) return;
    // `forward: true` keeps mousemove flowing to the overlay even while it is
    // click-through, which is how it knows when the pointer reaches the bar.
    overlayWindow.setIgnoreMouseEvents(!interactive, { forward: true });
  });

  ipcMain.handle('player:stop', async () => {
    if (player) await player.stop();
    hideOverlay();
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
