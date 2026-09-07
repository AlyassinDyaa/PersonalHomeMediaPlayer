/**
 * The library, as a media server a television can find by itself.
 *
 * Roku TVs — and most sets that play from a network — have no browser and will
 * not install anything. What they do have, built in, is a player that looks
 * for media servers on the local network. So rather than asking the television
 * to run our interface, the library speaks the language the television already
 * knows.
 *
 * What this is not: a way in from outside the house. It answers only to
 * private addresses, and it is off until switched on, because the protocol
 * itself has no notion of who is asking — that is the bargain every set on the
 * market has already made, and it is only acceptable inside one home.
 */

import crypto from 'node:crypto';
import express from 'express';
import fs from 'node:fs';
import { config } from '../config.js';
import * as library from '../library.js';
import { defaultProfileId, getProfile } from '../profiles.js';
import { browse, ROOT } from './content.js';
import { startDiscovery, lanAddress } from './ssdp.js';

/**
 * The name this server keeps for the life of the library.
 *
 * A set remembers a server by this and not by its address, so a new one every
 * restart would leave a television with a list of ghosts. Derived from
 * something already stable rather than stored, so there is nothing new to keep
 * and nothing to lose.
 */
function stableUuid() {
  const seed = (config.dataDir ?? 'media-library') + '|dlna';
  const hex = crypto.createHash('sha1').update(seed).digest('hex');
  return [
    hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20, 32),
  ].join('-');
}

/**
 * Whether a request came from this house.
 *
 * There is no passcode in this protocol and no way to add one a television
 * would understand, so the boundary has to be the network itself. Private
 * ranges and the machine's own loopback, nothing else — a request arriving
 * from beyond the router is not a set in the living room.
 */
function fromThisHouse(req) {
  const raw = (req.ip ?? req.socket?.remoteAddress ?? '').replace(/^::ffff:/, '');
  if (raw === '127.0.0.1' || raw === '::1') return true;
  return /^10\./.test(raw)
    || /^192\.168\./.test(raw)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(raw)
    || /^169\.254\./.test(raw);
}

/** The profile a television watches as: the owner, since a set cannot choose. */
function televisionProfile() {
  return getProfile(defaultProfileId());
}

/** The XML a set fetches first, describing what this is and what it offers. */
function deviceDescription(uuid, name, base) {
  return '<?xml version="1.0" encoding="utf-8"?>'
    + '<root xmlns="urn:schemas-upnp-org:device-1-0">'
    + '<specVersion><major>1</major><minor>0</minor></specVersion>'
    + '<device>'
    + '<deviceType>urn:schemas-upnp-org:device:MediaServer:1</deviceType>'
    + '<friendlyName>' + name + '</friendlyName>'
    + '<manufacturer>Personal Home Media Player</manufacturer>'
    + '<modelName>Media Library</modelName>'
    + '<modelNumber>1</modelNumber>'
    + '<UDN>uuid:' + uuid + '</UDN>'
    /* Samsung and a few others refuse a server without this line. */
    + '<dlna:X_DLNADOC xmlns:dlna="urn:schemas-dlna-org:device-1-0">DMS-1.50</dlna:X_DLNADOC>'
    + '<serviceList>'
    + '<service>'
    + '<serviceType>urn:schemas-upnp-org:service:ContentDirectory:1</serviceType>'
    + '<serviceId>urn:upnp-org:serviceId:ContentDirectory</serviceId>'
    + '<SCPDURL>' + base + '/content-directory.xml</SCPDURL>'
    + '<controlURL>' + base + '/control</controlURL>'
    + '<eventSubURL>' + base + '/event</eventSubURL>'
    + '</service>'
    + '<service>'
    + '<serviceType>urn:schemas-upnp-org:service:ConnectionManager:1</serviceType>'
    + '<serviceId>urn:upnp-org:serviceId:ConnectionManager</serviceId>'
    + '<SCPDURL>' + base + '/connection-manager.xml</SCPDURL>'
    + '<controlURL>' + base + '/control</controlURL>'
    + '<eventSubURL>' + base + '/event</eventSubURL>'
    + '</service>'
    + '</serviceList>'
    + '</device>'
    + '</root>';
}

