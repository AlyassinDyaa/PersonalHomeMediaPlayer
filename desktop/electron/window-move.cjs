/**
 * Moves and resizes mpv's window.
 *
 * mpv will not place itself. Measured on this machine: `--fs-screen-name` is
 * accepted and ignored, `--geometry` does not influence which monitor a
 * fullscreen window lands on, and setting `geometry` or `fs-screen` over IPC at
 * runtime reports success while the window stays put. What does work is asking
 * Windows directly, using the HWND mpv reports as `window-id`.
 *
 * So mpv runs borderless but not fullscreen, and the window is positioned to
 * cover whatever rectangle we want. That looks identical to fullscreen and,
 * unlike it, can be moved and resized while playing — no restart, no black
 * frame, no lost position.
 *
 * Dragging needs this to be fast. Starting a PowerShell process per call costs
 * around 200ms, which is fine for jumping to another monitor and useless for
 * following the pointer, so one helper process is kept alive and fed one line
 * of work at a time. It reaches the window in about a millisecond.
 */

const { spawn, execFile } = require('node:child_process');

/** SWP_NOACTIVATE | SWP_SHOWWINDOW — move without stealing focus. */
const SWP_FLAGS = 0x0010 | 0x0040;
/** The same, plus SWP_NOMOVE | SWP_NOSIZE, for a z-order-only call. */
const SWP_ZORDER_ONLY = SWP_FLAGS | 0x0002 | 0x0001;

// A here-string header has to end its own line, so this is joined with newlines
// rather than written as one string.
const DECLARE = [
  'Add-Type @"',
  'using System;',
  'using System.Runtime.InteropServices;',
  'public class MediaPlayerWin {',
  '  [DllImport("user32.dll")] public static extern bool SetWindowPos(',
  '    IntPtr hWnd, IntPtr insertAfter, int x, int y, int cx, int cy, uint flags);',
  '}',
  '"@',
].join('\n');

/*
 * Reads "<id> <hwnd> <x> <y> <w> <h> <raise>" per line, answers "<id> True|False".
 *
 * Raising is the topmost/not-topmost pair rather than HWND_TOP. Windows will
 * not lift a background process's window above the foreground application with
 * HWND_TOP alone, which is how the video ended up playing behind whatever else
 * was open on the monitor it had just been dragged onto. Making it topmost and
 * immediately releasing that leaves it at the front of the ordinary z-order,
 * where a video window belongs, without it floating over everything for good.
 */
const SERVER = DECLARE + '\n' + [
  '[Console]::OutputEncoding = [System.Text.Encoding]::ASCII',
  'while ($true) {',
  '  $line = [Console]::In.ReadLine()',
  '  if ($null -eq $line) { break }',
  '  $p = $line.Split(" ")',
  '  if ($p.Length -lt 6) { continue }',
  '  try {',
  '    $h = [IntPtr][int64]$p[1]',
  '    $raise = ($p.Length -gt 6) -and ($p[6] -eq "1")',
  '    $after = if ($raise) { [IntPtr](-1) } else { [IntPtr]0 }',
  '    $ok = [MediaPlayerWin]::SetWindowPos(',
  '      $h, $after,',
  '      [int]$p[2], [int]$p[3], [int]$p[4], [int]$p[5], ' + SWP_FLAGS + ')',
  '    if ($raise) {',
  '      [MediaPlayerWin]::SetWindowPos($h, [IntPtr](-2), 0, 0, 0, 0, '
    + SWP_ZORDER_ONLY + ') | Out-Null',
  '    }',
  '    [Console]::Out.WriteLine($p[0] + " " + $ok)',
  '  } catch {',
  '    [Console]::Out.WriteLine($p[0] + " False")',
  '  }',
  '  [Console]::Out.Flush()',
  '}',
].join('\n');

let helper = null;      // the long-lived PowerShell process
let pending = new Map(); // request id -> resolve
let nextId = 1;
let buffered = '';

function stopHelper() {
  if (!helper) return;
  const dying = helper;
  helper = null;
  for (const resolve of pending.values()) resolve(false);
  pending = new Map();
  buffered = '';
  try { dying.stdin.end(); } catch { /* already gone */ }
  try { dying.kill(); } catch { /* already gone */ }
}

function startHelper() {
  if (helper) return helper;

  // -EncodedCommand sidesteps every layer of quoting between here and
  // PowerShell, which matters because the script contains quotes and braces.
  const encoded = Buffer.from(SERVER, 'utf16le').toString('base64');
  const child = spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
    { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true },
  );

  child.on('error', stopHelper);
  child.on('exit', stopHelper);
  child.stdout.setEncoding('ascii');
  child.stdout.on('data', (chunk) => {
    buffered += chunk;
    let cut = buffered.indexOf('\n');
    while (cut !== -1) {
      const [id, verdict] = buffered.slice(0, cut).trim().split(' ');
      buffered = buffered.slice(cut + 1);
      const resolve = pending.get(id);
      if (resolve) {
        pending.delete(id);
        resolve(verdict === 'True');
      }
      cut = buffered.indexOf('\n');
    }
  });

  helper = child;
  return child;
}

/** One-shot fallback, used only if the helper cannot be kept alive. */
function moveOnce(hwnd, x, y, width, height, raise) {
  const script = DECLARE + '\n'
    + '$h = [IntPtr]' + hwnd + '\n'
    + '[MediaPlayerWin]::SetWindowPos($h, [IntPtr]' + (raise ? '(-1)' : '0') + ', '
    + x + ', ' + y + ', ' + width + ', ' + height + ', ' + SWP_FLAGS + ')'
    + (raise
      ? '\n[MediaPlayerWin]::SetWindowPos($h, [IntPtr](-2), 0, 0, 0, 0, '
        + SWP_ZORDER_ONLY + ') | Out-Null'
      : '');

  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: 8000, windowsHide: true },
      (error, stdout) => {
        if (error) {
          console.warn('Could not position the video window: ' + error.message);
          resolve(false);
          return;
        }
        resolve(String(stdout).trim() === 'True');
      },
    );
  });
}

/**
 * Move and resize a window.
 * @param {number|string} hwnd Window handle, as mpv reports it.
 * @param {{x: number, y: number, width: number, height: number}} bounds
 * @param {{raise?: boolean}} [options] raise brings it to the front of the
 *   ordinary z-order, which a move onto another monitor needs.
 * @returns {Promise<boolean>} whether Windows accepted the call
 */
function moveWindowTo(hwnd, bounds, options) {
  if (process.platform !== 'win32' || !hwnd) return Promise.resolve(false);
  const raise = Boolean(options && options.raise);

  const x = Math.round(bounds.x);
  const y = Math.round(bounds.y);
  const width = Math.round(bounds.width);
  const height = Math.round(bounds.height);

  const child = startHelper();
  if (!child) return moveOnce(hwnd, x, y, width, height, raise);

  const id = String(nextId++);
  return new Promise((resolve) => {
    pending.set(id, resolve);
    try {
      child.stdin.write([id, hwnd, x, y, width, height, raise ? 1 : 0].join(' ') + '\n');
    } catch {
      pending.delete(id);
      stopHelper();
      moveOnce(hwnd, x, y, width, height, raise).then(resolve);
      return;
    }
    // Never leave a caller hanging on a helper that has stopped answering.
    setTimeout(() => {
      if (!pending.has(id)) return;
      pending.delete(id);
      resolve(false);
    }, 4000);
  });
}

/** Release the helper process; playback is over. */
function releaseWindowMover() {
  stopHelper();
}

module.exports = { moveWindowTo, releaseWindowMover };
