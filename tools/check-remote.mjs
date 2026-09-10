/**
 * Walk the whole way in, exactly as a phone does, and report the first thing
 * that is not right.
 *
 * Every time this library has failed on a phone while working on the desktop,
 * the cause has been something no test looked at: an address that answers to a
 * script but not to a browser, a bundle name that no longer exists, a worker
 * pinning a build that has gone. Checking that the server is "up" never caught
 * any of them, because the server was up every time.
 *
 * So this does what a browser does, in order — resolve, handshake, ask for the
 * page as a browser asks, follow the redirect, then fetch every script,
 * stylesheet and icon the page names, and check the worker matches the build
 * being served. Anything that would leave somebody looking at a blank screen
 * shows up here as a line saying so.
 *
 *   node tools/check-remote.mjs                       (the Tailscale address)
 *   node tools/check-remote.mjs http://192.168.1.171:8787
 */

import tls from 'node:tls';

const target = process.argv[2] ?? 'https://pss.tail6dca36.ts.net:8443';
const base = new URL(target);

/* What a phone sends. The server tells a browser from a script by the Accept
 * header, so asking any other way tests a path nobody uses. */
const BROWSER = {
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-GB,en;q=0.9',
  'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15'
    + ' (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
};

const results = [];
const note = (ok, what, detail = '') => {
  results.push({ ok, what, detail });
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + what + (detail ? '   ' + detail : ''));
};

console.log('checking ' + base.origin + '\n');

/* ---------------------------------------------------------- the handshake --- */

if (base.protocol === 'https:') {
  await new Promise((resolve) => {
    const socket = tls.connect({
      host: base.hostname,
      port: Number(base.port || 443),
      servername: base.hostname,
      timeout: 12_000,
    }, () => {
      const cert = socket.getPeerCertificate(true);
      note(socket.authorized, 'the certificate is trusted',
        socket.authorized ? cert.subject?.CN : (socket.authorizationError ?? ''));

      /* A leaf on its own is the classic phone-only failure: desktop browsers
       * often fetch the missing link themselves, Safari does not. */
      let depth = 0;
      for (let c = cert; c && depth < 10; c = c.issuerCertificate) {
        depth += 1;
        if (c.issuerCertificate === c) break;
      }
      note(depth >= 2, 'the chain is complete', depth + ' certificates');

      const daysLeft = Math.round((new Date(cert.valid_to) - Date.now()) / 86400000);
      note(daysLeft > 7, 'the certificate is in date', daysLeft + ' days left');

      socket.end();
      resolve();
    });
    socket.on('timeout', () => { note(false, 'the handshake completes', 'timed out'); socket.destroy(); resolve(); });
    socket.on('error', (error) => { note(false, 'the handshake completes', error.message); resolve(); });
  });
}

/* ------------------------------------------------------------- the way in --- */

let page = null;
let landed = null;
try {
  const response = await fetch(base.origin + '/', { headers: BROWSER, redirect: 'follow' });
  landed = response.url;
  page = await response.text();
  note(response.ok, 'the front door answers a browser', response.status + ' -> ' + new URL(landed).pathname);
  note(/<!doctype html/i.test(page), 'it answers with a page', page.length + ' bytes');
} catch (error) {
  note(false, 'the front door answers a browser', error.message);
}

/* --------------------------------------------- everything the page names --- */

if (page) {
  const referenced = [...new Set([
    ...[...page.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]),
    ...[...page.matchAll(/<link[^>]+href="([^"]+)"/g)].map((m) => m[1]),
  ])].filter((href) => !href.startsWith('http') && !href.startsWith('data:'));

  let broken = 0;
  for (const href of referenced) {
    const url = new URL(href, landed ?? base.origin).toString();
    try {
      const r = await fetch(url, { headers: { 'User-Agent': BROWSER['User-Agent'] } });
      const type = r.headers.get('content-type') ?? '';

      /*
       * A script answered with HTML is the exact shape of a blank screen: the
       * status is 200, nothing looks wrong in a log, and the browser quietly
       * refuses to run it.
       */
      const wrongType = /\.js$/.test(href) && !/javascript|ecmascript/.test(type);
      if (!r.ok || wrongType) {
        broken += 1;
        note(false, 'the page can load ' + href, r.status + ' ' + type);
      }
    } catch (error) {
      broken += 1;
      note(false, 'the page can load ' + href, error.message);
    }
  }
  note(broken === 0, 'every file the page names loads', referenced.length + ' checked');
}

/* ------------------------------------------------------------- the worker --- */

try {
  const r = await fetch(base.origin + '/sw.js', { headers: { 'User-Agent': BROWSER['User-Agent'] } });
  const body = await r.text();
  const version = body.match(/const VERSION = '([^']+)'/)?.[1] ?? null;

  note(r.ok && /javascript/.test(r.headers.get('content-type') ?? ''),
    'the worker is served as a script', r.status);
  note(version !== null && version !== '__BUILD__',
    'the worker is stamped with a build', version ?? 'no version found');

  /*
   * The stamp has to match the script actually being served. When it does
   * not, a device keeps the cache from an older build and can end up running
   * that build's code against this build's page.
   */
  if (page) {
    const bundle = page.match(/assets\/index-([A-Za-z0-9_-]+)\.js/)?.[1];
    if (bundle) {
      note(version === bundle, 'the worker matches the build being served',
        version === bundle ? version : version + ' vs ' + bundle);
    }
  }

  note((r.headers.get('cache-control') ?? '').includes('no-store'),
    'the worker itself is never cached', r.headers.get('cache-control') ?? 'none');
} catch (error) {
  note(false, 'the worker is reachable', error.message);
}

/* ------------------------------------------------------------------------- */

const failed = results.filter((r) => !r.ok).length;
console.log('\n' + (results.length - failed) + ' of ' + results.length + ' checks passed');
if (failed) {
  console.log('\nA phone opening ' + base.origin + ' would have trouble.');
}
process.exitCode = failed ? 1 : 0;