/** The one action that matters, described in the shape a set expects. */
const CONTENT_DIRECTORY_SCPD = '<?xml version="1.0" encoding="utf-8"?>'
  + '<scpd xmlns="urn:schemas-upnp-org:service-1-0">'
  + '<specVersion><major>1</major><minor>0</minor></specVersion>'
  + '<actionList><action><name>Browse</name><argumentList>'
  + ['ObjectID', 'BrowseFlag', 'Filter', 'StartingIndex', 'RequestedCount', 'SortCriteria']
    .map((name) => '<argument><name>' + name + '</name><direction>in</direction>'
      + '<relatedStateVariable>A_ARG_TYPE_' + name + '</relatedStateVariable></argument>').join('')
  + ['Result', 'NumberReturned', 'TotalMatches', 'UpdateID']
    .map((name) => '<argument><name>' + name + '</name><direction>out</direction>'
      + '<relatedStateVariable>A_ARG_TYPE_' + name + '</relatedStateVariable></argument>').join('')
  + '</argumentList></action></actionList>'
  + '<serviceStateTable>'
  + ['ObjectID', 'BrowseFlag', 'Filter', 'SortCriteria', 'Result']
    .map((name) => '<stateVariable sendEvents="no"><name>A_ARG_TYPE_' + name + '</name>'
      + '<dataType>string</dataType></stateVariable>').join('')
  + ['StartingIndex', 'RequestedCount', 'NumberReturned', 'TotalMatches', 'UpdateID']
    .map((name) => '<stateVariable sendEvents="no"><name>A_ARG_TYPE_' + name + '</name>'
      + '<dataType>ui4</dataType></stateVariable>').join('')
  + '</serviceStateTable></scpd>';

const CONNECTION_MANAGER_SCPD = '<?xml version="1.0" encoding="utf-8"?>'
  + '<scpd xmlns="urn:schemas-upnp-org:service-1-0">'
  + '<specVersion><major>1</major><minor>0</minor></specVersion>'
  + '<actionList /><serviceStateTable /></scpd>';

/** Pull one value out of a SOAP body without parsing the whole document. */
function soapValue(body, name) {
  const match = new RegExp('<' + name + '[^>]*>([\\s\\S]*?)</' + name + '>', 'i').exec(body);
  return match ? match[1].trim() : '';
}

