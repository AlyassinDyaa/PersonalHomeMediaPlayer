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
const { moveWindowTo, releaseWindowMover } = require('./window-move.cjs');
const {
  windowedBounds, fullscreenBounds, dragBounds, resizeBounds, clampToDisplay,
  pastThreshold,
} = require('./video-frame.cjs');
const { validateTarget, copyLibrary, saveDataDir } = require('./data-location.cjs');

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
let startMuted = false;
/** Upcoming videos, so the player can advance without asking the UI. */
let queue = [];
let queueIndex = 0;
/** True while moving between queue entries, so the stop is not treated as an exit. */
let advancing = false;
/** Monitor chosen via the player control, overriding the default. */
let displayOverride = null;
/** Interval handle for the cursor poll that wakes the controls. */
let cursorWatch = null;
/** Which of our windows currently holds focus, driving overlay visibility. */
let playerFocused = false;
let overlayFocused = false;
let mainFocused = false;
/** mpv's own view of whether its (embedded) window has focus. */
let mpvFocused = false;
let mpvFocusReported = false;
let overlayHideTimer = null;
let lastProgressWrite = 0;
/** Where mpv's window is, and whether it is covering a whole display. */
let videoBounds = null;
let videoFullscreen = true;
/** The video's shape, so a resized window never adds bars the file lacks. */
let videoAspect = null;
/** mpv's window handle, cached so a drag does not ask for it per frame. */
let videoHwnd = null;
/** An in-flight pointer gesture from the controls acting as a title bar. */
let gesture = null;
/** Newest rectangle waiting on the previous move, so a drag coalesces. */
let movePending = false;
let queuedBounds = null;

/**
 * Read committed defaults plus any local overrides, without importing ESM.
 *
 * Settings saved from the UI are written next to the writable data folder, not
 * into the project, so a packaged build has to be told to look there as well —
 * otherwise a chosen data folder or mpv path is stored and then ignored.
 */
function readConfig() {
  const merged = {};
  const sources = [
    path.join(PROJECT_ROOT, 'config.json'),
    path.join(PROJECT_ROOT, 'config.local.json'),
  ];
  try {
    const writable = resolveWritableDir();
    const saved = path.join(writable, 'config.local.json');
    if (!sources.includes(saved)) sources.push(saved);
  } catch {
    // Before the app is ready there is no writable folder to consult.
  }

  for (const source of sources) {
    try {
      // A byte-order mark is stripped first: these files can be edited by hand,
      // and one saved by a Windows editor would otherwise fail to parse and be
      // ignored without a word.
      Object.assign(merged, JSON.parse(fs.readFileSync(source, 'utf8').replace(/^\uFEFF/, '')));
    } catch {
      // Absent or unreadable config files fall back to defaults.
    }
  }
  return merged;
}

/**
 * Application files are packed into an asar archive in a packaged build. The
 * server is unpacked so it can be launched as a real file, and anything
 * writable has to live outside the archive entirely.
 */
function unpackedPath(target) {
  // Matches both a path inside the archive and the archive root itself. The
  // root form matters: it is used as a working directory, and pointing a child
  // process at the archive file rather than the unpacked folder fails with a
  // bare ENOENT that names the executable, not the directory.
  return target.replace(/([\\/])app\.asar($|[\\/])/, '$1app.asar.unpacked$2');
}

/** The folder holding the executable, which is where a portable build lives. */
function installDir() {
  if (app.isPackaged) return path.dirname(app.getPath('exe'));
  // Running an asar directly: the app folder is two levels up, past resources/.
  if (PROJECT_ROOT.includes('app.asar')) {
    return path.resolve(PROJECT_ROOT, '..', '..');
  }
  return PROJECT_ROOT;
}

/**
 * Portable builds keep everything beside the executable, so the whole app —
 * library database, artwork cache and settings — can live on a removable drive
 * and follow it between machines. Marked by a `portable.txt` file next to the
 * executable, which the packaging script writes.
 */
function isPortable() {
  if (process.env.MEDIA_PORTABLE === '0') return false;
  if (process.env.MEDIA_PORTABLE === '1') return true;
  try {
    return fs.existsSync(path.join(installDir(), 'portable.txt'));
  } catch {
    return false;
  }
}

