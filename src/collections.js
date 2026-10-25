// Bibliotheque de collections : importees d'un compte Nuvio (lecture seule), gardees une fois
// au niveau du serveur, puis attribuees aux profils. Pour les apps, chaque collection est une
// bibliotheque, ses dossiers des sous-dossiers, et chaque source d'un dossier (catalogue d'addon,
// decouverte TMDB, liste Trakt) un dossier de plus ; un dossier a une seule source montre
// directement ses titres.
// Le tout passe par un addon virtuel : pagination, anticipation et prechauffage de
// src/catalog.js s'appliquent sans changement.
const crypto = require('crypto');
const config = require('./config');
const cache = require('./cache');
const nuvio = require('./nuvio');
const { getJson } = require('./http');

const ADDON_URL = 'stremfin://collections';
const PAGE = 50;
const MAX_ITEMS = 2000;
const REFRESH_EVERY = 6 * 3600e3;
const HOUR = 3600e3;

function log(...args) {
  console.log(new Date().toISOString(), '[collections]', ...args);
}

// ---- Bibliotheque ----------------------------------------------------------------------------

function all() {
  return config.get().collections;
}

function byId(id) {
  return all().find((c) => c.id === id) || null;
}

/** Id Stremfin d'une collection : profil Nuvio + id Nuvio (sans separateurs de cle). */
function idOf(profileIndex, rawId) {
  return `${profileIndex}-${String(rawId).replace(/[^\w-]/g, '')}`;
}

function revOf(data) {
  return crypto.createHash('sha1').update(JSON.stringify(data)).digest('hex').slice(0, 8);
}

/**
 * Adresse des addons cites par des collections : les sources Nuvio ne donnent souvent que
 * l'id de l'addon ; on le retrouve parmi les addons du profil Nuvio (manifest lu une fois).
 * Renvoie { addonId: { url, name, catalogs: { "type|id": nom } } }.
 */
async function resolveAddons(profileIndex, raws) {
  const wanted = new Set();
  for (const raw of raws) for (const f of raw.folders || []) for (const src of f.sources || []) if ((src.provider || 'addon') === 'addon' && src.addonId && !safeUrl(src.addonBaseUrl)) wanted.add(src.addonId);
  if (!wanted.size) return {};
  const out = {};
  const rows = await nuvio.addons(profileIndex);
  await Promise.all(
    rows.map(async (r) => {
      try {
        const url = config.normalizeManifestUrl(r.url);
        const m = await getJson(url, { upstream: config.get().settings.upstream, timeout: 10000 });
        if (m?.id && wanted.has(m.id)) out[m.id] = { url, name: String(m.name || r.name || m.id), catalogs: Object.fromEntries((m.catalogs || []).map((k) => [`${k.type}|${k.id}`, String(k.name || k.id)])) };
      } catch (e) {
        log(`manifest KO ${String(r.url).replace(/^(https?:\/\/[^/]+).*/, '$1/…')} : ${e.message}`);
      }
    })
  );
  return out;
}

function store(profile, raw, addons = {}) {
  const id = idOf(profile.index, raw.id);
  const now = Date.now();
  let c = byId(id);
  if (!c) {
    c = { id, importedAt: now };
    all().push(c);
  }
  // Seulement les addons de cette collection (une adresse deja connue reste si Nuvio ne repond pas).
  const used = {};
  for (const f of raw.folders || []) {
    for (const src of f.sources || []) {
      const a = addons[src.addonId] || c.addons?.[src.addonId];
      if (!src.addonId || !a) continue;
      // Noms des seuls catalogues utilises (pour l'interface).
      const key = `${src.type}|${src.catalogId}`;
      used[src.addonId] ??= { url: a.url, name: a.name, catalogs: {} };
      if (a.catalogs?.[key]) used[src.addonId].catalogs[key] = a.catalogs[key];
    }
  }
  Object.assign(c, { title: String(raw.title || raw.name || 'Collection'), nuvioProfile: profile.index, nuvioProfileName: profile.name, data: raw, addons: used, rev: revOf({ raw, used }), updatedAt: now, missing: false });
  return c;
}

/** Collections d'un profil Nuvio, avec celles deja dans la bibliotheque. */
async function available(profileIndex) {
  const list = await nuvio.collections(profileIndex);
  return list.map((raw) => ({
    rawId: String(raw.id),
    title: String(raw.title || raw.name || 'Collection'),
    folders: raw.folders.length,
    sources: raw.folders.reduce((n, f) => n + (f.sources?.length || 0), 0),
    backdrop: imageOf({ data: raw }),
    imported: !!byId(idOf(profileIndex, raw.id))
  }));
}

