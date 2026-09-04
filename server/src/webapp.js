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

  /*
   * A keypad drawn on the page, as well as the field.
   *
   * A tablet running this from its Home Screen has been unable to raise the
   * system keyboard for this field at all, which leaves somebody looking at a
   * passcode box they cannot answer and no way into their own library. Buttons
   * are not subject to whatever decides that: they are taps on a page.
   *
   * The field stays, and stays typeable, for every device where the keyboard
   * works normally. This is the way in when it does not.
   */
  const body = configured
    ? `<div id="faces" class="faces" hidden></div>
       <form id="form" hidden>
         <input id="passcode" type="text" inputmode="text" autocomplete="off"
                autocapitalize="none" autocorrect="off" spellcheck="false"
                placeholder="Passcode" />
         <div id="keypad" hidden>
           <div id="pad" class="pad"></div>
           <div class="pad-row">
             <button type="button" id="mode" class="alt">ABC</button>
             <button type="button" id="back" class="alt">Delete</button>
           </div>
         </div>
         <button type="submit">Enter</button>
         <button type="button" id="show-pad" class="link-button">Use the on-screen keypad</button>
         <p id="error" class="error" hidden></p>
       </form>`
    : `<p class="note">This library is not being shared on the network.
         Turn sharing on in the app on the computer, under Library.</p>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<link rel="apple-touch-icon" href="/icon-180.png" />
<link rel="icon" type="image/png" sizes="512x512" href="/icon-512.png" />
<meta name="apple-mobile-web-app-capable" content="yes" />
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
<meta name="apple-mobile-web-app-title" content="Library" />
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

  /* The faces on the door. Chosen first; the PIN follows. */
  .faces { display: flex; flex-wrap: wrap; justify-content: center; gap: 22px; }
  /* An element with a display rule ignores the hidden attribute unless told. */
  [hidden] { display: none !important; }
  .who {
    background: none; border: none; padding: 0; width: auto; cursor: pointer;
    display: flex; flex-direction: column; align-items: center; gap: 8px;
  }
  .who { position: relative; }
  .who-face {
    width: 112px; height: 112px; border-radius: 50%;
    display: grid; place-items: center;
    font-size: 38px; font-weight: 600; color: #fff;
    object-fit: cover; overflow: hidden;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
    border: 3px solid transparent;
    transition: border-color 0.15s ease, transform 0.15s ease;
  }
  .who:active .who-face { transform: scale(0.96); }
  .who-name { font-size: 15px; color: #d8d8e0; }
  /* A small badge, as on the picker inside the library. */
  .who-lock {
    position: absolute; top: -2px; right: -2px;
    font-size: 15px; line-height: 1;
  }
  /* The one being asked about stays on screen, alone. */
  .faces.asking .who { display: none; }
  .faces.asking .who.picked { display: flex; }
  .faces.asking { margin-bottom: 18px; }
  .back-to-faces {
    width: auto; background: none; border: none; color: #a8a8b3;
    font-size: 14px; padding: 10px; margin-top: 4px; cursor: pointer;
  }
  /*
   * The keypad is offered, not imposed.
   *
   * It exists because iOS sometimes refuses to raise its keyboard for this
   * field, which left people staring at a box they could not answer. That is
   * the exception though — on every device where the keyboard works, showing
   * a second one underneath it is clutter. So the field is the default and
   * this is the way out when it fails.
   */
  .link-button {
    width: auto; background: none; border: none; color: #8a8a96;
    font-size: 13px; padding: 12px 8px 4px; margin: 0 auto; cursor: pointer;
    text-decoration: underline; display: block;
  }
  h1 { color: ${colour}; font-size: 26px; font-weight: 800; letter-spacing: -0.4px; margin: 0 0 6px; }
  .sub { color: #a8a8b3; font-size: 14px; margin: 0 0 28px; }
  input {
    width: 100%; padding: 15px 16px; font-size: 17px; text-align: center;
    letter-spacing: 3px; border-radius: 10px; border: 1px solid #2a2a35;
    background: #16161d; color: #f4f4f6; margin-bottom: 12px;
    /*
     * Masked by the stylesheet rather than by type="password".
     *
     * A password field drags in the system's autofill and passwords machinery,
     * and on a tablet running this from its Home Screen over plain HTTP that
     * machinery can decide the field is not one it will service — leaving the
     * field focused with no keyboard and no way to type. A text field is
     * ordinary enough that nothing intercepts it, and this hides the passcode
     * just the same.
     */
    -webkit-text-security: disc;
    text-security: disc;
  }
  input:focus { outline: none; border-color: ${colour}; }
  input, button { touch-action: manipulation; -webkit-user-select: text; user-select: text; }
  button {
    width: 100%; padding: 15px; font-size: 16px; font-weight: 600; border: none;
    border-radius: 10px; background: ${colour}; color: #fff; cursor: pointer;
  }
  button:disabled { opacity: 0.6; }
  /* Digits in the arrangement every phone uses; letters in a tighter grid. */
  .pad { display: grid; gap: 8px; margin-bottom: 8px; }
  .pad.digits { grid-template-columns: repeat(3, 1fr); }
  .pad.letters { grid-template-columns: repeat(7, 1fr); gap: 6px; }

  .pad button {
    width: auto; margin: 0; cursor: pointer;
    font-weight: 500; font-variant-numeric: tabular-nums;
    color: #f4f4f6; background: #191921; border: 1px solid #2e2e3a;
    border-radius: 12px; transition: background 0.12s ease, transform 0.12s ease;
  }
  .pad.digits button { padding: 16px 0; font-size: 22px; }
  .pad.letters button { padding: 11px 0; font-size: 15px; border-radius: 9px; }
  .pad button:active { background: #2c2c38; transform: scale(0.96); }

  .pad-row { display: flex; gap: 8px; margin-bottom: 16px; }
  .alt {
    flex: 1; width: auto; margin: 0; padding: 12px 0; cursor: pointer;
    font-size: 14px; font-weight: 600; letter-spacing: 0.2px;
    color: #b9b9c6; background: transparent; border: 1px solid #2e2e3a;
    border-radius: 10px; transition: background 0.12s ease, color 0.12s ease;
  }
  .alt:active { background: #24242e; color: #f4f4f6; }
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
  const faces = document.getElementById('faces');
  const heading = document.querySelector('h1');
  const subheading = document.querySelector('.sub');
  let chosen = null;

  /*
   * Show who is here, and let one of them in.
   *
   * The library opens on faces rather than on a passcode box, so the first
   * question is which of you is watching. Answering it decides what is then
   * asked for: a profile with a PIN is asked for that PIN, and one without
   * falls back to the library passcode, because some door has to be locked.
   */
  async function showFaces() {
    if (!faces) return false;
    try {
      const response = await fetch('/api/profiles/public', { cache: 'no-store' });
      if (!response.ok) return false;
      const body = await response.json();
      const people = body.profiles || [];
      if (!people.length) return false;

      faces.textContent = '';
      for (const person of people) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'who';

        if (person.avatarAt) {
          const image = document.createElement('img');
          image.className = 'who-face';
          image.src = '/api/profiles/' + encodeURIComponent(person.id) + '/face?v=' + person.avatarAt;
          image.alt = '';
          button.appendChild(image);
        } else {
          const initial = document.createElement('span');
          initial.className = 'who-face';
          initial.style.background = person.colour || '#e50914';
          initial.textContent = (person.name || '?').trim().charAt(0).toUpperCase();
          button.appendChild(initial);
        }

        if (person.hasPin) {
          const lock = document.createElement('span');
          lock.className = 'who-lock';
          lock.textContent = '🔒';
          button.appendChild(lock);
        }

        const label = document.createElement('span');
        label.className = 'who-name';
        label.textContent = person.name;
        button.appendChild(label);

        button.dataset.profile = person.id;

        button.addEventListener('click', () => askFor(person));
        faces.appendChild(button);
      }

      faces.hidden = false;
      if (subheading) subheading.textContent = 'Who is watching?';
      return true;
    } catch {
      return false;
    }
  }

  function askFor(person) {
    chosen = person;
    // The face stays, so it is obvious whose PIN is being asked for.
    faces.classList.add('asking');
    for (const button of faces.querySelectorAll('.who')) {
      button.classList.toggle('picked', button.dataset.profile === person.id);
    }
    form.hidden = false;
    if (heading) heading.textContent = person.name;
    if (subheading) {
      subheading.textContent = person.hasPin
        ? 'Enter your PIN'
        : 'Enter the library passcode';
    }
    field.value = '';
    field.placeholder = person.hasPin ? 'PIN' : 'Passcode';

    if (!document.getElementById('back-to-faces')) {
      const back = document.createElement('button');
      back.type = 'button';
      back.id = 'back-to-faces';
      back.className = 'back-to-faces';
      back.textContent = 'Someone else';
      back.addEventListener('click', () => {
        chosen = null;
        form.hidden = true;
        faces.classList.remove('asking');
        error.hidden = true;
        if (heading) heading.textContent = ${JSON.stringify(name)};
        if (subheading) subheading.textContent = 'Who is watching?';
      });
      form.appendChild(back);
    }
  }

  const form = document.getElementById('form');
  const field = document.getElementById('passcode');
  const error = document.getElementById('error');

  if (form) {
    /*
     * iOS will not raise the keyboard for a field focused as the page loads,
     * so there is no autofocus here. Tapping anywhere on the card focuses the
     * field, which counts as the user gesture iOS insists on.
     */
    document.querySelector('.card').addEventListener('click', (event) => {
      if (event.target === field || event.target.closest('.pad, .pad-row')) return;
      field.focus();
    });

    /*
     * The keypad. Digits first, since most passcodes are numbers, with the
     * letters a tap away for the ones that are not.
     */
    // 1-9 in rows of three, then 0 under the middle, as on a phone.
    const DIGITS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', ''];
    const LETTERS = 'abcdefghijklmnopqrstuvwxyz'.split('');
    const pad = document.getElementById('pad');
    const mode = document.getElementById('mode');
    let letters = false;

    function drawPad() {
      pad.textContent = '';
      pad.className = 'pad ' + (letters ? 'letters' : 'digits');

      for (const key of (letters ? LETTERS : DIGITS)) {
        // The blanks either side of 0 hold its place in the grid.
        if (!key) { pad.appendChild(document.createElement('span')); continue; }

        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = key;
        // Typing into the field by hand rather than by keyboard, so the value
        // ends up exactly as it would have either way.
        button.addEventListener('click', () => { field.value += key; });
        pad.appendChild(button);
      }
      mode.textContent = letters ? '123' : 'ABC';
    }

    mode.addEventListener('click', () => { letters = !letters; drawPad(); });
    document.getElementById('back').addEventListener('click', () => {
      field.value = field.value.slice(0, -1);
    });
    drawPad();

    /*
     * Shown only when asked for, and remembered once it has been.
     *
     * Somebody reaching for this is on a device whose keyboard will not
     * appear, and that does not change between visits — asking them to find
     * the link again every time would be its own small cruelty.
     */
    const keypad = document.getElementById('keypad');
    const showPad = document.getElementById('show-pad');

    function revealPad() {
      keypad.hidden = false;
      showPad.hidden = true;
      try { localStorage.setItem('library.keypad', '1'); } catch { /* private mode */ }
    }

    showPad.addEventListener('click', revealPad);

    let wanted = false;
    try { wanted = localStorage.getItem('library.keypad') === '1'; } catch { /* private mode */ }
    if (wanted) revealPad();

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      // The Enter button, not the first key on the pad.
      const button = form.querySelector('button[type="submit"]');
      button.disabled = true;
      error.hidden = true;
      try {
        const response = chosen
          ? await fetch('/api/login/profile', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ profileId: chosen.id, secret: field.value }),
            })
          : await fetch('/api/login', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ passcode: field.value }),
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
      // Clear rather than select: a wrong code entered on the pad has no
      // keyboard behind it to type over the top of.
      field.value = '';
    });

    showFaces().then((shown) => {
      if (!shown) {
        form.hidden = false;
        if (subheading) subheading.textContent = 'Enter the passcode to watch';
      }
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
