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

/** The colour the header name is written in when the user has not chosen one. */
export const DEFAULT_BRAND_COLOR = '#e50914';

/**
 * Colours offered as one-click choices.
 *
 * A small set of strong colours that hold up as bold text on a near-black
 * background; anything else is available through the custom picker.
 */
export const BRAND_COLORS = [
  { name: 'Classic red', value: '#e50914' },
  { name: 'Amber', value: '#f5a524' },
  { name: 'Lime', value: '#8ed11f' },
  { name: 'Teal', value: '#19c2a8' },
  { name: 'Sky', value: '#3ea6ff' },
  { name: 'Violet', value: '#9b6bff' },
  { name: 'Pink', value: '#ff5c9d' },
  { name: 'White', value: '#f4f4f6' },
];

/** A stored colour, or the default when none is set or the value is not usable. */
export function brandColor(value) {
  return /^#[0-9a-fA-F]{6}$/.test(String(value ?? '').trim())
    ? String(value).trim().toLowerCase()
    : DEFAULT_BRAND_COLOR;
}
