// WebSocket /socket : les apps Jellyfin et Emby l'ouvrent pour etre prevenues des changements.
// On le maintient ouvert (KeepAlive) et on y annonce les changements de lecture (UserDataChanged) :
// reprise, vu / pas vu et favoris se mettent a jour dans les apps sans recharger.
const { WebSocketServer } = require('ws');
const { st } = require('../db');

// Connexions ouvertes, par profil.
const clients = new Map();

function attach(server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const u = new URL(req.url, 'http://x');
    // Jellyfin : /socket ; apps Emby : /emby/embywebsocket.
    if (!/^\/(emby\/)?(socket|embywebsocket)\/?$/i.test(u.pathname)) return socket.destroy();
    const token = u.searchParams.get('api_key') || u.searchParams.get('ApiKey') || u.searchParams.get('apiKey');
    const row = token && st.tokenGet.get(token);
    if (!row) return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, row.profile));
  });

  wss.on('connection', (ws, profileId) => {
    if (!clients.has(profileId)) clients.set(profileId, new Set());
    clients.get(profileId).add(ws);
    ws.on('close', () => clients.get(profileId)?.delete(ws));
    const send = (MessageType, Data) => ws.send(JSON.stringify({ MessageType, Data }));
    send('ForceKeepAlive', 60);
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.MessageType === 'KeepAlive') send('KeepAlive');
    });
  });
}

// Changements regroupes par profil et envoyes une fois par seconde au plus (la progression est
// rapportee toutes les quelques secondes pendant une lecture).
const pending = new Map();

/** Annonce aux apps du profil les donnees de lecture changees : [{ uuid, data (UserData) }]. */
function userDataChanged(profileId, uuid, data) {
  if (!clients.get(profileId)?.size) return;
  if (!pending.has(profileId)) {
    pending.set(profileId, new Map());
    setTimeout(() => flush(profileId), 1000).unref();
  }
  pending.get(profileId).set(uuid, data);
}

function flush(profileId) {
  const items = pending.get(profileId);
  pending.delete(profileId);
  if (!items?.size) return;
  const msg = JSON.stringify({ MessageType: 'UserDataChanged', Data: { UserId: profileId, UserDataList: [...items.values()] } });
  for (const ws of clients.get(profileId) || []) {
    try {
      ws.send(msg);
    } catch {}
  }
}

module.exports = { attach, userDataChanged };
