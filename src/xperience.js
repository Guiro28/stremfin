// Catalogue d'avatars Xperience (repris de Nuvio Manager, server/xperience.js) : lu sur
// xperience-app.com (cache 5 min), avec une copie de secours dans xperience-avatars.json.
// Un avatar choisi est telecharge et garde comme avatar du profil (les apps le recoivent).
const config = require('./config');
const { request, readAll } = require('./http');
const avatars = require('./avatars');

const AVATARS_URL = 'https://xperience-app.com/api/avatars';
const CDN_HOST = 'cdn.xperience-app.com';
const CACHE_MS = 5 * 60e3;
let cache = null;
let fallback = null;

/** Seules les images https du CDN Xperience sont acceptees. */
function cleanUrl(value) {
  try {
    const url = new URL(String(value || ''));
    if (url.protocol !== 'https:' || url.hostname !== CDN_HOST) return null;
    return url.href;
  } catch {
    return null;
  }
}

function normalize(payload) {
  const rows = Array.isArray(payload?.avatars) ? payload.avatars : [];
  return rows
    .slice(0, 5000)
    .map((row, index) => ({
      id: String(row?.id || row?.slug || `avatar-${index}`),
      name: String(row?.name || row?.slug || 'Avatar').slice(0, 160),
      url: cleanUrl(row?.url),
      category: String(row?.category || 'Sans catégorie').trim().slice(0, 100) || 'Sans catégorie',
      sortOrder: Number.isFinite(Number(row?.sort_order)) ? Number(row.sort_order) : index
    }))
    .filter((a) => a.url)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
}

const result = (list, extra = {}) => ({
  avatars: list,
  categories: [...new Set(list.map((a) => a.category))].sort((a, b) => a.localeCompare(b, 'fr', { numeric: true, sensitivity: 'base' })),
  sourceUrl: 'https://xperience-app.com/avatars',
  ...extra
});

function fallbackCatalogue() {
  if (!fallback) fallback = result(normalize(require('./xperience-avatars.json')), { fallback: true });
  return fallback;
}

async function catalogue() {
  if (cache && cache.expiresAt > Date.now()) return cache.value;
  try {
    const { res } = await request(AVATARS_URL, { upstream: config.get().settings.upstream, timeout: 25000, headers: { accept: 'application/json', 'user-agent': 'Stremfin' } });
    if (res.statusCode !== 200) throw new Error(`Xperience : erreur ${res.statusCode}`);
    const list = normalize(JSON.parse((await readAll(res)).toString('utf8')));
    if (!list.length) throw new Error('Le catalogue Xperience est vide');
    cache = { value: result(list, { fallback: false }), expiresAt: Date.now() + CACHE_MS };
    return cache.value;
  } catch {
    return cache?.value || fallbackCatalogue();
  }
}

/** Telecharge un avatar Xperience et en fait l'avatar du profil. */
async function useAvatar(profile, url) {
  const clean = cleanUrl(url);
  if (!clean) throw new Error('Avatar Xperience invalide');
  const { res } = await request(clean, { upstream: config.get().settings.upstream, timeout: 20000 });
  if (res.statusCode !== 200) throw new Error(`Image injoignable (${res.statusCode})`);
  const declared = Number(res.headers['content-length']);
  if (declared > avatars.MAX_BYTES) {
    res.destroy();
    throw new Error('Image trop lourde (3 Mo max.)');
  }
  avatars.save(profile, await readAll(res));
}

module.exports = { catalogue, useAvatar };
