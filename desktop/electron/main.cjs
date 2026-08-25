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
let startMuted = false;
/** Upcoming videos, so the player can advance without asking the UI. */
let queue = [];
let queueIndex = 0;
/** True while moving between queue entries, so the stop is not treated as an exit. */
let advancing = false;
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
  // Automated runs mute playback so testing does not disturb the machine.
  startMuted = Boolean(config.startMuted) || process.env.MEDIA_MUTE === '1';

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
function createOverlayWindow(targetDisplay) {
  const display = targetDisplay ?? screen.getPrimaryDisplay();
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

/**
 * The display playback should happen on: whichever screen the browse window is
 * currently on. Both mpv and the overlay are pinned to it, because if they land
 * on different monitors the controls appear detached from the video and never
 * receive the pointer.
 */
function playbackDisplay() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    return screen.getDisplayMatching(mainWindow.getBounds());
  }
  return screen.getPrimaryDisplay();
}

function showOverlay(targetDisplay) {
  const display = targetDisplay ?? playbackDisplay();
  if (!overlayWindow || overlayWindow.isDestroyed()) createOverlayWindow(display);

  // Re-apply the bounds every time: the window is long-lived, but the display
  // it belongs on can change between one playback and the next.
  const { x, y, width, height } = display.bounds;
  overlayWindow.setBounds({ x, y, width, height });

  // The overlay takes focus deliberately. An unfocused window on Windows
  // consumes the first click to activate itself, which made every control feel
  // dead until it had been clicked twice. Keyboard shortcuts are handled by the
  // overlay and forwarded to mpv, so nothing is lost by holding focus here.
  overlayWindow.show();
  overlayWindow.focus();
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

/**
 * Work out where an intro ends and an outro begins.
 *
 * Chapter markers are authoritative when a file has them, which is common for
 * Blu-ray rips and rare for web releases. Otherwise fall back to conventional
 * offsets, which are approximate by nature — the button exists to save a few
 * seconds of scrubbing, not to be frame accurate.
 *
 * @param {number|null} duration
 */
async function detectSkipPoints(duration) {
  const config = readConfig();
  const introLength = Number(config.introSkipSeconds ?? 85);
  const outroLength = Number(config.outroSkipSeconds ?? 90);

  let chapters = [];
  try {
    chapters = (await player.command(['get_property', 'chapter-list'])) || [];
  } catch {
    chapters = [];
  }

  let intro = null;
  let outro = null;

  for (let i = 0; i < chapters.length; i++) {
    const name = String(chapters[i].title ?? '');
    const next = chapters[i + 1];
    if (!intro && /\b(intro|opening|op|title\s*sequence|main\s*title)\b/i.test(name)) {
      intro = { from: chapters[i].time, to: next ? next.time : chapters[i].time + introLength };
    }
    if (!outro && /\b(outro|ending|ed|credits|end\s*credits)\b/i.test(name)) {
      outro = { from: chapters[i].time };
    }
  }

  // Only offer a heuristic intro skip on something long enough to have one.
  if (!intro && duration && duration > 8 * 60) {
    intro = { from: 0, to: introLength, approximate: true };
  }
  if (!outro && duration && duration > 8 * 60) {
    outro = { from: Math.max(0, duration - outroLength), approximate: true };
  }

  return { intro, outro };
}

/**
 * Fill in a queue entry's file path and subtitles.
 *
 * Queue entries arrive carrying only an id and a title so that queueing a long
 * series costs nothing; the details are fetched as each episode is reached.
 */
async function resolveEntry(entry) {
  if (entry.filePath) return entry;

  const response = await fetch(apiUrl('/api/videos/' + entry.videoId));
  if (!response.ok) throw new Error('Could not load episode ' + entry.videoId);
  const video = await response.json();

  return {
    ...entry,
    filePath: video.path,
    subtitleFiles: (video.subtitles ?? []).map((subtitle) => subtitle.path),
    // Resume mid-episode, but ignore a position that is only a few seconds in.
    startPosition: video.position > 30 ? video.position : 0,
  };
}

/**
 * Start the queue entry at `index`. Returns { ok } so the renderer can surface
 * a failure, and is also the path used for autoplay and the next/previous
 * buttons, so all four behave identically.
 */
async function startQueueEntry(index, startPosition) {
  if (!mpvPath) {
    const message = 'mpv was not found. Install it, or set mpvPath in config.json.';
    dialog.showErrorBox('Cannot play video', message);
    return { ok: false, error: message };
  }
  if (index < 0 || index >= queue.length) return { ok: false, error: 'no such episode' };

  queueIndex = index;
  const entry = await resolveEntry(queue[index]);
  queue[index] = entry;

  // Embedded mode is opt-in and known to swallow input; see mpv.cjs.
  let windowHandle = null;
  if (embedPlayer) {
    if (!playerWindow || playerWindow.isDestroyed()) createPlayerWindow();
    playerWindow.show();
    playerWindow.focus();
    windowHandle = nativeHandleOf(playerWindow);
  }

  ensurePlayer(windowHandle);

  const display = playbackDisplay();

  try {
    await player.start({
      filePath: entry.filePath,
      videoId: entry.videoId,
      startPosition: startPosition ?? entry.startPosition ?? 0,
      subtitleFiles: entry.subtitleFiles ?? [],
      title: entry.title ?? '',
      display: display.bounds,
      muted: startMuted,
    });

    if (!embedPlayer) {
      overlayState = {
        title: entry.title ?? '',
        position: startPosition ?? 0,
        duration: null,
        paused: false,
        volume: 100,
        muted: startMuted,
        subtitles: [],
        audioTracks: [],
        subtitleId: null,
        audioId: null,
        hasNext: queueIndex < queue.length - 1,
        hasPrev: queueIndex > 0,
        nextTitle: queue[queueIndex + 1]?.title ?? null,
        skip: { intro: null, outro: null },
      };
      showOverlay(display);
      sendOverlayState(overlayState);

      // Track lists and chapters only exist once mpv has loaded the file.
      player.getTracks()
        .then((tracks) => sendOverlayState(describeTracks(tracks)))
        .catch(() => { /* the overlay simply omits track menus */ });

      player.command(['get_property', 'duration'])
        .then((duration) => detectSkipPoints(duration))
        .then((skip) => sendOverlayState({ skip }))
        .catch(() => { /* skip buttons stay hidden */ });
    }

    return { ok: true };
  } catch (error) {
    hideOverlay();
    closePlayerWindow();
    return { ok: false, error: error.message };
  }
}

/** Create the player once and attach the listeners that outlive each file. */
function ensurePlayer(windowHandle) {
  if (player) return player;

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
    else if (name === 'mute') sendOverlayState({ muted: Boolean(value) });
    else if (name === 'sid') sendOverlayState({ subtitleId: typeof value === 'number' ? value : null });
    else if (name === 'aid') sendOverlayState({ audioId: typeof value === 'number' ? value : null });
    else if (name === 'duration' && typeof value === 'number') sendOverlayState({ duration: value });
  });

  // Reaching the end of a file is what triggers autoplay, as distinct from the
  // user quitting, which must not roll on to the next episode.
  player.on('ended', ({ reason }) => {
    if (reason !== 'eof') return;
    if (queueIndex < queue.length - 1) {
      advancing = true;
      startQueueEntry(queueIndex + 1, 0).finally(() => { advancing = false; });
    }
  });

  player.on('stopped', async ({ videoId, position }) => {
    const duration = player ? player.state.duration : null;
    await writeProgress(videoId, position, duration, { force: true });
    // A stop that is part of moving to the next episode must not tear the
    // playback UI down.
    if (advancing) return;
    hideOverlay();
    closePlayerWindow();
  });

  player.on('log', (line) => {
    if (/error|failed/i.test(line)) console.error('[mpv]', line);
  });

  return player;
}

function registerIpc() {
  ipcMain.handle('app:info', () => ({
    apiBase: apiUrl(''),
    mpvPath,
    mpvAvailable: Boolean(mpvPath),
    platform: process.platform,
  }));

  ipcMain.handle('player:play', async (event, options) => {
    // A show sends its remaining episodes so the player can advance on its own.
    queue = Array.isArray(options.queue) && options.queue.length
      ? options.queue
      : [{ ...options }];
    queueIndex = Math.max(0, queue.findIndex((entry) => entry.videoId === options.videoId));
    return startQueueEntry(queueIndex, options.startPosition ?? 0);
  });

  ipcMain.handle('player:next', async () => startQueueEntry(queueIndex + 1, 0));
  ipcMain.handle('player:previous', async () => startQueueEntry(queueIndex - 1, 0));

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
