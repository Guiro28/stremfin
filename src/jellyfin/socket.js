// WebSocket /socket : les apps Jellyfin l'ouvrent pour le controle a distance.
// On se contente de le maintenir ouvert (KeepAlive) pour eviter les reconnexions en boucle.
const { WebSocketServer } = require('ws');
const { st } = require('../db');

function attach(server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const u = new URL(req.url, 'http://x');
    // Jellyfin : /socket ; apps Emby : /emby/embywebsocket.
    if (!/^\/(emby\/)?(socket|embywebsocket)\/?$/i.test(u.pathname)) return socket.destroy();
    const token = u.searchParams.get('api_key') || u.searchParams.get('ApiKey') || u.searchParams.get('apiKey');
    if (!token || !st.tokenGet.get(token)) return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws));
  });

  wss.on('connection', (ws) => {
    const send = (MessageType, Data) => ws.send(JSON.stringify({ MessageType, Data }));
    send('ForceKeepAlive', 60);
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.MessageType === 'KeepAlive') send('KeepAlive');
    });
  });
}

module.exports = { attach };
