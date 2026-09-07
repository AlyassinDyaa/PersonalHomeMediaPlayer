import { createPortal } from 'react-dom';

/**
 * Anything that covers the screen, drawn outside the page that opened it.
 *
 * A sheet or a dialogue is `position: fixed`, which is meant to mean "against
 * the window" — but any ancestor carrying a transform, a filter or a
 * containment hint quietly becomes the thing it is fixed against instead. The
 * pages here animate in with a small translate, so a dialogue opened while that
 * animation was running measured itself against a box that was not the window
 * and hung off the bottom of the screen.
 *
 * Rendering into the body sidesteps the whole question. It is not a workaround
 * for one animation: it is the guarantee that no future one can do this again,
 * and it costs a single call.
 */
export function Overlay({ children }) {
  if (typeof document === 'undefined') return null;
  return createPortal(children, document.body);
}

export default Overlay;
