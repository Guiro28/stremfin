const config = require('./config');
const cache = require('./cache');
const { getJson } = require('./http');

const HOUR = 3600e3;

function upstream() {
  return config.get().settings.upstream;
}

/**
 * Sortie reseau d'un addon de profil selon son mode : proxy externe en mode "warp",
 * IP du serveur sinon (mode "direct", ou "none" ou seule la video est lue par l'app).
 */
function netOf(a) {
  return a.mode === 'warp' ? upstream() : undefined;
}

/** Nom affiche d'un addon : celui choisi dans la bibliotheque, sinon celui du manifest. */
function nameOf(a) {
  return a.name || a.manifest?.name || a.url;
}

function baseOf(manifestUrl) {
  return String(manifestUrl).replace(/\/manifest\.json(\?.*)?$/, '');
}

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

// ---- Manifests --------------------------------------------------------------

async function fetchManifest(url) {
  const m = await getJson(url, { upstream: upstream(), timeout: 15000 });
  if (!m || !m.id) throw new Error('Manifest invalide');
  return m;
}

/**
 * Recharge le manifest des addons de la bibliotheque qui n'en ont pas encore (ou de tous si
 * force) ; avec un profil, seulement ceux de ce profil. Les profils suivent a l'enregistrement.
 */
async function refreshManifests(profile = null, force = false) {
  const used = profile && new Set(profile.addons.map((a) => a.lib));
  let changed = false;
  await Promise.all(
    config
      .get()
      .addons.filter((l) => !used || used.has(l.id))
      .map(async (l) => {
        if (l.manifest && !force) return;
        try {
          l.manifest = await fetchManifest(l.url);
          changed = true;
        } catch (e) {
          log(`[addon] manifest KO ${l.url}: ${e.message}`);
        }
      })
  );
  if (changed) config.save();
}

/** L'addon gere-t-il cette ressource (catalog/meta/stream/subtitles) pour ce type/id ? */
function supports(manifest, resource, type, id) {
  if (!manifest) return false;
  for (const r of manifest.resources || []) {
    const name = typeof r === 'string' ? r : r?.name;
    if (name !== resource) continue;
    const types = (typeof r === 'object' && r.types) || manifest.types || [];
    if (type && !types.includes(type)) continue;
    const prefixes = (typeof r === 'object' && r.idPrefixes) || manifest.idPrefixes;
    if (id && Array.isArray(prefixes) && prefixes.length && !prefixes.some((p) => id.startsWith(p))) continue;
    return true;
  }
  return false;
}

function enabledAddons(profile) {
  return profile.addons.filter((a) => a.manifest && a.enabled !== false);
}

// ---- Ressources -------------------------------------------------------------

function extraPath(extra) {
  const parts = Object.entries(extra || {})
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
  return parts.length ? '/' + parts.join('&') : '';
}

function resourceUrl(manifestUrl, resource, type, id, extra) {
  return `${baseOf(manifestUrl)}/${resource}/${encodeURIComponent(type)}/${encodeURIComponent(id)}${extraPath(extra)}.json`;
}

/**
 * Une page de catalogue. Cache 1 h, puis servie "perimee" jusqu'a 24 h pendant le rafraichissement.
 * Page vide : gardee 2 min seulement, jamais servie perimee (certains addons repondent vide le
 * temps de preparer une liste).
 */
function catalog(manifestUrl, type, id, extra) {
  // Catalogues TMDB integres (addon virtuel) : ils ont leur propre cache.
  if (manifestUrl === require('./tmdb').ADDON_URL) return require('./tmdb').catalog(type, id, extra);
  // Collections (bibliotheque du serveur) : addon virtuel elles aussi.
  if (manifestUrl === require('./collections').ADDON_URL) return require('./collections').catalog(type, id, extra);
  const url = resourceUrl(manifestUrl, 'catalog', type, id, extra);
  return cache.cached(
    'cat|' + url,
    (r) => (r.metas.length ? HOUR : 2 * 60e3),
    async () => {
      const r = await getJson(url, { upstream: upstream() });
      return { metas: Array.isArray(r?.metas) ? r.metas : [] };
    },
    { stale: (r) => (r.metas.length ? 24 * HOUR : 0) }
  );
}

/** Fiche complete : premier addon du profil qui sait la fournir. */
async function meta(profile, type, id) {
  for (const a of enabledAddons(profile)) {
    if (!supports(a.manifest, 'meta', type, id)) continue;
    const url = resourceUrl(a.url, 'meta', type, id);
    try {
      const r = await cache.cached(
        'meta|' + url,
        12 * HOUR,
        async () => {
          const j = await getJson(url, { upstream: netOf(a) });
          return j?.meta ? { meta: j.meta } : null;
        },
        { stale: 7 * 24 * HOUR }
      );
      if (r?.meta) return r.meta;
    } catch (e) {
      log(`[addon] meta KO ${nameOf(a)} ${type}/${id}: ${e.message}`);
    }
  }
  return null;
}

/**
 * Sources de tous les addons du profil, interrogees en parallele.
 * `ids` : identifiants equivalents par ordre de preference (ex: tt..., tmdb:...) ;
 * chaque addon recoit le premier qu'il sait traiter.
 * Renvoie [{ addon, addonLogo, mode, stream }] dans l'ordre des addons. Cache 30 min.
 */
async function streams(profile, type, ids) {
  const timeout = config.get().settings.streamTimeout;
  const candidates = [].concat(ids).filter(Boolean);
  const results = await Promise.all(
    enabledAddons(profile).map(async (a) => {
      const id = candidates.find((x) => supports(a.manifest, 'stream', type, x));
      if (!id) return [];
      const url = resourceUrl(a.url, 'stream', type, id);
      try {
        const r = await cache.cached('stream|' + url, 30 * 60e3, async () => {
          const t0 = Date.now();
          const j = await getJson(url, { upstream: netOf(a), timeout });
          const list = Array.isArray(j?.streams) ? j.streams : [];
          log(`[addon] ${nameOf(a)} ${type}/${id}: ${list.length} source(s) en ${Date.now() - t0} ms`);
          // On ne met pas en cache une reponse vide : l'addon peut avoir eu un raté.
          return list.length ? { streams: list } : null;
        });
        return (r?.streams || []).map((stream) => ({ addon: nameOf(a), addonLogo: a.manifest.logo || null, mode: a.mode, stream }));
      } catch (e) {
        log(`[addon] streams KO ${nameOf(a)} ${type}/${id}: ${e.message}`);
        return [];
      }
    })
  );
  return results.flat();
}

/** Sous-titres (addons "subtitles", ex: OpenSubtitles). */
async function subtitles(profile, type, ids, extra) {
  const candidates = [].concat(ids).filter(Boolean);
  const results = await Promise.all(
    enabledAddons(profile).map(async (a) => {
      const id = candidates.find((x) => supports(a.manifest, 'subtitles', type, x));
      if (!id) return [];
      const url = resourceUrl(a.url, 'subtitles', type, id, extra);
      try {
        const r = await cache.cached('subs|' + url, 6 * HOUR, async () => {
          const j = await getJson(url, { upstream: netOf(a), timeout: 10000 });
          return { subtitles: Array.isArray(j?.subtitles) ? j.subtitles : [] };
        });
        return r.subtitles.map((s) => ({ addon: nameOf(a), sub: s }));
      } catch {
        return [];
      }
    })
  );
  return results.flat();
}

module.exports = {
  baseOf,
  nameOf,
  fetchManifest,
  refreshManifests,
  supports,
  enabledAddons,
  catalog,
  meta,
  streams,
  subtitles
};
