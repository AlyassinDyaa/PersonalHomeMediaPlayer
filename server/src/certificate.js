/**
 * The certificate that lets a browser trust this machine.
 *
 * Everything the library does over plain HTTP works, and a few things quietly
 * do not. A browser will not install a service worker on an insecure page, so
 * the offline notice — the one that says the computer at home is off rather
 * than showing a black screen — never registers on a phone. The same rule
 * blocks notifications, and makes iOS treat the passcode field as one its
 * password machinery need not service.
 *
 * Tailscale can issue a real certificate for a machine's name on the tailnet,
 * signed by an authority every device already trusts, without opening anything
 * to the internet. This module only has to find the files it wrote and say
 * what name they are for.
 */

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

/** Where `tailscale cert` is told to write. */
export function certificateDir() {
  return path.join(config.dataDir, 'certs');
}

function certificatePaths() {
  const dir = certificateDir();
  return { cert: path.join(dir, 'library.crt'), key: path.join(dir, 'library.key') };
}

/**
 * The certificate and key, or null when none has been issued.
 *
 * Read fresh rather than cached: renewing writes new files, and a server that
 * had memorised the old pair would go on presenting an expired certificate
 * until somebody restarted it.
 *
 * @returns {{ cert: Buffer, key: Buffer, name: string|null, expires: number|null }|null}
 */
export function loadCertificate() {
  const paths = certificatePaths();
  if (!fs.existsSync(paths.cert) || !fs.existsSync(paths.key)) return null;

  try {
    const cert = fs.readFileSync(paths.cert);
    const key = fs.readFileSync(paths.key);
    const details = describe(cert);
    return { cert, key, ...details };
  } catch {
    // A half-written pair during renewal, or a permissions problem. Either way
    // the plain server is still up, which is the important half.
    return null;
  }
}

/**
 * The name a certificate is for, and when it stops being valid.
 *
 * The name matters because it is the only address the certificate covers: an
 * IP address typed into a phone will be refused by the very trust this exists
 * to establish, so the interface has to hand out the name instead.
 */
function describe(pem) {
  try {
    const parsed = new crypto.X509Certificate(pem);
    // subjectAltName reads "DNS:name, DNS:other"; the first is ours.
    const alt = parsed.subjectAltName ?? '';
    const match = /DNS:([^,\s]+)/.exec(alt);
    return {
      name: match ? match[1] : null,
      expires: Date.parse(parsed.validTo) || null,
    };
  } catch {
    return { name: null, expires: null };
  }
}

/** Days until the certificate expires, or null when there is none. */
export function daysRemaining(certificate = loadCertificate()) {
  if (!certificate?.expires) return null;
  return Math.floor((certificate.expires - Date.now()) / 86_400_000);
}

/**
 * How long before expiry to start renewing.
 *
 * Certificates last ninety days and Tailscale will only reissue one inside
 * the last fortnight, so this has to be wide enough to contain a machine
 * that is off for a week and narrow enough that the reissue is accepted.
 */
const RENEW_WITHIN_DAYS = 21;

/** How often to look. Daily: expiry is measured in months, not minutes. */
const CHECK_EVERY_MS = 24 * 60 * 60 * 1000;

/** Where Tailscale puts its command line tool on Windows. */
const TAILSCALE = [
  process.env.TAILSCALE_PATH,
  'C:\\Program Files\\Tailscale\\tailscale.exe',
  '/usr/bin/tailscale',
  '/usr/local/bin/tailscale',
];

function tailscalePath() {
  return TAILSCALE.find((candidate) => candidate && fs.existsSync(candidate)) ?? null;
}

/**
 * Ask Tailscale to reissue the certificate.
 *
 * Harmless to run when nothing is due: the command returns the certificate
 * it already has rather than asking for another, so there is no need to be
 * careful about how often this is called.
 *
 * @returns {Promise<boolean>} whether it succeeded
 */
export function renewCertificate(name) {
  const tool = tailscalePath();
  if (!tool || !name) return Promise.resolve(false);

  const paths = certificatePaths();
  return new Promise((resolve) => {
    const child = spawn(tool, ['cert', '--cert-file', paths.cert, '--key-file', paths.key, name],
      { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let complaint = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { complaint = (complaint + chunk).slice(-500); });
    child.on('error', () => resolve(false));
    child.on('exit', (code) => {
      if (code === 0) resolve(true);
      else {
        console.warn('The certificate could not be renewed: ' + (complaint.trim() || ('exit ' + code)));
        resolve(false);
      }
    });
  });
}

/**
 * Keep a running server’s certificate current, without restarting it.
 *
 * A certificate that lapses does not degrade — it fails, completely, on
 * every device at once, ninety days after somebody set it up and forgot
 * that they had. Renewal has to be something the machine does rather than
 * something a person remembers.
 *
 * Node can be handed a new certificate while it is listening, so nothing is
 * interrupted: no restart, no dropped playback, no window where the library
 * is unreachable.
 */
export function watchCertificate(server) {
  const check = async () => {
    const current = loadCertificate();
    if (!current) return;

    const left = daysRemaining(current);
    if (left === null || left > RENEW_WITHIN_DAYS) return;

    console.log('The certificate expires in ' + left + ' days; renewing.');
    if (!await renewCertificate(current.name)) return;

    const renewed = loadCertificate();
    if (!renewed) return;
    try {
      server.setSecureContext({ cert: renewed.cert, key: renewed.key });
      console.log('The certificate is now good for ' + daysRemaining(renewed) + ' days.');
    } catch (error) {
      console.warn('The renewed certificate could not be loaded: ' + error.message);
    }
  };

  // Once at startup, in case the machine was off through the whole window.
  check().catch(() => {});
  const timer = setInterval(() => { check().catch(() => {}); }, CHECK_EVERY_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