/** Ajoute (ou met a jour) des collections d'un profil Nuvio dans la bibliotheque. */
async function importFrom(profileIndex, rawIds) {
  const profile = (await nuvio.profiles()).find((p) => p.index === Number(profileIndex));
  if (!profile) throw new Error('Profil Nuvio introuvable');
  const wanted = new Set((rawIds || []).map(String));
  const raws = (await nuvio.collections(profile.index)).filter((raw) => wanted.has(String(raw.id)));
  const addons = await resolveAddons(profile.index, raws);
  const added = raws.map((raw) => store(profile, raw, addons).id);
  config.save();
  log(`${added.length} collection(s) importee(s) du profil Nuvio "${profile.name}"`);
  return added;
}

/** Met a jour toutes les collections depuis Nuvio ; celles disparues restent, marquees. */
async function refresh() {
  if (!nuvio.status().linked || !all().length) return { updated: 0, missing: 0 };
  const profiles = await nuvio.profiles();
  let updated = 0;
  let missing = 0;
  for (const index of [...new Set(all().map((c) => c.nuvioProfile))]) {
    const profile = profiles.find((p) => p.index === index);
    const list = profile ? await nuvio.collections(index) : [];
    const found = new Map(list.map((raw) => [idOf(index, raw.id), raw]));
    const addons = await resolveAddons(index, list.filter((raw) => byId(idOf(index, raw.id))));
    for (const c of all().filter((x) => x.nuvioProfile === index)) {
      const raw = found.get(c.id);
      if (raw) {
        const rev = c.rev;
        if (store(profile, raw, addons).rev !== rev) updated++;
      } else if (!c.missing) {
        c.missing = true;
        missing++;
      }
    }
  }
  config.save();
  log(`mise a jour : ${updated} modifiee(s), ${missing} disparue(s) chez Nuvio`);
  return { updated, missing };
}

function remove(id) {
  const c = byId(id);
  if (c) require('./libraryImages').clearCollectionAll(c);
  const before = all().length;
  config.get().collections = all().filter((c) => c.id !== id);
  if (all().length === before) return false;
  for (const p of config.get().profiles) p.collections = (p.collections || []).filter((x) => x !== id);
  config.save();
  return true;
}

/** Attribue une collection a la liste de profils donnee (et la retire des autres). */
function assign(id, profileIds) {
  if (!byId(id)) return false;
  const keep = new Set((profileIds || []).map(String));
  for (const p of config.get().profiles) {
    const list = (p.collections || []).filter((x) => x !== id);
    if (keep.has(p.id)) list.push(id);
    p.collections = list;
  }
  config.save();
  return true;
}

let timer = null;
function start() {
  clearTimeout(timer);
  const run = () => {
    refresh()
      .catch((e) => log(`mise a jour KO : ${e.message}`))
      .finally(() => {
        timer = setTimeout(run, REFRESH_EVERY);
        timer.unref();
      });
  };
  timer = setTimeout(run, 5 * 60e3);
  timer.unref();
}

// ---- Sources ----------------------------------------------------------------------------------

function safeUrl(u) {
  return /^https?:\/\/\S+$/i.test(String(u || '')) ? String(u) : null;
}

/** Adresse du manifest d'une source "addon" : donnee par la source, trouvee chez Nuvio, ou l'addon de meme id d'un profil. */
function addonManifestUrl(src, c) {
  if (c?.addons?.[src.addonId]) return c.addons[src.addonId].url;
  const base = safeUrl(src.addonBaseUrl);
  if (base) return base.replace(/\/manifest\.json(\?.*)?$/, '').replace(/\/+$/, '') + '/manifest.json';
  for (const p of config.get().profiles) {
    const a = p.addons.find((x) => x.manifest?.id && x.manifest.id === src.addonId);
    if (a) return a.url;
  }
  return null;
}

// Id de dossier sur dans les ids de catalogue (":" y sert de separateur).
const fid = (f) => encodeURIComponent(String(f.id));

const mediaTypeOf = (src) => (String(src.mediaType || '').toUpperCase() === 'TV' ? 'series' : 'movie');

