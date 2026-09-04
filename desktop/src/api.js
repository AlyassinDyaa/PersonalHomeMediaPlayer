/**
 * Thin client over the local API, plus artwork URL helpers.
 *
 * The base URL is supplied by the main process at startup rather than
 * hard-coded, so the port can move without touching the UI.
 */

let apiBase = 'http://127.0.0.1:8787';

export async function initApi() {
  if (typeof window !== 'undefined' && window.media) {
    const info = await window.media.info();
    apiBase = info.apiBase.replace(/\/$/, '');
    return info;
  }
  // Served over HTTP means a browser on some other device, and the library is
  // whatever served this page — not a fixed address on this machine.
  if (typeof window !== 'undefined' && /^https?:$/.test(window.location.protocol)) {
    apiBase = window.location.origin;
  }
  return { apiBase, mpvAvailable: false, platform: 'browser' };
}

/**
 * Which profile this client is speaking for.
 *
 * A browser needs none of this: the server put the profile in the session
 * cookie when it was chosen, and the cookie rides along on its own. The
 * desktop window is the one that cannot, because it is loaded from a file on
 * disk and every call to the server is cross-origin, so no cookie is sent. It
 * remembers the choice here and repeats it in a header instead.
 */
const PROFILE_STORAGE_KEY = 'media.profileId';

let profileId = null;
try {
  profileId = window?.localStorage?.getItem(PROFILE_STORAGE_KEY) ?? null;
} catch {
  // Private windows and locked-down browsers throw rather than return null.
  profileId = null;
}

export function currentProfileId() {
  return profileId;
}

export function rememberProfile(id) {
  profileId = id ?? null;
  try {
    if (id) window.localStorage.setItem(PROFILE_STORAGE_KEY, id);
    else window.localStorage.removeItem(PROFILE_STORAGE_KEY);
  } catch {
    // Remembering is a convenience; the session still works without it.
  }
}

/**
 * The profile as a query parameter, for addresses a tag loads rather than
 * fetch does.
 *
 * An `<img>` or a `<video>` cannot be given a header, so the desktop window
 * has no other way to say who is watching when the browser plays the file
 * itself. The server only honours this from the machine it runs on, where the
 * files could have been opened directly anyway.
 */
export function profileParam(prefix = '?') {
  return profileId ? prefix + 'profile=' + encodeURIComponent(profileId) : '';
}

async function request(pathname, options = {}) {
  const headers = { ...(options.headers ?? {}) };
  if (profileId) headers['X-Profile-Id'] = profileId;

  const response = await fetch(apiBase + pathname, { ...options, headers });

  // A lapsed session in a browser means the passcode is wanted again. Every
  // call would otherwise fail with an error the page can do nothing about.
  if (response.status === 401 && typeof window !== 'undefined' && !window.media) {
    window.location.href = '/login';
    throw new Error('Not signed in');
  }

  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    throw new Error(detail.error || response.status + ' ' + response.statusText);
  }
  return response.json();
}

/** The image for one page of a comic. */
export function comicPage(issueId, index) {
  return apiBase + '/api/comics/issue/' + encodeURIComponent(issueId) + '/page/' + index;
}

/** The cover of a comic, at shelf size. */
export function comicCover(issueId) {
  return apiBase + '/api/comics/issue/' + encodeURIComponent(issueId) + '/cover';
}

/** Absolute base URL, needed for EventSource which cannot use a relative path. */
export function apiBaseUrl() {
  return apiBase;
}

