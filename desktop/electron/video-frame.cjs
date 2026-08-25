/**
 * Where the video window sits, and how the user moves it.
 *
 * mpv renders into its own borderless top-level window rather than into one of
 * ours: a transparent window layered over mpv's Direct3D surface stops that
 * surface being composited, so with the controls visible the picture went black
 * while mpv carried on decoding. Embedding mpv inside an Electron window was
 * measured doing the same thing — mpv decodes, Chromium's compositor owns the
 * surface, and nothing is drawn.
 *
 * Two separate top-level windows composite normally, but a borderless window
 * has no title bar to grab, which is why the video could not be dragged to
 * another screen while the controls could. This module supplies the missing
 * half: the controls act as the title bar, and the rectangle they report is
 * applied to both windows together so they can never separate.
 *
 * Windows Media Player is the model. Dragging a maximised window restores it
 * under the pointer, dropping it on another monitor leaves it there, and
 * double-clicking toggles fullscreen.
 */

/**
 * How far the pointer must travel before a press becomes a drag.
 *
 * Without this, clicking the control bar — to focus the window, or on the way
 * to a button — restored a fullscreen video to a small window, because the
 * press alone was enough to start the gesture.
 */
const DRAG_THRESHOLD = 5;

/** How much of a display a restored window covers. */
const WINDOW_FRACTION = 0.68;
/** Never leave less than this on screen to grab hold of. */
const MIN_WIDTH = 480;
const MIN_HEIGHT = 270;

/**
 * A centred window on `display`, sized to the video's aspect where known.
 * @param {{bounds: {x: number, y: number, width: number, height: number}, workArea?: object}} display
 * @param {number} [aspect] width / height of the video
 */
function windowedBounds(display, aspect) {
  const area = display.workArea ?? display.bounds;
  let width = Math.round(area.width * WINDOW_FRACTION);
  let height = aspect && aspect > 0
    ? Math.round(width / aspect)
    : Math.round(area.height * WINDOW_FRACTION);

  // Keep it inside the work area even for very wide films.
  if (height > area.height * 0.9) {
    height = Math.round(area.height * 0.9);
    if (aspect && aspect > 0) width = Math.round(height * aspect);
  }
  width = Math.max(MIN_WIDTH, Math.min(width, area.width));
  height = Math.max(MIN_HEIGHT, Math.min(height, area.height));

  return {
    x: Math.round(area.x + (area.width - width) / 2),
    y: Math.round(area.y + (area.height - height) / 2),
    width,
    height,
  };
}

/** The whole of a display, which is what fullscreen means here. */
function fullscreenBounds(display) {
  const { x, y, width, height } = display.bounds;
  return { x, y, width, height };
}

/**
 * Where a window being dragged should land.
 *
 * Dragging a fullscreen window restores it first, the way Windows does, and
 * places it under the pointer proportionally so it does not jump away from the
 * hand that grabbed it.
 *
 * @param {object} drag state from beginDrag
 * @param {{x: number, y: number}} point current cursor position, in screen coordinates
 */
function dragBounds(drag, point) {
  const dx = point.x - drag.origin.x;
  const dy = point.y - drag.origin.y;

  if (!drag.restoreTo) {
    return { ...drag.startBounds, x: drag.startBounds.x + dx, y: drag.startBounds.y + dy };
  }

  // Restoring mid-drag: keep the grab point at the same relative position
  // across the newly smaller window.
  const grabFraction = drag.startBounds.width > 0
    ? (drag.origin.x - drag.startBounds.x) / drag.startBounds.width
    : 0.5;
  const restored = drag.restoreTo;
  return {
    ...restored,
    x: Math.round(point.x - restored.width * grabFraction),
    y: Math.round(point.y - (drag.origin.y - drag.startBounds.y)),
  };
}

/**
 * Where a window being resized from its bottom-right corner should land.
 * The aspect ratio is held so the picture never gains letterbox bars that the
 * file does not have.
 */
function resizeBounds(resize, point, aspect) {
  const dx = point.x - resize.origin.x;
  let width = Math.max(MIN_WIDTH, Math.round(resize.startBounds.width + dx));
  let height = aspect && aspect > 0
    ? Math.round(width / aspect)
    : Math.max(MIN_HEIGHT, Math.round(resize.startBounds.height + (point.y - resize.origin.y)));

  if (height < MIN_HEIGHT) {
    height = MIN_HEIGHT;
    if (aspect && aspect > 0) width = Math.round(height * aspect);
  }
  return { ...resize.startBounds, width, height };
}

/**
 * Nudge a window fully onto the display it mostly covers, so it can never be
 * dropped somewhere it cannot be grabbed again.
 */
function clampToDisplay(bounds, display) {
  const area = display.workArea ?? display.bounds;
  const width = Math.min(bounds.width, area.width);
  const height = Math.min(bounds.height, area.height);
  return {
    width,
    height,
    x: Math.round(Math.min(Math.max(bounds.x, area.x - width / 3), area.x + area.width - width / 3)),
    y: Math.round(Math.min(Math.max(bounds.y, area.y), area.y + area.height - height / 3)),
  };
}

/** Whether a press has travelled far enough to be a drag rather than a click. */
function pastThreshold(origin, point) {
  return Math.abs(point.x - origin.x) >= DRAG_THRESHOLD
    || Math.abs(point.y - origin.y) >= DRAG_THRESHOLD;
}

module.exports = {
  DRAG_THRESHOLD,
  pastThreshold,
  WINDOW_FRACTION,
  MIN_WIDTH,
  MIN_HEIGHT,
  windowedBounds,
  fullscreenBounds,
  dragBounds,
  resizeBounds,
  clampToDisplay,
};