/**
 * Where the database, artwork and settings go.
 *
 * A portable build writes beside itself; an installed one uses the per-user
 * data folder, because its own directory is usually not writable. If a portable
 * build turns out to sit somewhere read-only, fall back rather than fail.
 */
function resolveWritableDir() {
  // An explicit location always wins. Lets the library live somewhere chosen
  // deliberately, and lets a packaged build be exercised without installing it.
  if (process.env.MEDIA_DATA_ROOT) return process.env.MEDIA_DATA_ROOT;

  // The portable marker wins wherever it is found, so a build that declares
  // itself portable behaves that way however it was launched. This is the base
  // directory: the database and artwork go in `data` beneath it, and settings
  // sit alongside, which puts config.local.json next to the executable where it
  // can be found and edited.
  if (isPortable()) {
    const base = installDir();
    try {
      fs.accessSync(base, fs.constants.W_OK);
      return base;
    } catch {
      console.warn('Portable folder is not writable; using the user data folder instead.');
    }
  }

  // In development the project directory is the natural home. Running an asar
  // directly has no such folder — the app directory is an archive.
  if (!app.isPackaged && !PROJECT_ROOT.includes('app.asar')) return PROJECT_ROOT;

  return app.getPath('userData');
}

/** A binary shipped alongside a portable build, if present. */
function bundledBinary(...segments) {
  const candidate = path.join(installDir(), ...segments);
  try {
    return fs.existsSync(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

/** The data folder in use right now. */
function currentDataDir() {
  const config = readConfig();
  return config.dataDir || path.join(resolveWritableDir(), 'data');
}

/**
 * Point the library at a different folder, bringing what is already there.
 *
 * The scan and its artwork represent real time spent, so moving the folder
 * copies them rather than starting over. The server holds the database open,
 * so it is stopped for the duration and started again against the new path.
 *
 * @param {string} target folder chosen by the user
 */
async function relocateDataDir(target) {
  const source = currentDataDir();
  const checked = validateTarget(source, target);
  if (!checked.ok) return checked;
  if (checked.sameFolder) return { ok: true, dataDir: checked.destination };

  const { destination } = checked;

  // The server holds the database open, so nothing can be copied until it lets
  // go, and SQLite needs a moment after the process exits to release its files.
  stopApiServer();
  await new Promise((resolve) => setTimeout(resolve, 600));

  let outcome;
  try {
    outcome = copyLibrary(source, destination);
  } catch (error) {
    await startApiServer();
    return { ok: false, error: 'Could not copy the library: ' + error.message };
  }

  try {
    saveDataDir(resolveWritableDir(), destination);
  } catch (error) {
    await startApiServer();
    return { ok: false, error: 'Could not save the setting: ' + error.message };
  }

  await startApiServer();
  return { ok: true, dataDir: destination, adopted: outcome.adopted };
}

async function startApiServer() {
  const config = readConfig();
  serverPort = Number(process.env.PORT || config.port || 8787);
  // A portable build can carry its own mpv so nothing has to be installed.
  mpvPath = resolveMpvPath(config.mpvPath ?? null, bundledBinary('mpv', 'mpv.exe'));
  // Automated runs mute playback so testing does not disturb the machine.
  startMuted = Boolean(config.startMuted) || process.env.MEDIA_MUTE === '1';

  const writableDir = resolveWritableDir();
  // A folder the user picked wins over the default beside the app, so a large
  // library can live on whichever drive has room for it.
  const dataDir = config.dataDir || path.join(writableDir, 'data');
  console.log('Data folder: ' + dataDir + (isPortable() ? ' (portable)' : ''));

  const started = await startServerProcess({
    nodePath: bundledBinary('runtime', 'node.exe'),
    entry: unpackedPath(path.join(PROJECT_ROOT, 'server', 'src', 'index.js')),
    port: serverPort,
    cwd: unpackedPath(PROJECT_ROOT),
    env: {
      MEDIA_CONFIG_DIR: writableDir,
      MEDIA_DATA_DIR: dataDir,
    },
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

  mainWindow.on('focus', () => { mainFocused = true; syncOverlayVisibility(); });
  mainWindow.on('blur', () => { mainFocused = false; syncOverlayVisibility(); });
  mainWindow.on('closed', () => { mainWindow = null; });
}

/**
 * The window mpv draws into. Frameless and borderless so the embedded video
 * surface fills it completely, with no browser chrome visible around it.
 */
/**
 * The window mpv renders into.
 *
 * mpv is embedded rather than left to open its own window. Asking mpv to go
 * fullscreen means asking it to choose a monitor, and its display enumeration
 * does not have to agree with Electron's — on a multi-monitor desktop that put
 * the video on one screen and the controls on another. Naming the screen is no
 * help either, since displays can share a label. Embedding removes the choice:
 * the video is drawn inside a window whose position we set.
 *
 * The original objection to embedding — that mouse and keyboard never reach
 * mpv's child window, so its own controls were unusable — no longer applies,
 * because the overlay draws every control and forwards input over IPC.
 */
function createPlayerWindow(targetDisplay) {
  const display = targetDisplay ?? playbackDisplay();
  const { x, y, width, height } = display.bounds;

  playerWindow = new BrowserWindow({
    x,
    y,
    width,
    height,
    show: false,
    frame: false,
    backgroundColor: '#000000',
    autoHideMenuBar: true,
    skipTaskbar: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false },
  });

  // The overlay is owned by this window, so a new video window needs a new
  // overlay; an owned window cannot be re-parented after creation.
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.destroy();
    overlayWindow = null;
  }

  // An owned window stays above its owner but does not follow it, so the
  // controls have to be moved whenever the video window moves or resizes.
  const followParent = () => {
    if (!overlayWindow || overlayWindow.isDestroyed()) return;
    if (!playerWindow || playerWindow.isDestroyed()) return;
    overlayWindow.setBounds(playerWindow.getBounds());
  };
  playerWindow.on('move', followParent);
  playerWindow.on('resize', followParent);
  playerWindow.on('enter-full-screen', followParent);
  playerWindow.on('leave-full-screen', followParent);

  // Nothing is loaded into it: mpv owns the surface via --wid.
  playerWindow.on('closed', () => { playerWindow = null; });
  playerWindow.on('focus', () => { playerFocused = true; syncOverlayVisibility(); });
  playerWindow.on('blur', () => { playerFocused = false; syncOverlayVisibility(); });
  return playerWindow;
}

/**
 * The controls float above the video, so they must disappear the moment the
 * video is not what the user is looking at. Without this the control bar and
 * title stayed on top of whatever application was switched to.
 */
function syncOverlayVisibility() {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  if (!player || !player.isRunning) return;

  // The video lives inside the player window, so focus on either of the two
  // playback windows means the user is watching. Focus on the browse window, or
  // on another application entirely, means they are not.
  // If mpv never reports focus (an older build, or a video output that does
  // not support it), fall back to assuming the video has it rather than
  // hiding controls that would then never come back.
  const videoFocused = mpvFocusReported ? mpvFocused : true;
  const shouldShow = (overlayFocused || videoFocused) && !mainFocused;

  // Focus bounces between the video window and the controls as they are shown
  // and raised, and every bounce briefly looks like the user leaving. Showing
  // is immediate; hiding waits, so a flicker never blanks the controls while
  // genuinely switching away still dismisses them promptly.
  clearTimeout(overlayHideTimer);

  if (shouldShow) {
    if (!overlayWindow.isVisible()) overlayWindow.showInactive();
    // Keep the controls above the video window, which is itself topmost.
    overlayWindow.setAlwaysOnTop(true, 'screen-saver');
    overlayWindow.moveTop();
    return;
  }

  overlayHideTimer = setTimeout(() => {
    if (!overlayWindow || overlayWindow.isDestroyed()) return;
    const stillWatching = (overlayFocused
      || (mpvFocusReported ? mpvFocused : true)) && !mainFocused;
    if (stillWatching) return;
    overlayWindow.setAlwaysOnTop(false);
    overlayWindow.hide();
  }, 400);
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
    // Deliberately NOT owned by the player window. Making it a child seemed
    // tidy — Windows keeps a child above its parent and moves it along — but a
    // transparent (layered) child sitting over mpv's Direct3D child surface
    // stops that surface being composited, and the video goes black while mpv
    // carries on decoding perfectly happily.
    //
    // So it is a separate always-on-top window aligned to the same bounds.
    // Focus tracking, not ownership, is what stops it floating over other
    // applications: it hides as soon as neither the video nor the controls
    // hold focus.
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

  overlayWindow.setIgnoreMouseEvents(true, { forward: true });

  if (DEV_SERVER_URL) {
    overlayWindow.loadURL(DEV_SERVER_URL + 'overlay.html');
  } else {
    overlayWindow.loadFile(path.join(HERE, '..', 'dist', 'overlay.html'));
  }

  overlayWindow.on('focus', () => { overlayFocused = true; syncOverlayVisibility(); });
  overlayWindow.on('blur', () => { overlayFocused = false; syncOverlayVisibility(); });
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
  // An explicit choice from the "move to next screen" control wins until
  // playback ends, so the video does not jump back on the next episode.
  if (displayOverride) {
    const still = screen.getAllDisplays().find((d) => d.id === displayOverride.id);
    if (still) return still;
    displayOverride = null;
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    return screen.getDisplayMatching(mainWindow.getBounds());
  }
  return screen.getPrimaryDisplay();
}

/**
 * Move playback to the next monitor.
 *
 * mpv cannot reliably be dragged between monitors while borderless and
 * fullscreen, so playback is restarted on the target display from the current
 * position instead. That costs a brief black frame and is completely reliable.
 */
/**
 * Put the video window over a display, and align the controls to it.
 *
 * mpv reports its own window handle, which is the only reliable way to place it:
 * every option and property mpv offers for choosing a monitor was measured
 * doing nothing on this machine.
 */
async function applyVideoBounds(bounds, options) {
  if (!player || !player.isRunning) return false;
  videoBounds = bounds;

  // The controls are one of our own windows, so they move immediately and
  // exactly; mpv's window is chased into place behind them.
  if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.setBounds(bounds);

  if (!videoHwnd) {
    try { videoHwnd = await player.getWindowHandle(); } catch { videoHwnd = null; }
  }
  if (!videoHwnd) return false;

  // A drag produces pointer events faster than Windows finishes moving a
  // window. Queueing every one of them made the video trail the cursor, so
  // only the newest rectangle is kept while a move is in flight.
  if (movePending && !(options && options.flush)) {
    queuedBounds = bounds;
    return true;
  }

  movePending = true;
  let moved = false;
  try {
    // Only the settled position raises the window. Doing it on every frame of
    // a drag would be wasted work, and the window is already in front by then.
    moved = await moveWindowTo(videoHwnd, bounds, {
      raise: Boolean(options && options.flush),
    });
  } catch (error) {
    console.warn('Could not place the video window: ' + error.message);
  } finally {
    movePending = false;
  }

  if (queuedBounds) {
    const next = queuedBounds;
    queuedBounds = null;
    return applyVideoBounds(next);
  }
  return moved;
}

/** Cover a whole display: what fullscreen means for a borderless window. */
async function placeVideoWindow(display) {
  videoFullscreen = true;
  const bounds = fullscreenBounds(display);
  const moved = await applyVideoBounds(bounds, { flush: true });
  sendOverlayState({ fullscreen: true });
  console.log('video window -> ' + bounds.x + ',' + bounds.y
    + ' ' + bounds.width + 'x' + bounds.height + (moved ? ' ok' : ' FAILED'));
  return moved;
}

/** The display the video window is sitting on right now. */
function videoDisplay() {
  if (!videoBounds) return playbackDisplay();
  return screen.getDisplayMatching(videoBounds);
}

/** Switch between covering a display and being a window that can be dragged. */
async function setFullscreen(next) {
  if (!player || !player.isRunning) return { ok: false, error: 'Nothing is playing' };
  const display = videoDisplay();
  displayOverride = display;

  videoFullscreen = Boolean(next);
  const bounds = videoFullscreen
    ? fullscreenBounds(display)
    : windowedBounds(display, videoAspect);
  await applyVideoBounds(bounds, { flush: true });
  sendOverlayState({ fullscreen: videoFullscreen });
  return { ok: true, fullscreen: videoFullscreen };
}

/**
 * Start a pointer gesture. The control bar doubles as the window's title bar,
 * because a borderless window does not have one to grab.
 */
function beginGesture(kind, point) {
  if (!player || !player.isRunning || !videoBounds) return { ok: false };

  gesture = {
    kind,
    origin: point,
    startBounds: { ...videoBounds },
    // Nothing happens until the press is clearly a drag: the control bar is
    // also how the window is focused, and what a button is reached across.
    armed: false,
    startedAt: Date.now(),
    // Dragging a fullscreen window restores it under the pointer, the way
    // dragging a maximised window does everywhere else in Windows.
    restoreTo: kind === 'move' && videoFullscreen
      ? windowedBounds(videoDisplay(), videoAspect)
      : null,
  };
  return { ok: true };
}

/** Whether the press has become a drag, arming it the first time it has. */
function gestureArmed(point) {
  if (gesture.armed) return true;
  if (!pastThreshold(gesture.origin, point, Date.now() - gesture.startedAt)) return false;

  gesture.armed = true;
  if (gesture.restoreTo) {
    videoFullscreen = false;
    sendOverlayState({ fullscreen: false });
  }
  return true;
}

/** The rectangle a gesture has reached. */
function gestureBounds(point) {
  return gesture.kind === 'move'
    ? dragBounds(gesture, point)
    : resizeBounds(gesture, point, videoAspect);
}

function continueGesture(point) {
  if (!gesture || !gestureArmed(point)) return;
  applyVideoBounds(gestureBounds(point));
}

async function endGesture(point) {
  if (!gesture) return { ok: false };
  // A press that never travelled is a click, and must leave the window alone.
  if (!gesture.armed) {
    gesture = null;
    return { ok: true, moved: false };
  }
  const bounds = gestureBounds(point);
  gesture = null;

  // Settle on whichever display it was dropped on, so the next episode and the
  // "move to next screen" control both agree about where the video lives.
  const landed = screen.getDisplayMatching(bounds);
  displayOverride = landed;
  await applyVideoBounds(clampToDisplay(bounds, landed), { flush: true });
  return { ok: true };
}

/** Displays ordered the way they sit on the desk, so "next" means next along. */
function displaysLeftToRight() {
  return [...screen.getAllDisplays()].sort((a, b) => a.bounds.x - b.bounds.x || a.bounds.y - b.bounds.y);
}

async function moveToNextScreen() {
  const displays = displaysLeftToRight();
  if (displays.length < 2) return { ok: false, error: 'Only one display is connected' };
  if (!player || !player.isRunning) return { ok: false, error: 'Nothing is playing' };

  const current = playbackDisplay();
  const index = displays.findIndex((entry) => entry.id === current.id);
  displayOverride = displays[(index + 1) % displays.length];

  // Moving the window is enough: no restart, so playback never pauses, the
  // position is kept and there is no black frame.
  const moved = videoFullscreen
    ? await placeVideoWindow(displayOverride)
    : await applyVideoBounds(windowedBounds(displayOverride, videoAspect), { flush: true });
  sendOverlayState({ displayCount: displays.length });
  return moved
    ? { ok: true }
    : { ok: false, error: 'Could not move the video to the next screen' };
}

function showOverlay(targetDisplay) {
  const display = targetDisplay ?? playbackDisplay();
  if (!overlayWindow || overlayWindow.isDestroyed()) createOverlayWindow(display);

  // mpv fullscreens on the named display, so the display's own bounds are what
  // the controls must match. (An earlier version measured a BrowserWindow we
  // used to embed the video in; that window is gone, and reading its stale
  // bounds put the controls on the display the video had previously been on.)
  overlayWindow.setBounds(videoBounds ?? display.bounds);

  // The overlay takes focus deliberately. An unfocused window on Windows
  // consumes the first click to activate itself, which made every control feel
  // dead until it had been clicked twice. Keyboard shortcuts are handled by the
  // overlay and forwarded to mpv, so nothing is lost by holding focus here.
  overlayWindow.show();
  overlayWindow.focus();
  overlayWindow.setIgnoreMouseEvents(true, { forward: true });
  startCursorWatch();
}

function hideOverlay() {
  stopCursorWatch();
  if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.hide();
}

/**
 * Poll the cursor and wake the controls when it moves.
 *
 * The overlay is click-through while its controls are hidden. Electron can
 * forward mouse-move messages to a click-through window, but that proved
 * unreliable here — the controls stayed hidden no matter how much the pointer
 * moved. Reading the cursor position directly always works, and at 12Hz costs
 * nothing measurable.
 */
function startCursorWatch() {
  stopCursorWatch();
  let last = screen.getCursorScreenPoint();

  cursorWatch = setInterval(() => {
    if (!overlayWindow || overlayWindow.isDestroyed() || !overlayWindow.isVisible()) return;
    const point = screen.getCursorScreenPoint();
    if (point.x === last.x && point.y === last.y) return;
    last = point;
    overlayWindow.webContents.send('overlay:wake');
  }, 80);
}

function stopCursorWatch() {
  if (cursorWatch) {
    clearInterval(cursorWatch);
    cursorWatch = null;
  }
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
  // Nothing left to move, so the window helper does not need to stay running.
  releaseWindowMover();
  videoHwnd = null;
  videoBounds = null;
  gesture = null;
  queuedBounds = null;
  videoFullscreen = true;

  if (overlayWindow && !overlayWindow.isDestroyed()) {
    stopCursorWatch();
    overlayWindow.hide();
  }
  if (playerWindow && !playerWindow.isDestroyed()) {
    playerWindow.setAlwaysOnTop(false);
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

  // Either prompt can be switched off from the Library screen. Off means the
  // prompt is never offered, whether its timing came from a chapter marker or
  // from a conventional offset.
  const introEnabled = config.skipIntroEnabled !== false;
  const outroEnabled = config.skipOutroEnabled !== false;
  if (!introEnabled && !outroEnabled) return { intro: null, outro: null };

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

  // Without chapters all we have is a convention, so say so. The button shows
  // where it will land, and the amount is configurable, because an intro that
  // starts after a cold open cannot be guessed from the runtime alone.
  if (!intro && duration && duration > 8 * 60 && introLength > 0) {
    intro = { from: 5, to: introLength, approximate: true };
  }

  // The end marker only decides when to offer the next episode. It never seeks:
  // an approximate "skip outro" jumped past the last minute of the episode,
  // which is real content, not credits.
  if (!outro && duration && duration > 8 * 60) {
    outro = { from: Math.max(0, duration - outroLength), approximate: true };
  }

  return {
    intro: introEnabled ? intro : null,
    outro: outroEnabled ? outro : null,
  };
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

  const display = playbackDisplay();

  ensurePlayer(null);

  // mpv gets its own window rather than being embedded in one of ours. A
  // transparent window layered over mpv's Direct3D surface stops that surface
  // being composited: with the controls visible the picture went black while
  // mpv carried on decoding. Two separate top-level windows composite normally.
  player.embed = false;
  player.windowHandle = null;

  // A new file means a new mpv window: the cached handle would point at the
  // old one, and dragging would move a window that is no longer there.
  videoHwnd = null;
  gesture = null;
  queuedBounds = null;



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

    // mpv cannot choose its own monitor, so place its window over the target
    // display once it exists. Failure here is cosmetic — the video still plays,
    // just possibly on the wrong screen — so it must not abort playback.
    await placeVideoWindow(display);

    {
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
        displayCount: screen.getAllDisplays().length,
        hasNext: queueIndex < queue.length - 1,
        hasPrev: queueIndex > 0,
        fullscreen: videoFullscreen,
        nextTitle: queue[queueIndex + 1]?.title ?? null,
        skip: { intro: null, outro: null },
      };
      showOverlay(display);
      startCursorWatch();
      sendOverlayState(overlayState);

      // Track lists and chapters only exist once mpv has loaded the file.
      player.getTracks()
        .then((tracks) => sendOverlayState(describeTracks(tracks)))
        .catch(() => { /* the overlay simply omits track menus */ });

      player.command(['get_property', 'duration'])
        .then((duration) => detectSkipPoints(duration))
        .then((skip) => sendOverlayState({ skip }))
        .catch(() => { /* skip buttons stay hidden */ });

      // Keys reach whichever window has focus, and while watching that is
      // usually mpv rather than the controls. Pointing mpv's own bindings at
      // the app means one key does one thing either way — before this, f
      // toggled mpv's idea of fullscreen and fought with the window placement.
      for (const [key, message] of [
        ['f', 'app-fullscreen'],
        ['F11', 'app-fullscreen'],
        ['DBL_MBTN_LEFT', 'app-fullscreen'],
        ['ESC', 'app-escape'],
      ]) {
        player.command(['keybind', key, 'script-message ' + message])
          .catch(() => { /* an older mpv simply keeps its own bindings */ });
      }

      // The video's shape, so resizing the window cannot introduce bars the
      // file does not have. Falling back to 16:9 is close enough to be
      // invisible for the rare file that does not report it.
      player.command(['get_property', 'video-params/aspect'])
        .then((aspect) => {
          videoAspect = typeof aspect === 'number' && aspect > 0 ? aspect : 16 / 9;
        })
        .catch(() => { videoAspect = 16 / 9; });
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

  player = new MpvPlayer({ mpvPath, windowHandle, embed: true, useOverlay: true });

  player.on('position', ({ videoId, position, duration }) => {
    writeProgress(videoId, position, duration);
    sendOverlayState({ position, duration });
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('player:position', { videoId, position, duration });
    }
  });

  player.on('property', ({ name, value }) => {
    if (name === 'pause') {
      console.log('pause -> ' + (value ? 'True' : 'False'));
      sendOverlayState({ paused: Boolean(value) });
    }
    else if (name === 'volume' && typeof value === 'number') sendOverlayState({ volume: value });
    else if (name === 'mute') sendOverlayState({ muted: Boolean(value) });
    else if (name === 'sid') sendOverlayState({ subtitleId: typeof value === 'number' ? value : null });
    else if (name === 'aid') sendOverlayState({ audioId: typeof value === 'number' ? value : null });
    else if (name === 'duration' && typeof value === 'number') sendOverlayState({ duration: value });
    else if (name === 'focused') {
      mpvFocused = Boolean(value);
      mpvFocusReported = true;
      syncOverlayVisibility();
    }
  });

  // Keys pressed while mpv has focus arrive here, because mpv was told to
  // forward them rather than act on them itself.
  player.on('event', (message) => {
    if (message.event !== 'client-message') return;
    const name = (message.args ?? [])[0];

    if (name === 'app-fullscreen') {
      setFullscreen(!videoFullscreen);
    } else if (name === 'app-escape') {
      // Escape leaves fullscreen first and only then closes, so it is never a
      // single keystroke between watching and losing the picture.
      if (videoFullscreen) setFullscreen(false);
      else player.stop().then(() => { hideOverlay(); closePlayerWindow(); });
    }
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
    displayOverride = null;
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

  ipcMain.handle('library:dataDir', () => currentDataDir());
  ipcMain.handle('library:setDataDir', async (event, target) => relocateDataDir(target));

  ipcMain.handle('player:play', async (event, options) => {
    // A show sends its remaining episodes so the player can advance on its own.
    queue = Array.isArray(options.queue) && options.queue.length
      ? options.queue
      : [{ ...options }];
    queueIndex = Math.max(0, queue.findIndex((entry) => entry.videoId === options.videoId));
    return startQueueEntry(queueIndex, options.startPosition ?? 0);
  });

  ipcMain.handle('player:next', async () => startQueueEntry(queueIndex + 1, 0));
  ipcMain.handle('player:moveScreen', async () => moveToNextScreen());
  ipcMain.handle('player:setFullscreen', async (event, next) => setFullscreen(Boolean(next)));
  ipcMain.handle('player:toggleFullscreen', async () => setFullscreen(!videoFullscreen));

  // Dragging and resizing are sent one-way. Waiting for a reply per pointer
  // event would put a round trip between the cursor and the window, which is
  // exactly the lag that makes a dragged window feel broken.
  ipcMain.on('player:gestureStart', (event, payload) => {
    if (payload && payload.point) beginGesture(payload.kind, payload.point);
  });
  ipcMain.on('player:gestureMove', (event, point) => { if (point) continueGesture(point); });
  ipcMain.on('player:gestureEnd', (event, point) => { if (point) endGesture(point); });
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

/**
 * Record a fatal startup problem where it can be found afterwards.
 *
 * A packaged Windows app has no console, so an error dialog is the only thing
 * the user sees and nothing survives to diagnose from. This writes the detail
 * next to the app's data and tells the user where to look.
 */
function logStartupError(error) {
  const detail = String((error && error.stack) || error);
  let logPath = null;
  try {
    const dir = app.getPath('userData');
    fs.mkdirSync(dir, { recursive: true });
    logPath = path.join(dir, 'startup-error.log');
    fs.writeFileSync(logPath, new Date().toISOString() + '\n' + detail + '\n', 'utf8');
  } catch {
    // Nowhere to write; the dialog below is all we have.
  }
  console.error(detail);
  return { detail, logPath };
}

app.whenReady().then(async () => {
  try {
    await startApiServer();
  } catch (error) {
    const { detail, logPath } = logStartupError(error);
    dialog.showErrorBox(
      'Failed to start the media server',
      detail + (logPath ? '\n\nDetails written to:\n' + logPath : ''),
    );
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
