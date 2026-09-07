/**
 * The library as a television expects to be handed it.
 *
 * A set that plays from a network asks one question over and over — "what is
 * inside this folder" — and expects a list of folders and files back in a
 * fixed XML shape. This turns the library into that shape.
 *
 * The arrangement is the one already in the library rather than the folders on
 * disk: the collections first, because those are how this household actually
 * thinks about its films, then everything not on a shelf. A television cannot
 * show posters or Continue Watching, but it can show the shelves, and that is
 * most of what the arrangement was for.
 */

import path from 'node:path';
import * as library from '../library.js';
import * as collections from '../collections.js';

/** Containers a television can ask for by name. */
export const ROOT = '0';

/** XML text is not HTML: five characters, and no library needed for them. */
function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * What to call a file so the television knows what it is holding.
 *
 * Roku plays all of these; the type only has to be honest enough for the set
 * to pick a decoder. Anything unrecognised is offered as MP4, which is the
 * one every set can open — a wrong guess there fails no worse than refusing.
 */
const MIME_BY_EXTENSION = new Map(Object.entries({
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.mov': 'video/quicktime',
  '.wmv': 'video/x-ms-wmv',
  '.mpg': 'video/mpeg',
  '.mpeg': 'video/mpeg',
  '.ts': 'video/mp2t',
  '.webm': 'video/webm',
}));

function mimeFor(filePath) {
  return MIME_BY_EXTENSION.get(path.extname(filePath ?? '').toLowerCase()) ?? 'video/mp4';
}

/** A folder, as the television's list wants it. */
function container(id, parentId, title, childCount) {
  return '<container id="' + escapeXml(id) + '" parentID="' + escapeXml(parentId) + '"'
    + ' restricted="1" childCount="' + childCount + '">'
    + '<dc:title>' + escapeXml(title) + '</dc:title>'
    + '<upnp:class>object.container.storageFolder</upnp:class>'
    + '</container>';
}

/** One playable thing, with the address to fetch it from. */
function videoItem({ id, parentId, title, url, mime, size, duration }) {
  /*
   * The fourth field of protocolInfo carries the flags a set reads to decide
   * whether it may seek. Without DLNA_ORG_OP=01 some players will only ever
   * play from the beginning, which on a two hour film is the difference
   * between a library and a tape.
   */
  const protocol = 'http-get:*:' + mime + ':DLNA.ORG_OP=01;DLNA.ORG_CI=0;'
    + 'DLNA.ORG_FLAGS=01700000000000000000000000000000';

  const attributes = [
    'protocolInfo="' + protocol + '"',
    size ? 'size="' + size + '"' : '',
    duration ? 'duration="' + secondsAsClock(duration) + '"' : '',
  ].filter(Boolean).join(' ');

  return '<item id="' + escapeXml(id) + '" parentID="' + escapeXml(parentId) + '" restricted="1">'
    + '<dc:title>' + escapeXml(title) + '</dc:title>'
    + '<upnp:class>object.item.videoItem</upnp:class>'
    + '<res ' + attributes + '>' + escapeXml(url) + '</res>'
    + '</item>';
}

/** Seconds as the H:MM:SS.mmm a set expects. */
function secondsAsClock(seconds) {
  const whole = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = whole % 60;
  return h + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0') + '.000';
}

/**
 * Every episode of a show, in order, flattened into one list.
 *
 * Seasons are not made into folders. A set's remote makes every extra level a
 * cost, and a show whose seasons are folders takes four presses to reach an
 * episode instead of two. The season is put in the episode's name instead,
 * where it can be read at a glance.
 */
function episodesOf(item) {
  const out = [];
  for (const season of item.seasons ?? []) {
    for (const episode of season.episodes ?? []) {
      out.push({
        video: episode,
        label: 'S' + String(season.number).padStart(2, '0')
          + 'E' + String(episode.episode).padStart(2, '0')
          + (episode.title ? ' · ' + episode.title : ''),
      });
    }
  }
  return out;
}

/**
 * Answer one "what is inside this" question.
 *
 * @param {string} objectId       what the television is looking inside
 * @param {number} startingIndex  how far into the list it already has
 * @param {number} requestedCount how many it wants, 0 meaning all of them
 * @param {(videoId: string, filePath: string) => string} urlFor  where a file lives
 * @param {{profile: object}} context
 * @returns {{xml: string, returned: number, total: number}}
 */
export function browse(objectId, startingIndex, requestedCount, urlFor, { profile }) {
  const id = objectId || ROOT;
  const entries = childrenOf(id, urlFor, profile);

  const from = Math.max(0, Number(startingIndex) || 0);
  const count = Number(requestedCount) || 0;
  const slice = count > 0 ? entries.slice(from, from + count) : entries.slice(from);

  const xml = '<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/"'
    + ' xmlns:dc="http://purl.org/dc/elements/1.1/"'
    + ' xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/"'
    + ' xmlns:dlna="urn:schemas-dlna-org:metadata-1-0/">'
    + slice.join('')
    + '</DIDL-Lite>';

  return { xml, returned: slice.length, total: entries.length };
}

/** The rows inside one container, already as XML. */
function childrenOf(id, urlFor, profile) {
  // ---------------------------------------------------------------- root ---
  if (id === ROOT) {
    const shelves = collections.listCollections().filter((shelf) => shelf.count > 0);
    return [
      ...shelves.map((shelf) => container(
        'shelf:' + shelf.id, ROOT, shelf.name, shelf.count,
      )),
      container('all:movie', ROOT, 'All Films', library.listItems({ kind: 'movie', profile }).length),
      container('all:show', ROOT, 'All TV Shows', library.listItems({ kind: 'show', profile }).length),
    ];
  }

  // --------------------------------------------------------------- shelf ---
  if (id.startsWith('shelf:')) {
    const items = collections.collectionItems(id.slice(6)) ?? [];
    return items.map((item) => rowFor(item, id, urlFor, profile));
  }

  // ------------------------------------------------------------ all of a kind ---
  if (id === 'all:movie' || id === 'all:show') {
    const kind = id === 'all:movie' ? 'movie' : 'show';
    return library.listItems({ kind, profile })
      .map((item) => rowFor(item, id, urlFor, profile));
  }

  // ---------------------------------------------------------------- show ---
  if (id.startsWith('show:')) {
    const item = library.getItem(id.slice(5), profile);
    if (!item) return [];
    return episodesOf(item).map(({ video, label }) => videoItem({
      id: 'video:' + video.id,
      parentId: id,
      title: label,
      url: urlFor(video.id, video.path),
      mime: mimeFor(video.path),
      size: video.size,
      duration: video.duration,
    }));
  }

  return [];
}

/** A film is a thing to play; a show is a folder to open. */
function rowFor(entry, parentId, urlFor, profile) {
  if (entry.kind === 'movie') {
    const item = library.getItem(entry.id, profile);
    const video = item?.video;
    if (!video) return container('empty:' + entry.id, parentId, entry.title, 0);
    return videoItem({
      id: 'video:' + video.id,
      parentId,
      title: entry.year ? entry.title + ' (' + entry.year + ')' : entry.title,
      url: urlFor(video.id, video.path),
      mime: mimeFor(video.path),
      size: video.size,
      duration: video.duration,
    });
  }

  return container('show:' + entry.id, parentId, entry.title, entry.episodeCount ?? 0);
}
