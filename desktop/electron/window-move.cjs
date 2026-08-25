/**
 * Places mpv's window on a chosen monitor.
 *
 * mpv will not do this itself. Measured on this machine: `--fs-screen-name`
 * is accepted and ignored, `--geometry` does not influence which monitor a
 * fullscreen window lands on, and setting `geometry` or `fs-screen` over IPC at
 * runtime reports success while the window stays put. What does work is asking
 * Windows directly, using the HWND mpv reports as `window-id`.
 *
 * So mpv runs borderless but not fullscreen, and the window is positioned to
 * cover the target display. That looks identical to fullscreen and, unlike it,
 * can be moved between monitors while playing — no restart, no black frame, no
 * lost position.
 */

const { execFile } = require('node:child_process');

/** SWP_NOACTIVATE | SWP_SHOWWINDOW — move without stealing focus. */
const SWP_FLAGS = 0x0010 | 0x0040;

// A here-string header must end its line, so this is assembled with newlines.
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

/**
 * Move and resize a window.
 * @param {number|string} hwnd Window handle, as mpv reports it.
 * @param {{x: number, y: number, width: number, height: number}} bounds
 * @returns {Promise<boolean>} whether Windows accepted the call
 */
function moveWindowTo(hwnd, bounds) {
  if (process.platform !== 'win32' || !hwnd) return Promise.resolve(false);

  const { x, y, width, height } = bounds;
  const script = DECLARE + '\n'
    + '[MediaPlayerWin]::SetWindowPos([IntPtr]' + hwnd + ', [IntPtr]0, '
    + Math.round(x) + ', ' + Math.round(y) + ', '
    + Math.round(width) + ', ' + Math.round(height) + ', ' + SWP_FLAGS + ')';

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

module.exports = { moveWindowTo };
