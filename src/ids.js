const crypto = require('crypto');
const { st, transaction } = require('./db');

// Les apps Jellyfin exigent des ids au format GUID. On derive un UUID stable de chaque
// objet Stremio (ex: "item|movie|tt0111161") et on garde la correspondance en base.
const mem = new Map();
const MEM_MAX = 50000;

function uuidOf(key) {
  return crypto.createHash('sha1').update(key).digest('hex').slice(0, 32);
}

/** Accepte les GUID avec ou sans tirets, en majuscules ou minuscules. */
function norm(id) {
  return String(id || '').toLowerCase().replace(/[^0-9a-f]/g, '');
}

function remember(uuid, entry) {
  if (mem.has(uuid)) mem.delete(uuid);
  mem.set(uuid, entry);
  if (mem.size > MEM_MAX) mem.delete(mem.keys().next().value);
}

function get(id) {
  const uuid = norm(id);
  if (uuid.length !== 32) return null;
  let e = mem.get(uuid);
  if (!e) {
    const row = st.idGet.get(uuid);
    if (!row) return null;
    e = { uuid, key: row.key, kind: row.kind, data: JSON.parse(row.data), json: row.data };
    remember(uuid, e);
  }
  return e;
}

function clean(o) {
  const out = {};
  for (const [k, v] of Object.entries(o || {})) if (v !== undefined && v !== null && v !== '') out[k] = v;
  return out;
}

/** Enregistre (ou complete) un objet et renvoie son UUID. N'ecrit en base que si ca change. */
function register(key, kind, data) {
  const uuid = uuidOf(key);
  const cur = get(uuid);
  const merged = cur ? { ...cur.data, ...clean(data) } : clean(data);
  const json = JSON.stringify(merged);
  if (!cur || cur.json !== json || cur.kind !== kind) {
    st.idPut.run(uuid, key, kind, json);
    remember(uuid, { uuid, key, kind, data: merged, json });
  }
  return uuid;
}

/** Enregistre une liste [{key, kind, data}] en une seule transaction. */
function registerMany(list) {
  return transaction(() => list.map((x) => register(x.key, x.kind, x.data)));
}

module.exports = { uuidOf, norm, get, register, registerMany };
