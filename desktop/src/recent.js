/**
 * What counts as newly arrived, judged against the rest of the library.
 *
 * The obvious rule — anything added in the last fortnight — is wrong here, and
 * wrong in a way that only shows up on a real library. The date a title
 * carries is the date it was last scanned, not the date it arrived: moving the
 * films to another drive, or any rescan that rebuilds the rows, stamps every
 * one of them with the same moment. A fortnight rule then marks the entire
 * library at once, which tells you nothing and makes the mark worthless
 * everywhere else too.
 *
 * So the question is asked the other way round. Not "is this recent" but "is
 * this recent *compared with the rest*" — and if the answer is yes for most of
 * the library, then nothing is marked at all, because a library where
 * everything is new is simply a library that was just scanned.
 */

/** Nothing older than this is worth pointing out, however quiet the library. */
const OUTSIDE_MS = 21 * 24 * 60 * 60 * 1000;

/**
 * The most of the library that may be marked at once.
 *
 * A tenth is about a shelf's worth: enough to notice, few enough that the mark
 * still means something. Past that the library was rebuilt rather than added
 * to, and the honest answer is to say nothing.
 */
const MOST = 0.1;

/** Below this a library is too small for proportions to mean anything. */
const ENOUGH = 12;

let arrivedAfter = null;

/**
 * Work out the cut-off from the library as it stands.
 *
 * Called whenever the library is loaded or reloaded, so adding three films next
 * week marks those three — and only those three.
 *
 * @param {Array<{ addedAt?: number }>} items
 */
export function rememberArrivals(items) {
  arrivedAfter = null;
  if (!Array.isArray(items) || items.length < ENOUGH) return;

  const dates = items
    .map((item) => item.addedAt)
    .filter((at) => typeof at === 'number' && at > 0);
  if (!dates.length) return;

  /*
   * Counted by arrival, not by title.
   *
   * Everything that came in together shares one date, so the question is how
   * many titles each *moment* brought — a scan brings the whole library in
   * one moment, an evening's downloading brings three. Taking the newest
   * moments in turn and stopping before they add up to too much of the
   * library is what separates the two.
   */
  const byMoment = new Map();
  for (const at of dates) byMoment.set(at, (byMoment.get(at) ?? 0) + 1);
  const moments = [...byMoment.keys()].sort((a, b) => b - a);

  const allowed = Math.max(1, Math.floor(dates.length * MOST));
  let counted = 0;
  let cutoff = null;
  for (const moment of moments) {
    const arriving = byMoment.get(moment);
    if (counted + arriving > allowed) break;
    counted += arriving;
    cutoff = moment;
  }

  // Nothing qualified: the library was rebuilt rather than added to.
  if (cutoff === null) return;

  arrivedAfter = Math.max(cutoff, Date.now() - OUTSIDE_MS);
}

/** Whether this title is one of the handful that arrived most recently. */
export function isRecent(item) {
  return Boolean(arrivedAfter && item?.addedAt && item.addedAt >= arrivedAfter);
}

export default isRecent;
