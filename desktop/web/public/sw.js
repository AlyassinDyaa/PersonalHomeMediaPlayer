/**
 * What the library says when the computer at home is off.
 *
 * The server cannot answer this, because the server is the thing that is not
 * running. A device asking a machine that is switched off gets no response at
 * all, which is why tapping the Home Screen icon used to land on the browser's
 * own dead page — or, with no address bar to put it in, on nothing but black.
 *
 * A service worker is the only piece of this library that lives on the phone
 * rather than on the computer, so it is the only piece that can still speak
 * when the computer cannot. It keeps one page for exactly that moment.
 *
 * Deliberately small. It caches the shell so the app opens quickly and has
 * something to say when it cannot open at all; it never caches the library
 * itself. A remembered list of films would go stale the first time anything
 * was added, and a remembered position would be wrong for whoever picked up
 * the tablet next.
 */

const VERSION = 'v1';
const SHELL = 'library-shell-' + VERSION;

/** Kept so there is something to show when nothing can be reached. */
const OFFLINE_PAGE = '/offline.html';

const ALWAYS_KEEP = [OFFLINE_PAGE, '/icon-180.png', '/icon-512.png', '/manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    /*
     * Added one at a time rather than with addAll, which rejects the whole
     * batch if any single file is missing. A library whose icons had been
     * renamed would otherwise end up with no offline page either — the one
     * thing this exists to provide.
     */
    await Promise.all(ALWAYS_KEEP.map((path) => cache.add(path).catch(() => {})));
    // The point of this worker is the message it shows when the server is
    // gone, so it should take over at the first opportunity rather than wait
    // for every tab to be closed.
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(
      names.filter((name) => name.startsWith('library-shell-') && name !== SHELL)
        .map((name) => caches.delete(name)),
    );
    await self.clients.claim();
  })());
});

/** Whether a request is for the library's data rather than for the app itself. */
function isLibraryData(url) {
  return url.pathname.startsWith('/api/')
    || url.pathname.startsWith('/artwork/')
    || url.pathname.startsWith('/stream/');
}

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Anything that changes something on the server is none of this worker's
  // business, and neither is another origin.
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  /*
   * Video is left alone entirely.
   *
   * A player asks for byte ranges, and a cache that answered one of those with
   * a whole file — or with a stale segment from a stream that has since been
   * rebuilt — would break playback in a way that looks like a broken file.
   */
  if (isLibraryData(url)) return;

  /*
   * A page the person is trying to open is the case this whole file exists
   * for. Try the network, and when there is nothing there, say so in our own
   * words rather than the browser's.
   */
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        return await fetch(request);
      } catch {
        const cache = await caches.open(SHELL);
        return (await cache.match(OFFLINE_PAGE))
          ?? new Response('The library is not answering.', {
            status: 503,
            headers: { 'Content-Type': 'text/plain' },
          });
      }
    })());
    return;
  }

  /*
   * The built script and stylesheet, served from cache first and refreshed
   * behind the back of the page.
   *
   * Their names carry a hash of their contents, so a cached one is never the
   * wrong version — a new build asks for a different name. That makes serving
   * the old copy immediately safe, and it is what lets the app appear at once
   * on a slow connection instead of after a round trip.
   */
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith((async () => {
      const cache = await caches.open(SHELL);
      const cached = await cache.match(request);
      const network = fetch(request)
        .then((response) => {
          if (response.ok) cache.put(request, response.clone());
          return response;
        })
        .catch(() => null);

      return cached ?? (await network) ?? Response.error();
    })());
  }
});