/** Catalogue (au sens de src/catalog.js) d'une source, ou null si inutilisable. */
function sourceView(c, folderId, i, src) {
  const provider = src.provider || 'addon';
  if (provider === 'addon') {
    const url = addonManifestUrl(src, c);
    if (!url || !src.type || !src.catalogId) return null;
    const genre = src.genre && src.genre !== 'None' ? String(src.genre) : undefined;
    return { key: `csrc|${url}|${src.type}|${src.catalogId}|${genre || ''}`, addonUrl: url, type: src.type, catId: src.catalogId, hasSkip: true, defaultGenre: genre };
  }
  if (provider === 'tmdb' || provider === 'trakt') {
    return { key: `csrc|${c.id}|${c.rev}|${folderId}|${i}`, addonUrl: ADDON_URL, type: mediaTypeOf(src), catId: `src:${c.id}:${folderId}:${i}`, hasSkip: true };
  }
  return null;
}

/** Sources utilisables d'un dossier, sans doublons : [{ index, src, view }]. */
function folderCatalogs(c, folderId) {
  const f = (c.data.folders || []).find((x) => fid(x) === folderId);
  const out = [];
  const seen = new Set();
  (f?.sources || []).forEach((src, index) => {
    const view = sourceView(c, folderId, index, src);
    if (view && !seen.has(view.key)) {
      seen.add(view.key);
      out.push({ index, src, view });
    }
  });
  return out;
}

const folderSources = (c, folderId) => folderCatalogs(c, folderId).map((x) => x.view);

/** Nom d'un catalogue de source (nom du manifest de l'addon de preference). */
function catalogName(c, src) {
  if (src.provider === 'tmdb' || src.provider === 'trakt') return String(src.title || (src.provider === 'tmdb' ? 'TMDB' : 'Trakt'));
  return String(src.title || src.catalogName || c.addons?.[src.addonId]?.catalogs?.[`${src.type}|${src.catalogId}`] || src.catalogId);
}

/** Page d'une liste Trakt (identifiant d'app Trakt requis : Reglages -> Metadonnees). */
async function traktPage(src, skip) {
  const key = config.get().settings.traktClientId;
  const listId = Number(src.traktListId);
  if (!key || !listId) return { metas: [] };
  const kind = mediaTypeOf(src) === 'series' ? 'show' : 'movie';
  const page = Math.floor(skip / PAGE) + 1;
  const url = `https://api.trakt.tv/lists/${listId}/items/${kind}?page=${page}&limit=${PAGE}`;
  const items = await cache.cached(
    'trakt|' + url,
    6 * HOUR,
    () => getJson(url, { headers: { 'trakt-api-key': key, 'trakt-api-version': '2', 'content-type': 'application/json' } }),
    { stale: 3 * 24 * HOUR }
  );
  const list = (Array.isArray(items) ? items : []).map((x) => x[kind]).filter(Boolean);
  if (src.sortHow === 'desc') list.reverse();
  return {
    metas: list
      .map((m) => ({ id: m.ids?.imdb || (m.ids?.tmdb ? `tmdb:${m.ids.tmdb}` : null), type: mediaTypeOf(src), name: m.title, releaseInfo: m.year ? String(m.year) : undefined }))
      .filter((m) => m.id)
  };
}

// ---- Addon virtuel ------------------------------------------------------------------------------

/** Image choisie dans l'interface pour un dossier ("dossier") ou un sous-dossier ("dossier:n"). */
const customImage = (c, target) => c.images?.[target]?.image || null;

/** Image Nuvio de la collection : son fond, sinon celui de son premier dossier. */
function nuvioImageOf(c) {
  const f = (c.data.folders || [])[0] || {};
  return safeUrl(c.data.backdropImageUrl) || safeUrl(f.heroBackdropUrl) || safeUrl(f.coverImageUrl);
}

/** Image de la bibliotheque ("Mes medias") : celle choisie dans l'interface, sinon celle de Nuvio. */
function imageOf(c) {
  return c.image || nuvioImageOf(c);
}

function shapeOf(c) {
  const shapes = (c.data.folders || []).map((f) => String(f.tileShape || 'POSTER').toUpperCase());
  return shapes.length && shapes.every((s) => s === 'LANDSCAPE') ? 'LANDSCAPE' : shapes[0] || 'POSTER';
}

