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
  return { apiBase, mpvAvailable: false, platform: 'browser' };
}

async function request(pathname, options) {
  const response = await fetch(apiBase + pathname, options);
  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    throw new Error(detail.error || response.status + ' ' + response.statusText);
  }
  return response.json();
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
