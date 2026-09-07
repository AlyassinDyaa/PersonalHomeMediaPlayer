/**
 * Whether this is being watched from across a room.
 *
 * A television is not a large phone. It is further away, it has no pointer,
 * and everything on it has to be readable from a sofa and reachable with five
 * buttons. That is a different layout, not a wider one, so the library has to
 * know which it is drawing.
 *
 * Worked out from the device rather than asked as a setting, because the
 * setting would belong to the library and the answer belongs to the screen —
 * a phone and a television share one library and need opposite answers. The
 * address can still override it, which is the escape hatch for a device that
 * guesses wrong and for trying the layout on an ordinary browser.
 */

const REMEMBERED = 'library.television';

/**
 * Devices that are televisions.
 *
 * Fire TV sticks identify themselves by model code — every one of them begins
 * AFT — and the rest name themselves plainly enough. Nothing here can match a
 * phone or a laptop, which matters more than catching every television: a
 * phone wrongly given the ten-foot layout is unusable, while a television
 * given the ordinary one merely looks small.
 */
const TELEVISIONS = /\bAFT[A-Z0-9]*\b|smart-?tv|googletv|android tv|appletv|crkey|tizen|web0s|webos|bravia|hbbtv|netcast|viera/i;

/** Was it asked for, or ruled out, in the address? */
function fromAddress() {
  try {
    const asked = new URLSearchParams(window.location.search).get('tv');
    if (asked === null) return null;
    return asked !== '0' && asked !== 'false';
  } catch {
    return null;
  }
}

function remembered() {
  try {
    const stored = localStorage.getItem(REMEMBERED);
    return stored === null ? null : stored === '1';
  } catch {
    return null;   // Private browsing; the device will be worked out instead.
  }
}

function remember(television) {
  try {
    localStorage.setItem(REMEMBERED, television ? '1' : '0');
  } catch {
    // Not remembering only means working it out again next time.
  }
}

/**
 * Whether to draw the library for a television.
 *
 * An answer in the address wins and is remembered, so `?tv=1` on a browser
 * stays on for the session that follows and `?tv=0` gets a stick back to the
 * ordinary layout without anybody having to find a settings screen with a
 * remote.
 */
export function isTelevision() {
  const asked = fromAddress();
  if (asked !== null) { remember(asked); return asked; }

  const stored = remembered();
  if (stored !== null) return stored;

  return TELEVISIONS.test(navigator.userAgent ?? '');
}

/** Put the answer on the page, where the stylesheet can act on it. */
export function applyTelevision() {
  const television = isTelevision();
  document.body.classList.toggle('tv-layout', television);
  /*
   * On a television the highlight is on from the first frame.
   *
   * Elsewhere it waits for an arrow press, because a ring following the mouse
   * around a desktop is noise. A television has no mouse to follow: waiting
   * means the first screen has nothing marked on it, and somebody pressing
   * right to see what happens gets no answer until the second press.
   */
  if (television) document.body.classList.add('by-remote');
  return television;
}

/**
 * Take the whole screen on a television, at the first press.
 *
 * A television stick has no way to install this as an app, so it is watched
 * inside a browser — and the browser keeps a strip of address bar and buttons
 * across the top of the picture, which on a television is the difference
 * between a library and a web page somebody left open. Full screen is the
 * whole of that difference and it costs one call.
 *
 * It has to wait for a press because no browser will go full screen without
 * one; the first press of the remote is the one, and it is not swallowed —
 * whatever it was going to do, it still does. Asked for once and never again,
 * so somebody who presses Back to get the address bar returned keeps it.
 */
export function fullScreenOnTelevision() {
  if (typeof document === 'undefined') return;
  if (!document.body.classList.contains('tv-layout')) return;

  let asked = false;
  const go = () => {
    if (asked) return;
    asked = true;
    window.removeEventListener('keydown', go);
    window.removeEventListener('pointerdown', go);
    document.documentElement.requestFullscreen?.({ navigationUI: 'hide' })
      .catch(() => { /* refused, or already there; the library works either way */ });
  };

  window.addEventListener('keydown', go);
  window.addEventListener('pointerdown', go);
}

export default applyTelevision;
