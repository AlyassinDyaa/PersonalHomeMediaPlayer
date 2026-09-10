/**
 * What sits behind the library.
 *
 * Flat black is honest, and on a browse screen — three rows of covers with a
 * lot of space around them — it is completely inert. The room reads as empty
 * rather than dark.
 *
 * Every design here is drawn from a single colour, and that colour is either
 * the one taken out of whatever artwork is on screen or one the owner picked.
 * Following the artwork is the default because it costs nothing to maintain
 * and the background then changes as you move through the library; a fixed
 * colour is for a household that wants the room to look the same every time.
 *
 * All of them are slow and dim enough that nothing appears to move unless you
 * look for it. A background that draws the eye has stopped being a background.
 */

/** The designs, in the order they are offered, with what each is for. */
export const BACKGROUNDS = [
  ['flat', 'Flat', 'Plain dark, and nothing else'],
  ['glow', 'Glow', 'A soft wash behind the top of the page'],
  ['aurora', 'Aurora', 'Slow drifting colour, like light through a curtain'],
  ['mesh', 'Mesh', 'Several colours bleeding into one another'],
  ['rays', 'Rays', 'Light falling at an angle, as through a window'],
  ['halo', 'Halo', 'A wide ring of light behind everything'],
  ['grid', 'Grid', 'A faint ruled grid, receding'],
  ['waves', 'Waves', 'Soft bands, like light on water'],
  ['vignette', 'Vignette', 'Darker at the edges, so the middle lifts'],
  ['posters', 'Poster wall', 'The artwork itself, very dim'],
];

const KNOWN = new Set(BACKGROUNDS.map(([id]) => id));

/** The class the page wears, or none for the plain one. */
export function backgroundClass(id) {
  return KNOWN.has(id) && id !== 'flat' ? 'bg-' + id : '';
}

/**
 * Colours offered for the backdrop, beyond following the artwork.
 *
 * Deliberately muted. These are laid under a screen of posters at low opacity,
 * and a saturated colour there does not read as a tint — it reads as a fault.
 */
export const BACKDROP_COLOURS = [
  ['', 'Follow the artwork'],
  ['#7d8aa0', 'Slate'],
  ['#19c2a8', 'Teal'],
  ['#3b6ea5', 'Blue'],
  ['#6b4fa0', 'Violet'],
  ['#a8536b', 'Rose'],
  ['#b07a3c', 'Amber'],
  ['#4a7a4e', 'Moss'],
];

/**
 * Dress the page.
 *
 * Applied to the body rather than to a component so it survives every screen
 * change, and so the player — which covers everything — is unaffected by it.
 *
 * @param {string} id        one of BACKGROUNDS
 * @param {object} [options]
 * @param {string[]} [options.posters] artwork addresses, used only by the wall
 * @param {string}   [options.colour]  a fixed tint, or empty to follow the art
 * @param {number}   [options.strength] how strongly it is drawn, 10–100
 */
export function applyBackground(id, { posters = [], colour = '', strength = 100 } = {}) {
  if (typeof document === 'undefined') return;

  const body = document.body;
  /* A fraction of the design's own intensity; the sheet uses it as an opacity. */
  const amount = Math.min(100, Math.max(10, Number(strength) || 100)) / 100;
  body.style.setProperty('--bg-strength', String(amount));
  for (const [name] of BACKGROUNDS) body.classList.remove('bg-' + name);

  const chosen = backgroundClass(id);
  if (chosen) body.classList.add(chosen);

  /*
   * The tint every design reads from.
   *
   * Left unset when following the artwork, so the stylesheet falls through to
   * --accent — which each page already sets from the poster in front of you.
   * Setting it to the accent's current value instead would freeze it at
   * whatever happened to be on screen when this ran.
   */
  if (colour) body.style.setProperty('--bg-tint', colour);
  else body.style.removeProperty('--bg-tint');

  /*
   * The poster wall needs actual pictures, and only that one does.
   *
   * Set as custom properties rather than as elements so the whole thing stays
   * one CSS layer with nothing in the document to lay out, and so switching
   * away from it costs nothing to clean up.
   */
  if (id === 'posters') {
    const few = posters.filter(Boolean).slice(0, 3);
    body.style.setProperty('--wall-1', few[0] ? 'url("' + few[0] + '")' : 'none');
    body.style.setProperty('--wall-2', few[1] ? 'url("' + few[1] + '")' : 'none');
    body.style.setProperty('--wall-3', few[2] ? 'url("' + few[2] + '")' : 'none');
  } else {
    body.style.removeProperty('--wall-1');
    body.style.removeProperty('--wall-2');
    body.style.removeProperty('--wall-3');
  }
}
