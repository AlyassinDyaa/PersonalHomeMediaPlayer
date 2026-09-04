/**
 * Where a profile was last seen from.
 *
 * The owner of a shared library reasonably wants to know whether the person
 * watching is the tablet in the next room or somebody signed in from
 * elsewhere. An address answers that; it is also the only honest answer
 * available here.
 *
 * There is deliberately no lookup of a city or a street. That would mean
 * sending the addresses of everyone using this library to a company that sells
 * geolocation, to learn something the owner of a house-sized network already
 * knows. What the address *can* say for itself — this machine, the house, the
 * private mesh, or somewhere else — is worked out here and nowhere else.
 */

import { getDb } from './db.js';

/** Addresses the operating system uses for the machine talking to itself. */
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** Strip the IPv6 wrapper Node puts around IPv4 callers on a dual-stack socket. */
export function plainAddress(raw) {
  const text = String(raw ?? '');
  return text.startsWith('::ffff:') ? text.slice(7) : text;
}

/**
 * What kind of network an address belongs to.
 *
 * @returns {'this computer'|'home network'|'private mesh'|'elsewhere'|'unknown'}
 */
export function networkKind(raw) {
  const address = plainAddress(raw);
  if (!address) return 'unknown';
  if (LOOPBACK.has(address) || LOOPBACK.has(raw)) return 'this computer';

  const parts = address.split('.').map(Number);
  if (parts.length === 4 && parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
    const [a, b] = parts;
    // Tailscale and other CGNAT users share 100.64.0.0/10.
    if (a === 100 && b >= 64 && b <= 127) return 'private mesh';
    if (a === 10) return 'home network';
    if (a === 192 && b === 168) return 'home network';
    if (a === 172 && b >= 16 && b <= 31) return 'home network';
    return 'elsewhere';
  }

  // IPv6: fe80:: is link-local, fc00::/7 is unique-local; both are the house.
  const lower = address.toLowerCase();
  if (lower.startsWith('fe80:') || lower.startsWith('fc') || lower.startsWith('fd')) {
    return 'home network';
  }
  return 'elsewhere';
}

/**
 * Remember where a profile is being used from.
 *
 * Written at most once a minute per profile. Every image, segment and poster
 * is a request, so recording each one would mean thousands of writes an hour
 * to store the same answer.
 */
const lastWrite = new Map();
const QUIET_MS = 60_000;

export function noteWhereabouts(profileId, rawAddress) {
  if (!profileId) return;

  const now = Date.now();
  const previous = lastWrite.get(profileId);
  if (previous && now - previous.at < QUIET_MS && previous.address === rawAddress) return;
  lastWrite.set(profileId, { at: now, address: rawAddress });

  try {
    getDb().prepare('UPDATE profiles SET last_address = ?, last_seen_at = ? WHERE id = ?')
      .run(plainAddress(rawAddress), now, profileId);
  } catch {
    // Knowing where somebody watched from is never worth failing a request for.
  }
}
