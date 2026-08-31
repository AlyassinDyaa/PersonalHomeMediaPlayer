/**
 * Who is allowed to reach the library.
 *
 * The desktop app talks to this server over the loopback address, and anything
 * arriving that way is already on this machine — it needs no passcode, because
 * whoever sent it could have opened the files directly.
 *
 * Anything from elsewhere on the network is a browser, and has to log in. That
 * is one passcode, kept as a hash, exchanged for a signed cookie.
 *
 * This is home-network protection, not internet protection: the connection is
 * plain HTTP, so the passcode is only as private as the network it crosses.
 * It exists to stop a housemate's laptop or a guest phone browsing the library,
 * which is the actual threat on a home network.
 */

import crypto from 'node:crypto';
import { config, passcodeMatches, sessionSecret } from './config.js';

export const COOKIE_NAME = 'media_session';
/** How long a browser stays logged in. Long, because it is a television. */
const SESSION_DAYS = 30;

/** Addresses that mean "this machine". */
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** Whether a request came from the machine the server runs on. */
export function isLocalRequest(req) {
  const address = req.socket?.remoteAddress ?? '';
  return LOOPBACK.has(address);
}

function sign(value) {
  return crypto.createHmac('sha256', sessionSecret()).update(value).digest('base64url');
}

/** A token carrying its own expiry, signed so it cannot be edited. */
export function issueToken() {
  const expires = Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000;
  const body = String(expires);
  return body + '.' + sign(body);
}

export function tokenValid(token) {
  if (typeof token !== 'string' || !token.includes('.')) return false;
  const [body, signature] = token.split('.');

  const expected = Buffer.from(sign(body));
  const given = Buffer.from(String(signature ?? ''));
  if (expected.length !== given.length) return false;
  if (!crypto.timingSafeEqual(expected, given)) return false;

  const expires = Number(body);
  return Number.isFinite(expires) && expires > Date.now();
}

/** Read one cookie without pulling in a parser. */
export function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    if (part.slice(0, index).trim() === name) {
      return decodeURIComponent(part.slice(index + 1).trim());
    }
  }
  return null;
}

export function setSessionCookie(res, token) {
  const maxAge = SESSION_DAYS * 24 * 60 * 60;
  res.setHeader('Set-Cookie', COOKIE_NAME + '=' + encodeURIComponent(token)
    + '; Path=/; Max-Age=' + maxAge + '; HttpOnly; SameSite=Lax');
}

export function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', COOKIE_NAME + '=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax');
}

/**
 * Repeated wrong guesses are slowed down per address.
 *
 * A four character passcode is not many combinations, and a home network is
 * exactly where someone would have time to try them.
 */
const attempts = new Map();
const MAX_ATTEMPTS = 8;
const LOCKOUT_MS = 5 * 60 * 1000;

export function loginBlockedFor(address) {
  const record = attempts.get(address);
  if (!record) return 0;
  if (Date.now() > record.until) {
    attempts.delete(address);
    return 0;
  }
  return record.count >= MAX_ATTEMPTS ? Math.ceil((record.until - Date.now()) / 1000) : 0;
}

export function recordFailure(address) {
  const record = attempts.get(address) ?? { count: 0, until: 0 };
  record.count += 1;
  record.until = Date.now() + LOCKOUT_MS;
  attempts.set(address, record);
}

export function recordSuccess(address) {
  attempts.delete(address);
}

/** Whether this request is allowed through, without deciding what to do about it. */
export function requestAuthorised(req) {
  if (isLocalRequest(req)) return true;
  // No passcode means nothing is shared, whatever the sharing setting says.
  if (!config.remoteAccess || !config.passcodeHash) return false;
  return tokenValid(readCookie(req, COOKIE_NAME));
}

/**
 * Express middleware guarding everything except the login endpoints and the
 * login page itself.
 */
export function requireAuth(req, res, next) {
  if (requestAuthorised(req)) {
    next();
    return;
  }

  /*
   * A browser asking for a page is always sent to the login screen, including
   * when sharing is switched off — that screen explains it is switched off and
   * where to turn it on. Refusing the navigation with JSON instead, as this
   * did, is invisible to the reader: a tablet opening the library from its Home
   * Screen has no address bar and no browser error page to show it in, so an
   * unexplained black screen was the whole of the message.
   *
   * Anything that is not a page still gets a status it can act on, and the
   * distinction between "not shared" and "not signed in" is kept.
   */
  const wantsPage = (req.headers.accept ?? '').includes('text/html');
  if (wantsPage) {
    res.redirect('/login');
    return;
  }

  if (!config.remoteAccess) {
    res.status(403).json({ error: 'This library is not shared on the network' });
    return;
  }
  res.status(401).json({ error: 'Not signed in' });
}

export { passcodeMatches };
