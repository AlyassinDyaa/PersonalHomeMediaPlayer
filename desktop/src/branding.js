/**
 * How the library is named in the header.
 *
 * Kept in one place so the settings preview and the header can never disagree
 * about what a given name will look like.
 */

/** "Dyaa" -> "DYAA'S LIBRARY"; blank -> "MY LIBRARY". */
export function headerPreview(name) {
  const trimmed = String(name ?? '').trim();
  if (!trimmed) return 'My Library';
  // Avoid "Chris's" turning into "Chris''s" when the name already ends in s.
  const suffix = /s$/i.test(trimmed) ? '’' : '’s';
  return trimmed + suffix + ' Library';
}
