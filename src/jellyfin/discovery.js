// Decouverte automatique sur le reseau local (UDP 7359), comme un vrai serveur Jellyfin :
// les apps envoient "who is JellyfinServer?" et affichent le serveur trouve.
const dgram = require('dgram');
const os = require('os');
const config = require('../config');

/**
 * Adresse a annoncer a l'appareil qui cherche : celle de la carte reseau du PC qui est
 * sur le meme sous-reseau que lui (jamais une adresse 169.254.x d'une carte inactive).
 */
function localAddress(port, requester) {
  const s = config.get().settings;
  if (s.publicUrl) return s.publicUrl;
  const toInt = (ip) => ip.split('.').reduce((n, b) => (n << 8) + Number(b), 0) >>> 0;
  const candidates = Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal && !i.address.startsWith('169.254.'));
  const sameNet = candidates.find((i) => {
    if (!requester || !i.netmask) return false;
    const mask = toInt(i.netmask);
    return (toInt(i.address) & mask) === (toInt(requester) & mask);
  });
  const pick = sameNet || candidates[0];
  return `http://${pick ? pick.address : '127.0.0.1'}:${port}`;
}

function start(port) {
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  sock.on('message', (msg, rinfo) => {
    if (!/who is (jellyfin|emby|mediabrowser)server\?/i.test(msg.toString())) return;
    const c = config.get();
    const reply = JSON.stringify({ Address: localAddress(port, rinfo.address), Id: c.serverId, Name: c.settings.serverName, EndpointAddress: null });
    sock.send(reply, rinfo.port, rinfo.address);
  });
  sock.on('error', (e) => {
    console.log(new Date().toISOString(), `[discovery] desactivee : ${e.message}`);
    sock.close();
  });
  sock.bind(7359);
}

module.exports = { start };