export const api = {
  stats: () => request('/api/stats'),
  settings: () => request('/api/settings'),
  saveSettings: (patch) => request('/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  }),
  browse: (dir) => request('/api/browse' + (dir ? '?path=' + encodeURIComponent(dir) : '')),
  browsePreview: (dir) => request('/api/browse/preview?path=' + encodeURIComponent(dir)),
  items: (params = {}) => {
    const query = new URLSearchParams(
      Object.entries(params).filter(([, value]) => value != null),
    ).toString();
    return request('/api/items' + (query ? '?' + query : ''));
  },
  item: (id) => request('/api/items/' + id),
  video: (id) => request('/api/videos/' + id),
  continueWatching: () => request('/api/continue'),
  removeFromContinue: (itemId) =>
    request('/api/continue/' + encodeURIComponent(itemId), { method: 'DELETE' }),
  suggestions: () => request('/api/suggestions'),
  /** Shows that have been joined into one. */
  merges: () => request('/api/merges'),
  /** Undo one of those; the server rescans so they separate again. */
  unmerge: (alias) =>
    request('/api/merges/' + encodeURIComponent(alias), { method: 'DELETE' }),
  resolveSuggestion: (id, action) =>
    request('/api/suggestions/' + encodeURIComponent(id) + '/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action }),
    }),

  /** Badges a collection can wear, from the metadata provider's companies. */
  searchLogos: (q) => request('/api/logos/search?q=' + encodeURIComponent(q)),

  // --- collections --------------------------------------------------------
  collections: () => request('/api/collections'),
  /** The rails with their titles, for the home screen. */
  collectionShelves: () => request('/api/collections/shelves'),
  collectionItems: (id) => request('/api/collections/' + encodeURIComponent(id)),
  createCollection: (body) => request('/api/collections', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }),
  updateCollection: (id, body) => request('/api/collections/' + encodeURIComponent(id), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }),
  deleteCollection: (id) =>
    request('/api/collections/' + encodeURIComponent(id), { method: 'DELETE' }),
  addToCollection: (id, itemId) =>
    request('/api/collections/' + encodeURIComponent(id) + '/items', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemId }),
    }),
  removeFromCollection: (id, itemId) => request(
    '/api/collections/' + encodeURIComponent(id) + '/items/' + encodeURIComponent(itemId),
    { method: 'DELETE' },
  ),

  // --- who is watching ----------------------------------------------------
  /** Everyone in the household, and who this client is currently being. */
  profiles: () => request('/api/profiles'),
  /** Become one of them. A profile with no PIN takes an empty one. */
  switchProfile: (id, pin = '') => request('/api/profiles/switch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ profileId: id, pin }),
  }),
  createProfile: (body) => request('/api/profiles', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }),
  updateProfile: (id, body) => request('/api/profiles/' + encodeURIComponent(id), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }),
  deleteProfile: (id) =>
    request('/api/profiles/' + encodeURIComponent(id), { method: 'DELETE' }),

  favourites: () => request('/api/favourites'),
  setFavourite: (itemId, favourite) =>
    request('/api/items/' + encodeURIComponent(itemId) + '/favourite', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ favourite }),
    }),

  /** Candidates for a title the automatic match got wrong. */
  searchTmdb: (kind, query) =>
    request('/api/tmdb/search?kind=' + kind + '&q=' + encodeURIComponent(query)),
  /** Pin a title to a TMDB id. Takes effect on the next scan. */
  matchItem: (itemId, tmdbId) =>
    request('/api/items/' + encodeURIComponent(itemId) + '/match', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tmdbId }),
    }),

  /** Where playback got to, shared by every device watching this library. */
  saveProgress: (body) => request('/api/progress', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }),

  /** What this file would take to play in a browser, before trying to. */
  streamInfo: (videoId) => request('/api/stream/' + videoId + '/info'),

  /** Begin a stream at a point in the file, and get back its playlist. */
  streamStart: (videoId, startSeconds, audioTrack = 0) => request(
    '/api/stream/' + videoId + '/start?start=' + Math.max(0, Math.floor(startSeconds || 0))
    + '&audio=' + audioTrack,
  ),
  // --- comics -------------------------------------------------------------
  comics: () => request('/api/comics'),
  comicSeries: (id) => request('/api/comics/series/' + encodeURIComponent(id)),
  comicIssue: (id) => request('/api/comics/issue/' + encodeURIComponent(id)),
  /** Ask for a comic to be made ready; comes back with the page count. */
  openComic: (id) => request(
    '/api/comics/issue/' + encodeURIComponent(id) + '/open', { method: 'POST' },
  ),
  saveComicProgress: (body) => request('/api/comics/progress', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }),
  scanComics: () => request('/api/comics/scan', { method: 'POST' }),

  genres: () => request('/api/genres'),
  search: (query) => request('/api/search?q=' + encodeURIComponent(query)),
  suggestions: () => request('/api/suggestions'),
  setWatched: (videoId, watched) =>
    request('/api/videos/' + videoId + '/watched', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ watched }),
    }),
};

/**
 * Artwork goes through the local server, which caches it on disk. That keeps
 * the browse grid fast after first load and working with no connection.
 */
export function artwork(tmdbPath, size = 'w500') {
  if (!tmdbPath) return null;
  return apiBase + '/artwork/' + size + tmdbPath;
}

export function formatRuntime(minutes) {
  if (!minutes) return null;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours ? hours + 'h ' + rest + 'm' : rest + 'm';
}

export function formatDuration(seconds) {
  if (!seconds && seconds !== 0) return null;
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return hours ? hours + ':' + pad(minutes) + ':' + pad(secs) : minutes + ':' + pad(secs);
}

export function formatSize(bytes) {
  if (!bytes) return null;
  const gb = bytes / 1024 ** 3;
  return gb >= 1 ? gb.toFixed(1) + ' GB' : (bytes / 1024 ** 2).toFixed(0) + ' MB';
}

/**
 * "Season 2 · Episode 4", or a range when one file holds two episodes.
 * Returns null for movies.
 */
export function episodeLabel(video) {
  if (!video || video.episode == null) return null;
  const number = video.episodeEnd && video.episodeEnd !== video.episode
    ? video.episode + '–' + video.episodeEnd
    : String(video.episode);
  const season = video.season == null ? null : 'Season ' + video.season;
  const episode = 'Episode ' + number;
  return season ? season + ' · ' + episode : episode;
}

/**
 * A clean, human-readable name for something being played, built from the show
 * and numbering rather than from the filename.
 *
 * "Green Lantern: The Animated Series · Season 2 · Episode 4 · Beware My Power"
 */
export function displayTitle(item, video) {
  const parts = [item?.title].filter(Boolean);
  const label = episodeLabel(video);
  if (label) parts.push(label);
  if (video?.title) parts.push(video.title);
  return parts.join(' · ');
}

/** Title for a single episode row: its name, or a numbered fallback. */
export function episodeHeading(video) {
  if (video?.title) return video.title;
  return 'Episode ' + (video?.episode ?? '');
}
