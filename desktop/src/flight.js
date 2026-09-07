/**
 * The poster you touched, carried to the page you land on.
 *
 * Opening a title used to swap one screen for another, which gives no sense of
 * having gone anywhere — the thing you pressed simply vanishes and something
 * else is there. Carrying the artwork across says where the new page came
 * from, and it is the difference between a page appearing and a page opening.
 *
 * Done by hand rather than with the browser's own view transitions. Those
 * snapshot the whole document, and on a television stick or a tired phone that
 * snapshot can miss its deadline and abandon itself half way, leaving the
 * screen wrecked. The worst this can do is not animate.
 */

/** How long the picture is in the air. */
const DURATION = 420;

/** How much of the screen a title's banner takes, wide and narrow. */
const BANNER_SHARE = { wide: 0.62, narrow: 0.5 };

/**
 * Where the banner is going to be.
 *
 * Not measured, predicted — and deliberately so. The page being opened does
 * not exist yet: it asks the server for the title first and shows an empty
 * shape meanwhile, so waiting for the real banner to appear meant waiting the
 * better part of a second with the poster still sitting in its rail. By then
 * the movement has stopped meaning anything.
 *
 * The banner always fills the width and starts at the top, and the poster
 * fades out before it lands, so being a few pixels out at the finish costs
 * nothing — while starting immediately is the whole point.
 */
function bannerToCome() {
  const narrow = window.innerWidth <= 760;
  return {
    left: 0,
    top: 0,
    width: window.innerWidth,
    height: Math.round(window.innerHeight * (narrow ? BANNER_SHARE.narrow : BANNER_SHARE.wide)),
  };
}

/**
 * Fly one picture into the page now opening.
 *
 * Handed the element that was pressed rather than looking one up afterwards:
 * by the time the new page exists the rail may have been replaced, and a
 * measurement of something that is no longer there is worse than none.
 *
 * Everything about it is optional — nothing pressed, nothing drawn to land in,
 * or somebody who has asked for less movement — and the page simply appears as
 * it did before.
 *
 * @param {HTMLImageElement|null|undefined} image the artwork that was pressed
 */
export function flyFrom(image) {
  if (!image) return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  const from = image.getBoundingClientRect();
  const picture = image.currentSrc || image.src;
  const radius = getComputedStyle(image.parentElement ?? image).borderRadius || '6px';
  if (!from.width || !from.height || !picture) return;

  const to = bannerToCome();
  if (!to.width || !to.height) return;

  const ghost = document.createElement('img');
  ghost.className = 'poster-in-flight';
  ghost.src = picture;
  ghost.style.left = from.left + 'px';
  ghost.style.top = from.top + 'px';
  ghost.style.width = from.width + 'px';
  ghost.style.height = from.height + 'px';
  ghost.style.borderRadius = radius;
  document.body.appendChild(ghost);

  const flight = ghost.animate([
    {
      left: from.left + 'px',
      top: from.top + 'px',
      width: from.width + 'px',
      height: from.height + 'px',
      borderRadius: radius,
      opacity: 1,
    },
    {
      left: to.left + 'px',
      top: to.top + 'px',
      width: to.width + 'px',
      height: to.height + 'px',
      borderRadius: '0px',
      /*
       * Gone by the end.
       *
       * A poster and a banner are different pictures of the same thing, so the
       * arrival can never be a perfect match however carefully it is measured.
       * Fading out means what you are left looking at is the real page rather
       * than a stretched poster pretending to be one.
       */
      opacity: 0,
    },
  ], { duration: DURATION, easing: 'cubic-bezier(0.2, 0.8, 0.25, 1)', fill: 'forwards' });

  /*
   * It lands on whichever comes first, the animation or the clock.
   *
   * A page that is not being drawn — a backgrounded tab, a stick with nothing
   * to spare — never finishes its animations, and the copy would then hang
   * over the screen for ever. Removing it twice is harmless.
   */
  const land = () => ghost.remove();
  flight.finished.then(land, land);
  setTimeout(land, DURATION + 300);
}

export default flyFrom;
