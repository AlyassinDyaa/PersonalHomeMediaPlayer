/**
 * Maps Electron's displays onto the Windows device names mpv understands.
 *
 * mpv picks its own fullscreen monitor. `--geometry` does not influence that
 * choice — aiming at two different displays was measured landing on the same
 * one — so on a multi-monitor desktop the video could appear on a different
 * screen from the controls. `--fs-screen-name` does decide it, but it wants a
 * Windows device name (`\\.\DISPLAY3`), which Electron never exposes.
 *
 * The two are correlated by position: .NET reports both the device name and the
 * bounds of every screen, so matching bounds gives the name for a display
 * Electron already identified. Read once and cached, since it costs a process.
 */

const { execFile } = require('node:child_process');

let cached = null;

const SCRIPT = [
  'Add-Type -AssemblyName System.Windows.Forms;',
  '[System.Windows.Forms.Screen]::AllScreens |',
  'ForEach-Object {',
  '  [pscustomobject]@{',
  '    device = $_.DeviceName;',
  '    x = $_.Bounds.X; y = $_.Bounds.Y;',
  '    width = $_.Bounds.Width; height = $_.Bounds.Height',
  '  }',
  '} | ConvertTo-Json -Compress',
].join(' ');

/**
 * @returns {Promise<Array<{device: string, x: number, y: number, width: number, height: number}>>}
 */
function loadDisplayDevices() {
  if (process.platform !== 'win32') return Promise.resolve([]);
  if (cached) return Promise.resolve(cached);

  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', SCRIPT],
      { timeout: 8000, windowsHide: true },
      (error, stdout) => {
        if (error) {
          console.warn('Could not enumerate display device names: ' + error.message);
          resolve([]);
          return;
        }
        try {
          const parsed = JSON.parse(String(stdout).trim());
          // A single screen comes back as an object rather than an array.
          cached = Array.isArray(parsed) ? parsed : [parsed];
          resolve(cached);
        } catch (parseError) {
          console.warn('Could not read display device names: ' + parseError.message);
          resolve([]);
        }
      },
    );
  });
}

/**
 * The Windows device name for an Electron display, matched on bounds.
 * @param {{bounds: {x: number, y: number, width: number, height: number}}} display
 * @returns {Promise<string|null>}
 */
async function deviceNameFor(display) {
  const devices = await loadDisplayDevices();
  const { x, y, width, height } = display.bounds;

  const exact = devices.find((d) => d.x === x && d.y === y && d.width === width && d.height === height);
  if (exact) return exact.device;

  // Position alone is enough to identify a screen; sizes can differ if Windows
  // reports scaled bounds where Electron reports logical ones.
  const byOrigin = devices.find((d) => d.x === x && d.y === y);
  return byOrigin ? byOrigin.device : null;
}

module.exports = { loadDisplayDevices, deviceNameFor };