/** Turn XML back into text, for values a set escaped on the way in. */
function unescapeXml(value) {
  return value
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/**
 * Mount the media server on an existing Express app.
 *
 * @param {import('express').Express} app
 * @param {{port: number, onLog?: (message: string) => void}} options
 * @returns {{stop: () => void} | null} null when it is switched off or there is
 *   no network to be found on.
 */
export function serveToTelevisions(app, { port, onLog = () => {} }) {
  const router = express.Router();

  // Every one of these is for a television on this network and nothing else.
  router.use((req, res, next) => {
    if (!fromThisHouse(req)) {
      res.status(403).end();
      return;
    }
    /*
     * Say what the television asked for.
     *
     * When a set cannot see the library there is nothing to look at: no error
     * on the screen, no address bar, no way to tell "it never found us" from
     * "it found us and did not like the answer". This line is the difference,
     * and it is the first thing anybody will want when a television misbehaves.
     */
    onLog((req.ip ?? '').replace(/^::ffff:/, '') + ' asked for ' + req.method + ' ' + req.originalUrl);
    next();
  });

  const uuid = stableUuid();
  const name = (config.libraryName || 'Media Library').trim();
  const address = lanAddress();

  if (!address) {
    onLog('no network address, so no television can find the library');
    return null;
  }

  const base = 'http://' + address + ':' + port + '/dlna';

  router.get('/device.xml', (req, res) => {
    res.type('application/xml').send(deviceDescription(uuid, escapeXml(name), base));
  });

  router.get('/content-directory.xml', (req, res) => {
    res.type('application/xml').send(CONTENT_DIRECTORY_SCPD);
  });

  router.get('/connection-manager.xml', (req, res) => {
    res.type('application/xml').send(CONNECTION_MANAGER_SCPD);
  });

  /*
   * Subscriptions are answered and then never used.
   *
   * A set asks to be told when the library changes; being told is a nicety
   * and refusing the request outright makes some of them give up on the
   * server entirely. So the answer is yes, and nothing is ever sent.
   */
  router.all('/event', (req, res) => {
    res.set('SID', 'uuid:' + uuid).set('TIMEOUT', 'Second-1800').status(200).end();
  });

  router.post('/control', express.text({ type: () => true, limit: '256kb' }), (req, res) => {
    const body = typeof req.body === 'string' ? req.body : '';
    if (!/[<:]Browse[ >]/.test(body)) {
      // Only Browse is implemented; anything else is politely nothing.
      res.status(401).type('text/xml').send('<?xml version="1.0"?><s:Envelope '
        + 'xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><s:Fault>'
        + '<faultcode>s:Client</faultcode><faultstring>UPnPError</faultstring>'
        + '</s:Fault></s:Body></s:Envelope>');
      return;
    }

    const objectId = unescapeXml(soapValue(body, 'ObjectID')) || ROOT;
    const flag = soapValue(body, 'BrowseFlag') || 'BrowseDirectChildren';
    const startingIndex = Number(soapValue(body, 'StartingIndex')) || 0;
    const requestedCount = Number(soapValue(body, 'RequestedCount')) || 0;

    const urlFor = (videoId) => base + '/media/' + encodeURIComponent(videoId);

    let result;
    try {
      result = flag === 'BrowseMetadata'
        // Asked about the folder itself rather than its contents. An empty
        // list is a truthful answer and every set carries on from it.
        ? { xml: browse(objectId, 0, 1, urlFor, { profile: televisionProfile() }).xml, returned: 1, total: 1 }
        : browse(objectId, startingIndex, requestedCount, urlFor, { profile: televisionProfile() });
    } catch (error) {
      onLog('a television asked for ' + objectId + ' and it went wrong: ' + error.message);
      result = { xml: '<DIDL-Lite/>', returned: 0, total: 0 };
    }

    onLog('  looked inside ' + objectId + ' and was given ' + result.returned + ' of ' + result.total);

    res.type('text/xml').send('<?xml version="1.0" encoding="utf-8"?>'
      + '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"'
      + ' s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body>'
      + '<u:BrowseResponse xmlns:u="urn:schemas-upnp-org:service:ContentDirectory:1">'
      + '<Result>' + escapeXml(result.xml) + '</Result>'
      + '<NumberReturned>' + result.returned + '</NumberReturned>'
      + '<TotalMatches>' + result.total + '</TotalMatches>'
      + '<UpdateID>1</UpdateID>'
      + '</u:BrowseResponse></s:Body></s:Envelope>');
  });

  /**
   * The file itself.
   *
   * Sent as it is on disk. A television decodes far more than a browser does —
   * Matroska, HEVC, AC-3 — so the conversions the browser needs would be work
   * done for nothing here, and would put ffmpeg between the set and a file it
   * could already play.
   */
  router.get('/media/:videoId', (req, res) => {
    const video = library.getVideo(req.params.videoId, televisionProfile());
    if (!video || !fs.existsSync(video.path)) {
      res.status(404).end();
      return;
    }
    // sendFile does byte ranges by itself, which is what makes seeking work.
    res.sendFile(video.path, (error) => {
      if (error && !res.headersSent) res.status(404).end();
    });
  });

  app.use('/dlna', router);

  const discovery = startDiscovery({ uuid, port, address, onLog });
  onLog('televisions on this network can now find "' + name + '"');

  return { stop: () => discovery.stop() };
}
