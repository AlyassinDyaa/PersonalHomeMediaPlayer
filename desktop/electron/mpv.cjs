/**
 * mpv process controller.
 *
 * mpv is embedded into a window we own (via --wid) and driven over its JSON
 * IPC channel, which on Windows is a named pipe. This gives full-fidelity
 * playback of formats a browser engine cannot open at all, while keeping
 * playback state observable so watch progress can be recorded.
 *
 * CommonJS because Electron's main process loads it; the renderer is ESM.
 */

const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');

/** Locations to look for mpv when no explicit path is configured. */
const MPV_CANDIDATES = [
  'C:/Program Files/MPV Player/mpv.exe',
  'C:/Program Files/mpv/mpv.exe',
  'C:/Program Files (x86)/MPV Player/mpv.exe',
  process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs/mpv/mpv.exe') : null,
  '/usr/bin/mpv',
  '/usr/local/bin/mpv',
  '/opt/homebrew/bin/mpv',
].filter(Boolean);

function resolveMpvPath(configured) {
  const candidates = [configured, process.env.MPV_PATH, ...MPV_CANDIDATES].filter(Boolean);
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // Ignore unreadable candidates and keep looking.
    }
  }
  return null;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Properties we watch; ids are arbitrary but must be stable per property. */
const OBSERVED = {
  1: 'time-pos',
  2: 'duration',
  3: 'pause',
  4: 'eof-reached',
  5: 'volume',
  6: 'sid',
  7: 'aid',
};

class MpvPlayer extends EventEmitter {
  /**
   * @param {object} options
   * @param {string} options.mpvPath
   * @param {string|null} [options.windowHandle] Parent HWND for embedded mode.
   * @param {boolean} [options.embed] Render inside our own window instead of
   *   letting mpv own a top-level one. Off by default: embedding via --wid
   *   displays video correctly but mouse and keyboard events never reach mpv's
   *   child window, so its on-screen controls never appear and seeking is
   *   impossible. Verified by screenshot comparison of both modes.
   */
  constructor({ mpvPath, windowHandle = null, embed = false }) {
    super();
    this.mpvPath = mpvPath;
    this.windowHandle = windowHandle;
    this.embed = embed;
    this.process = null;
    this.socket = null;
    this.requestId = 0;
    this.pending = new Map();
    this.buffer = '';
    this.state = { position: 0, duration: null, paused: false, volume: 100 };
    this.currentVideoId = null;
    this.pipeName = null;
  }

  get isRunning() {
    return Boolean(this.process) && this.process.exitCode === null;
  }

