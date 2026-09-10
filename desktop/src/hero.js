/**
 * What the banner offers, and why it is different every time.
 *
 * Shuffling alone was not enough. The field it shuffled was the sixty
 * best-rated titles, chosen so the top of the home screen never opened on
 * something embarrassing — but a library of two hundred and fifty then had a
 * hundred and ninety titles that could never appear at all, and ten drawn
 * from the same sixty look much the same from one evening to the next.
 *
 * Two changes. The field is a share of the library rather than a fixed sixty,
 * so a big collection offers more of itself. And what was shown last time is
 * remembered and put last, so opening the app twice does not open on the same
 * artwork twice — which is the whole of what a banner is for.
 */

/** Titles kept in mind as "just seen"; a few openings' worth. */
const KEY = 'library.heroSeen';
const REMEMBER = 40;

function lastTime() {
  try {
    const kept = JSON.parse(localStorage.getItem(KEY));
    return new Set(Array.isArray(kept) ? kept : []);
  } catch {
    return new Set();   // private mode, or nothing stored yet
  }
}

/** Note what the banner is about to show, so the next opening avoids it. */
export function rememberHeroes(ids) {
  if (!ids?.length) return;
  try {
    const kept = JSON.parse(localStorage.getItem(KEY));
    const before = Array.isArray(kept) ? kept : [];
    const next = [...ids, ...before.filter((id) => !ids.includes(id))].slice(0, REMEMBER);
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Nothing to remember with. The shuffle below still varies the order.
  }
}

/* Fisher-Yates: every order equally likely, which sorting by a random key is
   not — and it is three lines rather than a dependency. */
function shuffle(list) {
  for (let i = list.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

/**
 * The titles the banner rotates through.
 *
 * @param {object[]} items every title in the library
 * @param {number} count how many the banner wants
 */
export function pickHeroes(items, count = 10) {
  const withArt = items.filter((item) => item.backdrop && item.overview);
  /* A title logo makes the banner look like a poster rather than a screenshot
     with words on it, so those are preferred — but only while there are
     enough of them to fill the thing. */
  const withLogo = withArt.filter((item) => item.logo);
  const pool = withLogo.length >= count ? withLogo : withArt;
  if (pool.length === 0) return [];

  /*
   * The better-rated three fifths, never fewer than sixty.
   *
   * A share rather than a fixed number: sixty was most of a small library and
   * a quarter of this one, so the same fixed cut meant "nearly everything" in
   * one house and "the same few" in another.
   */
  const field = [...pool]
    .sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0))
    .slice(0, Math.max(60, Math.ceil(pool.length * 0.6)));

  shuffle(field);

  /* Anything shown recently goes to the back, so it is only reached once the
     rest has been. */
  const before = lastTime();
  const fresh = field.filter((item) => !before.has(item.id));
  const again = field.filter((item) => before.has(item.id));

  return [...fresh, ...again].slice(0, count);
}
