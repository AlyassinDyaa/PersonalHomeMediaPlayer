/**
 * Being found by a television.
 *
 * A Roku, and every other set that plays from a network, looks for media
 * servers by shouting a question onto the local network and listening for
 * answers. There is no address to type and nothing to pair: the television
 * asks "who is a media server", and anything that is says so.
 *
 * That is the whole of this file. It answers the question when asked, and
 * announces itself now and again in case nobody was listening at the time —
 * a set switched on after the library was already running would otherwise
 * never hear about it.
 *
 * Deliberately not a UPnP library. What is needed is three message types and
 * a multicast socket; a dependency for that would be more code to keep, not
 * less, and none of it would be legible when a television refuses to see the
 * library and somebody has to work out why.
 */

import dgram from 'node:dgram';
import os from 'node:os';

const GROUP = '239.255.255.250';
const PORT = 1900;

/** How long a set may believe in us without hearing again, in seconds. */
const BELIEVE_FOR = 1800;

/** How often to say we are here. Well inside the above, so a lost packet is nothing. */
const ANNOUNCE_EVERY_MS = 10 * 60 * 1000;

/**
 * What we claim to be.
 *
 * A media server answers to several names at once — the root device, its own
 * type, and each service it offers — and a television may ask for any of them.
 * Answering only one is how a server ends up invisible to half the sets in a
 * house.
 */
function notificationTypes(uuid) {
  return [
    'upnp:rootdevice',
    'uuid:' + uuid,
    'urn:schemas-upnp-org:device:MediaServer:1',
    'urn:schemas-upnp-org:service:ContentDirectory:1',
    'urn:schemas-upnp-org:service:ConnectionManager:1',
  ];
}

/** The address a television should come back to. */
export function lanAddress() {
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family !== 'IPv4' || address.internal) continue;
      // Carrier-grade NAT space is the mesh network, not the house.
      if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(address.address)) continue;
      return address.address;
    }
  }
  return null;
}

/**
 * Start answering "who is a media server" on the local network.
 *
 * @param {{uuid: string, port: number, address: string, name: string}} options
 * @returns {{stop: () => void}}
 */
export function startDiscovery({ uuid, port, address, onLog = () => {} }) {
  const describedAt = 'http://' + address + ':' + port + '/dlna/device.xml';
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  let announcer = null;

  const send = (lines, to) => {
    const message = Buffer.from(lines.join('\r\n') + '\r\n\r\n');
    socket.send(message, 0, message.length, to.port, to.address, () => {});
  };

  /** The reply to a search: unicast, straight back to whoever asked. */
  const answer = (searchTarget, to) => {
    send([
      'HTTP/1.1 200 OK',
      'CACHE-CONTROL: max-age=' + BELIEVE_FOR,
      'DATE: ' + new Date().toUTCString(),
      'EXT:',
      'LOCATION: ' + describedAt,
      'SERVER: Node/UPnP/1.0 MediaLibrary/1.0',
      'ST: ' + searchTarget,
      'USN: uuid:' + uuid + (searchTarget.startsWith('uuid:') ? '' : '::' + searchTarget),
    ], to);
  };

  /** Saying we are here, unprompted, to the whole network. */
  const announce = (alive = true) => {
    for (const type of notificationTypes(uuid)) {
      send([
        'NOTIFY * HTTP/1.1',
        'HOST: ' + GROUP + ':' + PORT,
        'CACHE-CONTROL: max-age=' + BELIEVE_FOR,
        'LOCATION: ' + describedAt,
        'SERVER: Node/UPnP/1.0 MediaLibrary/1.0',
        'NT: ' + type,
        'NTS: ' + (alive ? 'ssdp:alive' : 'ssdp:byebye'),
        'USN: uuid:' + uuid + (type.startsWith('uuid:') ? '' : '::' + type),
      ], { address: GROUP, port: PORT });
    }
  };

  socket.on('message', (message, from) => {
    const text = message.toString();
    if (!text.startsWith('M-SEARCH')) return;

    const target = /^ST:\s*(.+)$/im.exec(text)?.[1]?.trim();
    if (!target) return;

    const wanted = target === 'ssdp:all'
      ? notificationTypes(uuid)
      : notificationTypes(uuid).filter((type) => type === target);
    if (!wanted.length) return;

    /*
     * A short random wait before replying.
     *
     * Every server on the network heard the same question at the same moment,
     * and all of them answering in the same millisecond is how a set ends up
     * dropping the reply it wanted. The specification asks for a delay up to
     * the MX the searcher named; a fraction of a second is plenty here.
     */
    const delay = Math.floor(Math.random() * 400);
    setTimeout(() => {
      for (const type of wanted) answer(type, from);
    }, delay);
  });

  socket.on('error', (error) => {
    onLog('discovery stopped: ' + error.message);
    try { socket.close(); } catch { /* already gone */ }
  });

  socket.bind(PORT, () => {
    try {
      socket.addMembership(GROUP, address);
    } catch (error) {
      onLog('could not join the discovery group: ' + error.message);
    }
    socket.setMulticastTTL(4);
    announce(true);
    announcer = setInterval(() => announce(true), ANNOUNCE_EVERY_MS);
    onLog('answering as a media server at ' + describedAt);
  });

  return {
    stop() {
      clearInterval(announcer);
      // Tell the sets to forget us rather than leaving them to time out on a
      // library that is no longer there.
      try { announce(false); } catch { /* the socket may already be gone */ }
      try { socket.close(); } catch { /* already closed */ }
    },
  };
}
