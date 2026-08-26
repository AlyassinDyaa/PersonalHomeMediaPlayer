/**
 * The files served to a browser.
 *
 * The desktop interface is loaded from disk by Electron and never travels over
 * HTTP. The browser build is a separate bundle, so a phone or tablet gets a
 * layout meant for a touch screen rather than a shrunken desktop one.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, '..', '..');

/** Where the built browser interface lives. */
export function webAppDir() {
  if (process.env.MEDIA_WEB_DIR) return process.env.MEDIA_WEB_DIR;
  return path.join(PROJECT_ROOT, 'desktop', 'dist-web');
}

/**
 * The login screen.
 *
 * Written out here rather than bundled, so it works even if the browser build
 * is missing — otherwise a broken build would leave no way in and no
 * explanation of why.
 */
export function loginPage({ configured }) {
  const name = config.libraryName
    ? escapeHtml(config.libraryName) + '’s Library'
    : 'My Library';
  const colour = /^#[0-9a-f]{6}$/i.test(config.libraryColor ?? '')
    ? config.libraryColor
    : '#e50914';

  const body = configured
    ? `<form id="form">
         <input id="passcode" type="password" inputmode="numeric" autocomplete="current-password"
                placeholder="Passcode" autofocus />
         <button type="submit">Enter</button>
         <p id="error" class="error" hidden></p>
       </form>`
    : `<p class="note">This library is not being shared on the network.
         Turn sharing on in the app on the computer, under Library.</p>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>${name}</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    background: #0b0b0f; color: #f4f4f6;
    font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    padding: 24px;
  }
  .card { width: 100%; max-width: 340px; text-align: center; }
  h1 { color: ${colour}; font-size: 26px; font-weight: 800; letter-spacing: -0.4px; margin: 0 0 6px; }
  .sub { color: #a8a8b3; font-size: 14px; margin: 0 0 28px; }
  input {
    width: 100%; padding: 15px 16px; font-size: 17px; text-align: center;
    letter-spacing: 3px; border-radius: 10px; border: 1px solid #2a2a35;
    background: #16161d; color: #f4f4f6; margin-bottom: 12px;
  }
  input:focus { outline: none; border-color: ${colour}; }
  button {
    width: 100%; padding: 15px; font-size: 16px; font-weight: 600; border: none;
    border-radius: 10px; background: ${colour}; color: #fff; cursor: pointer;
  }
  button:disabled { opacity: 0.6; }
  .error { color: #ff6b74; font-size: 14px; margin: 14px 0 0; }
  .note { color: #a8a8b3; font-size: 14.5px; }
</style>
</head>
<body>
  <div class="card">
    <h1>${name}</h1>
    <p class="sub">Enter the passcode to watch</p>
    ${body}
  </div>
<script>
  const form = document.getElementById('form');
  if (form) {
    const error = document.getElementById('error');
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const button = form.querySelector('button');
      button.disabled = true;
      error.hidden = true;
      try {
        const response = await fetch('/api/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ passcode: document.getElementById('passcode').value }),
        });
        if (response.ok) { window.location.replace('/'); return; }
        const body = await response.json().catch(() => ({}));
        error.textContent = body.error || 'That did not work';
        error.hidden = false;
      } catch (failure) {
        error.textContent = 'Could not reach the library';
        error.hidden = false;
      }
      button.disabled = false;
      document.getElementById('passcode').select();
    });
  }
</script>
</body>
</html>`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