  /**
   * Launch mpv on a file.
   * @param {object} options
   * @param {string} options.filePath Absolute path to the media file.
   * @param {string} [options.videoId] Library id, echoed back on progress events.
   * @param {number} [options.startPosition] Resume point in seconds.
   * @param {string[]} [options.subtitleFiles] External subtitle paths to attach.
   * @param {string} [options.title] Window title.
   */
  async start({ filePath, videoId = null, startPosition = 0, subtitleFiles = [], title = '' }) {
    if (this.isRunning) await this.stop();

    this.currentVideoId = videoId;
    this.state = { position: startPosition, duration: null, paused: false, volume: 100 };

    const unique = process.pid + '-' + Date.now();
    this.pipeName = process.platform === 'win32'
      ? '\\\\.\\pipe\\mediaplayer-mpv-' + unique
      : path.join('/tmp', 'mediaplayer-mpv-' + unique + '.sock');

    const args = [
      // Ignore any user mpv config so a broken global setting cannot break the app.
      '--no-config',
      '--input-ipc-server=' + this.pipeName,
      '--force-window=yes',
      '--idle=no',
      '--keep-open=no',
      // mpv's own on-screen controller provides transport controls inside the
      // embedded surface, where an HTML overlay cannot reach.
      '--osc=yes',
      '--osd-bar=yes',
      '--hwdec=auto-safe',
      '--sub-auto=fuzzy',
      '--audio-file-auto=fuzzy',
      '--volume=100',
    ];

    if (this.embed && this.windowHandle) {
      args.push('--wid=' + this.windowHandle);
    } else {
      // mpv owns a borderless fullscreen window, so it receives input directly
      // and can draw its own controls.
      args.push('--fullscreen=yes', '--ontop=yes', '--border=no');
    }

    if (startPosition > 0) args.push('--start=' + Math.floor(startPosition));
    if (title) args.push('--force-media-title=' + title);
    for (const subtitle of subtitleFiles) args.push('--sub-file=' + subtitle);

    args.push('--', filePath);

    this.process = spawn(this.mpvPath, args, {
      windowsHide: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    this.process.stderr.on('data', (chunk) => {
      const text = String(chunk).trim();
      if (text) this.emit('log', text);
    });

    this.process.on('exit', (code) => {
      this.emit('stopped', { videoId: this.currentVideoId, position: this.state.position, code });
      if (this.socket) this.socket.destroy();
      this.socket = null;
      this.process = null;
    });

    await this.connect();
    return { pid: this.process ? this.process.pid : null };
  }

  /** Connect to mpv's IPC pipe, which appears shortly after launch. */
  async connect(attempts = 80) {
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (!this.process) throw new Error('mpv exited before IPC was ready');
      try {
        const socket = await new Promise((resolve, reject) => {
          const candidate = net.connect(this.pipeName);
          candidate.once('connect', () => resolve(candidate));
          candidate.once('error', reject);
        });

        this.socket = socket;
        socket.setEncoding('utf8');
        socket.on('data', (chunk) => this.handleData(chunk));
        socket.on('error', () => { /* closes on mpv exit; handled by 'exit' */ });

        for (const id of Object.keys(OBSERVED)) {
          this.command(['observe_property', Number(id), OBSERVED[id]]).catch(() => {});
        }
        this.emit('ready');
        return;
      } catch {
        await sleep(50);
      }
    }
    throw new Error('timed out connecting to mpv IPC');
  }

  handleData(chunk) {
    this.buffer += chunk;
    let newline;
    while ((newline = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;

      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }

      if (message.request_id !== undefined && this.pending.has(message.request_id)) {
        const { resolve, reject } = this.pending.get(message.request_id);
        this.pending.delete(message.request_id);
        if (message.error && message.error !== 'success') reject(new Error(message.error));
        else resolve(message.data);
        continue;
      }

      if (message.event === 'property-change') {
        this.onPropertyChange(message.name, message.data);
      } else if (message.event) {
        this.emit('event', message);
        if (message.event === 'end-file') {
          this.emit('ended', { videoId: this.currentVideoId, reason: message.reason });
        }
      }
    }
  }

  onPropertyChange(name, value) {
    switch (name) {
      case 'time-pos':
        if (typeof value === 'number') {
          this.state.position = value;
          this.emit('position', {
            videoId: this.currentVideoId,
            position: value,
            duration: this.state.duration,
          });
        }
        break;
      case 'duration':
        if (typeof value === 'number') this.state.duration = value;
        break;
      case 'pause':
        this.state.paused = Boolean(value);
        this.emit('pause', this.state.paused);
        break;
      case 'volume':
        if (typeof value === 'number') this.state.volume = value;
        break;
      default:
        break;
    }
    this.emit('property', { name, value });
  }

  /** Send a command; resolves with mpv's reply. */
  command(args) {
    if (!this.socket) return Promise.reject(new Error('mpv is not connected'));
    const id = ++this.requestId;
    const payload = JSON.stringify({ command: args, request_id: id }) + '\n';
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.write(payload, (error) => {
        if (error) {
          this.pending.delete(id);
          reject(error);
        }
      });
      // Never leave a caller hanging if mpv dies mid-command.
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error('mpv command timed out: ' + args[0]));
        }
      }, 5000);
    });
  }

  setProperty(name, value) {
    return this.command(['set_property', name, value]);
  }

  togglePause() {
    return this.command(['cycle', 'pause']);
  }

  seek(seconds, mode = 'absolute') {
    return this.command(['seek', seconds, mode]);
  }

  setSubtitleTrack(id) {
    return this.setProperty('sid', id === null ? 'no' : id);
  }

  setAudioTrack(id) {
    return this.setProperty('aid', id);
  }

  addSubtitleFile(filePath) {
    return this.command(['sub-add', filePath, 'select']);
  }

  setVolume(volume) {
    return this.setProperty('volume', Math.max(0, Math.min(130, volume)));
  }

  getTracks() {
    return this.command(['get_property', 'track-list']);
  }

  async stop() {
    if (!this.process) return;
    const current = this.process;
    const finished = new Promise((resolve) => {
      current.once('exit', resolve);
      setTimeout(resolve, 3000);
    });
    try {
      await this.command(['quit']);
    } catch {
      try { current.kill(); } catch { /* already gone */ }
    }
    await finished;
  }
}

module.exports = { MpvPlayer, resolveMpvPath };