/** Collections du profil, comme un addon a un catalogue par collection (pour src/catalog.js). */
function addon(profile) {
  const list = (profile.collections || []).map(byId).filter(Boolean);
  if (!list.length) return [];
  return [
    {
      url: ADDON_URL,
      manifest: {
        id: 'stremfin.collections',
        name: 'Collections',
        version: '1.0.0',
        resources: ['catalog'],
        types: ['nuviocol'],
        catalogs: list.map((c) => ({
          type: 'nuviocol',
          id: `col:${c.id}`,
          name: c.title,
          plainName: true,
          pinned: !!c.data.pinToTop,
          image: imageOf(c),
          extra: [{ name: 'skip' }]
        }))
      }
    }
  ];
}

/** Catalogue d'un dossier (sous-dossier d'une collection dans les apps). */
function folderView(colId, folderId) {
  const c = byId(colId);
  return { key: `colf|${colId}|${c?.rev || ''}|${folderId}`, addonUrl: ADDON_URL, type: 'movie', catId: `colf:${colId}:${folderId}`, hasSkip: true };
}

/** Dossiers d'une collection, avec leur image. */
async function folderMetas(c) {
  const { slice } = require('./catalog');
  const shape = shapeOf(c);
  // Couverture (vignette), fond (page du dossier) et logo fournis par la collection.
  const folders = (c.data.folders || []).map((f) => ({ id: fid(f), title: String(f.title || ''), cover: safeUrl(f.coverImageUrl), hero: safeUrl(f.heroBackdropUrl), logo: safeUrl(f.titleLogoUrl), shape: String(f.tileShape || shape).toUpperCase() }));
  return Promise.all(
    folders.map(async (f) => {
      const own = customImage(c, f.id);
      let poster = own || f.cover;
      let background = own || f.hero || f.cover;
      if (!poster) {
        // Sans image de couverture : celle du premier titre du dossier.
        const first = await Promise.race([slice(folderView(c.id, f.id), 0, 1).then((r) => r.metas[0]), new Promise((r) => setTimeout(r, 5000))]).catch(() => null);
        poster = f.shape === 'LANDSCAPE' ? f.hero || first?.background || first?.poster : first?.poster;
        background = f.hero || first?.background || first?.poster;
      }
      return { id: `colf:${c.id}:${f.id}`, type: 'colfolder', name: f.title, poster, background, logo: f.logo, colId: c.id, folderId: f.id, shape: f.shape, fr: true };
    })
  );
}

/** Premier titre d'une liste (pour l'image d'un dossier), sans attendre plus de 5 s. */
function firstOf(view) {
  const { slice } = require('./catalog');
  return Promise.race([slice(view, 0, 1).then((r) => r.metas[0]), new Promise((r) => setTimeout(r, 5000))]).catch(() => null);
}

/**
 * Sous-dossiers d'un dossier : un par catalogue ("Disney+ · Films"), avec l'image de son
 * premier titre. null si le dossier n'a qu'une source : ses titres s'affichent directement.
 */
async function subfolders(colId, folderId) {
  const c = byId(colId);
  const list = c ? folderCatalogs(c, folderId) : [];
  if (list.length < 2) return null;
  const { label } = require('./catalog');
  return Promise.all(
    list.map(async ({ index, src, view }) => {
      const own = customImage(c, `${folderId}:${index}`);
      const first = own ? null : await firstOf(view);
      const image = own || first?.background || first?.poster;
      return { id: `colc:${colId}:${folderId}:${index}`, type: 'colcat', name: `${catalogName(c, src)} · ${label(view.type)}`, poster: image, background: image, colId, folderId, srcIndex: index, shape: 'LANDSCAPE', fr: true };
    })
  );
}

/** Liste d'un sous-dossier (une source). */
function sourceViewOf(colId, folderId, index) {
  const c = byId(colId);
  return (c && folderCatalogs(c, folderId).find((x) => x.index === Number(index))?.view) || null;
}

/** Listes a preparer en arriere-plan pour une collection (dossiers ou leurs sous-dossiers). */
function warmViews(c) {
  return (c.data.folders || []).flatMap((f) => {
    const list = folderCatalogs(c, fid(f));
    return list.length === 1 ? [folderView(c.id, fid(f))] : list.map((x) => x.view);
  });
}

/**
 * Contenu d'un dossier : ses sources fusionnees en alternance, sans doublons.
 * partial : une source n'a rien donne (addon qui prepare encore sa liste), a refaire bientot.
 */
