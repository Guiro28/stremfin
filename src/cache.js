const { st } = require('./db');

// Cache a deux niveaux : memoire (rapide) + SQLite (survit aux redemarrages).
const mem = new Map();
const MEM_MAX = 5000;
const inflight = new Map();

function memSet(key, entry) {
  if (mem.has(key)) mem.delete(key);
  mem.set(key, entry);
  if (mem.size > MEM_MAX) mem.delete(mem.keys().next().value);
}

function peek(key) {
  let hit = mem.get(key);
  if (!hit) {
    const row = st.cacheGet.get(key);
    if (row) {
      hit = { v: JSON.parse(row.value), exp: row.expires };
      memSet(key, hit);
    }
  }
  return hit || null;
}

function put(key, value, ttl) {
  const entry = { v: value, exp: Date.now() + ttl };
  memSet(key, entry);
  st.cachePut.run(key, JSON.stringify(value), entry.exp);
}

/**
 * Renvoie la valeur en cache ou la calcule avec `fn` (appels simultanes dedoublonnes).
 * `stale` : pendant cette duree apres expiration, on renvoie l'ancienne valeur tout de suite
 * et on rafraichit en arriere-plan (l'app n'attend jamais un addon pour un ecran deja vu).
 * `ttl` et `stale` peuvent dependre de la valeur : (v) => duree.
 */
async function cached(key, ttl, fn, { stale = 0 } = {}) {
  const hit = peek(key);
  const now = Date.now();
  if (hit && hit.exp > now) return hit.v;
  const staleFor = hit && typeof stale === 'function' ? stale(hit.v) : stale;
  if (hit && staleFor && hit.exp + staleFor > now) {
    refresh(key, ttl, fn).catch(() => {});
    return hit.v;
  }
  return refresh(key, ttl, fn);
}

function refresh(key, ttl, fn) {
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => {
    try {
      const v = await fn();
      if (v !== undefined && v !== null) put(key, v, typeof ttl === 'function' ? ttl(v) : ttl);
      return v;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}

/**
 * Vide le cache des addons, de TMDB et de TheIntroDB (memoire + base). Les preferences
 * d'affichage des apps (dp|...), rangees dans la meme table, sont conservees.
 */
function clear() {
  for (const k of [...mem.keys()]) if (!k.startsWith('dp|')) mem.delete(k);
  require('./db').db.exec("DELETE FROM cache WHERE key NOT LIKE 'dp|%'");
}

module.exports = { cached, peek, put, clear };