async function folderPage(c, folderId, skip) {
  const { slice } = require('./catalog');
  const views = folderSources(c, folderId);
  if (!views.length) return { metas: [] };
  const want = skip + PAGE;
  let per = Math.ceil(want / views.length) + 10;
  for (;;) {
    const lists = await Promise.all(views.map((v) => slice(v, 0, per).then((r) => r.metas, () => [])));
    const merged = [];
    const seen = new Set();
    const longest = Math.max(...lists.map((l) => l.length));
    for (let i = 0; i < longest; i++) {
      for (const l of lists) {
        const m = l[i];
        if (!m?.id || seen.has(m.id)) continue;
        seen.add(m.id);
        merged.push(m);
      }
    }
    // Assez de titres, ou toutes les sources epuisees : on rend la page.
    if (merged.length >= want || lists.every((l) => l.length < per) || per >= MAX_ITEMS) return { metas: merged.slice(skip, want), partial: lists.some((l) => !l.length) };
    per = Math.min(MAX_ITEMS, per * 2);
  }
}

/** Point d'entree de l'addon virtuel (appele par stremio.catalog). */
async function catalog(type, id, extra = {}) {
  const skip = Number(extra.skip) || 0;
  const [kind, colId, folderId, index] = String(id).split(':');
  const c = byId(colId);
  if (!c) return { metas: [] };
  if (kind === 'col') return { metas: skip ? [] : await folderMetas(c) };
  if (kind === 'colf') return folderPage(c, folderId, skip);
  if (kind === 'src') {
    const src = (c.data.folders || []).find((f) => fid(f) === folderId)?.sources?.[Number(index)];
    if (src?.provider === 'tmdb') return require('./tmdb').collectionSource(src, skip);
    if (src?.provider === 'trakt') return traktPage(src, skip);
  }
  return { metas: [] };
}

// ---- Pour l'interface -------------------------------------------------------------------------

function sourceLabel(src, c) {
  const provider = src.provider || 'addon';
  if (provider === 'tmdb') return { provider, label: src.title || 'TMDB' };
  if (provider === 'trakt') return { provider, label: src.title || `#${src.traktListId}`, needsKey: !config.get().settings.traktClientId };
  let host = '';
  try {
    host = new URL(addonManifestUrl(src, c) || '').hostname;
  } catch {}
  const genre = src.genre && src.genre !== 'None' ? ` · ${src.genre}` : '';
  const a = c.addons?.[src.addonId];
  const name = src.addonName || a?.name || host || src.addonId || 'Addon';
  const catalog = src.title || src.catalogName || a?.catalogs?.[`${src.type}|${src.catalogId}`] || src.catalogId;
  return { provider, label: `${name} · ${catalog}${genre}`, type: src.type, broken: !addonManifestUrl(src, c) };
}

function describe(c) {
  return {
    id: c.id,
    title: c.title,
    nuvioProfile: c.nuvioProfileName,
    backdrop: imageOf(c),
    pinned: !!c.data.pinToTop,
    // Image de la tuile : choisie ici (image), sinon celle de Nuvio (nuvioImage).
    image: c.image || null,
    nuvioImage: nuvioImageOf(c),
    missing: !!c.missing,
    updatedAt: c.updatedAt,
    folders: (c.data.folders || []).map((f) => {
      const id = fid(f);
      // Sous-dossiers seulement si le dossier a plusieurs sources (sinon : titres directement).
      const subs = folderCatalogs(c, id).length > 1;
      return {
        id,
        title: String(f.title || ''),
        shape: String(f.tileShape || 'POSTER').toUpperCase(),
        image: customImage(c, id),
        nuvioImage: safeUrl(f.coverImageUrl) || safeUrl(f.heroBackdropUrl),
        subfolders: subs,
        sources: (f.sources || []).map((src, i) => ({ ...sourceLabel(src, c), index: i, image: subs ? customImage(c, `${id}:${i}`) : null }))
      };
    }),
    profiles: config.get().profiles.filter((p) => (p.collections || []).includes(c.id)).map((p) => p.id)
  };
}

function list() {
  return all().map(describe);
}

/** La cible d'image existe-t-elle ? ("" collection, "dossier", "dossier:n" sous-dossier) */
function imageTarget(c, target) {
  if (!target) return true;
  const [folder, index] = String(target).split(':');
  const list = folderCatalogs(c, folder);
  if (!(c.data.folders || []).some((f) => fid(f) === folder)) return false;
  return index === undefined || (list.length > 1 && list.some((x) => x.index === Number(index)));
}

module.exports = { ADDON_URL, imageTarget, list, available, importFrom, refresh, remove, assign, start, addon, folderView, subfolders, sourceViewOf, warmViews, catalog, byId };
