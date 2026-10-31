// Bibliotheque de collections : ajoutees a partir d'un fichier .json (format des collections
// Nuvio / Xperience, envoye ou lu a une adresse) et des addons qu'il cite, gardees une fois au
// niveau du serveur, puis attribuees aux profils. Pour les apps, chaque collection est une
// bibliotheque, ses dossiers des sous-dossiers, et chaque source d'un dossier (catalogue d'addon,
// decouverte TMDB, liste Trakt) un dossier de plus ; un dossier a une seule source montre
// directement ses titres.
// Le tout passe par un addon virtuel : pagination, anticipation et prechauffage de
// src/catalog.js s'appliquent sans changement.
const crypto = require('crypto');
const config = require('./config');
const cache = require('./cache');
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

/** Collection deja dans la bibliotheque (meme id dans le .json). */
function byRawId(rawId) {
  return all().find((c) => String(c.data?.id) === String(rawId)) || null;
}

/** Id Stremfin d'une nouvelle collection (sans separateurs de cle). */
function newId(rawId) {
  const base = String(rawId).replace(/[^\w-]/g, '').slice(0, 60) || crypto.randomBytes(6).toString('hex');
  let id = base;
  for (let n = 2; byId(id); n++) id = `${base}-${n}`;
  return id;
}

function revOf(data) {
  return crypto.createHash('sha1').update(JSON.stringify(data)).digest('hex').slice(0, 8);
}

/** Adresse sans son chemin (qui peut contenir un jeton) : pour l'interface et le journal. */
const hostOf = (u) => String(u || '').replace(/^(https?:\/\/[^/]+).*/, '$1/…');

/** Collections d'un .json : tableau, ou { collections: [...] }. */
function parseCollections(json) {
  let j = json;
  if (typeof j === 'string') {
    try {
      j = JSON.parse(j);
    } catch {
      throw new Error('Fichier .json illisible');
    }
  }
  const list = Array.isArray(j) ? j : Array.isArray(j?.collections) ? j.collections : null;
  if (!list) throw new Error("Ce n'est pas un fichier de collections");
  const out = list.filter((c) => c && c.id && Array.isArray(c.folders));
  if (!out.length) throw new Error('Aucune collection dans ce fichier');
  return out;
}

/** Collections lues dans le fichier envoye (json) ou a l'adresse du .json (jsonUrl). */
async function readCollections({ json, jsonUrl }) {
  if (jsonUrl) {
    if (!safeUrl(jsonUrl)) throw new Error('Adresse du .json invalide');
    let j;
    try {
      j = await getJson(jsonUrl, { upstream: config.get().settings.upstream, timeout: 20000 });
    } catch (e) {
      throw new Error(`.json injoignable : ${e.message}`);
    }
    return parseCollections(j);
  }
  if (json === undefined || json === null || json === '') throw new Error('Envoie un fichier .json ou donne son adresse');
  return parseCollections(json);
}

/** Adresses d'addons donnees dans l'interface (une par ligne), au format manifest.json. */
function addonList(urls) {
  const list = (Array.isArray(urls) ? urls : String(urls || '').split(/\s+/)).map((u) => String(u).trim()).filter(Boolean);
  return [...new Set(list)].map((u) => {
    try {
      return config.normalizeManifestUrl(u);
    } catch {
      throw new Error(`Adresse d'addon invalide : ${hostOf(u)}`);
    }
  });
}

/**
 * Addons cites par des collections (les sources ne donnent souvent que leur id) : cherches
 * parmi les adresses donnees, puis les addons deja connus (collections deja ajoutees, profils).
 * Renvoie { addons: { addonId: { url, name, catalogs } }, missing: [ids], errors: [messages] }.
 */
async function resolveAddons(addonUrls, raws) {
  const wanted = new Set();
  for (const raw of raws) {
    for (const f of raw.folders || []) {
      for (const src of f.sources || []) if ((src.provider || 'addon') === 'addon' && src.addonId && !safeUrl(src.addonBaseUrl)) wanted.add(src.addonId);
    }
  }
  const candidates = [...addonUrls];
  for (const c of all()) for (const [id, a] of Object.entries(c.addons || {})) if (wanted.has(id)) candidates.push(a.url);
  for (const p of config.get().profiles) for (const a of p.addons) if (wanted.has(a.manifest?.id)) candidates.push(a.url);
  const addons = {};
  const errors = [];
  await Promise.all(
    [...new Set(candidates)].map(async (url) => {
      try {
        const m = await getJson(url, { upstream: config.get().settings.upstream, timeout: 15000 });
        if (m?.id && wanted.has(m.id) && !addons[m.id]) {
          addons[m.id] = { url, name: String(m.name || m.id), catalogs: Object.fromEntries((m.catalogs || []).map((k) => [`${k.type}|${k.id}`, String(k.name || k.id)])) };
        }
      } catch (e) {
        if (addonUrls.includes(url)) errors.push(`Addon injoignable : ${hostOf(url)} (${e.message})`);
        log(`manifest KO ${hostOf(url)} : ${e.message}`);
      }
    })
  );
  return { addons, missing: [...wanted].filter((id) => !addons[id]), errors };
}

/** Ajoute ou met a jour une collection ; origin = { json: adresse du .json ou null, addonUrls }. */
function store(raw, addons, origin) {
  const now = Date.now();
  let c = byRawId(raw.id);
  if (!c) {
    c = { id: newId(raw.id), importedAt: now };
    all().push(c);
  }
  // Seulement les addons de cette collection (une adresse deja connue reste si l'addon ne repond pas).
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
  Object.assign(c, { title: String(raw.title || raw.name || 'Collection'), origin, data: raw, addons: used, rev: revOf({ raw, used }), updatedAt: now, missing: false });
  // Anciennes collections importees d'un compte Nuvio.
  delete c.nuvioProfile;
  delete c.nuvioProfileName;
  return c;
}

/** Apercu d'un .json avant l'ajout : ses collections et les addons manquants. */
async function preview(input) {
  const raws = await readCollections(input);
  const r = await resolveAddons(addonList(input.addonUrls), raws);
  return {
    collections: raws.map((raw) => ({
      rawId: String(raw.id),
      title: String(raw.title || raw.name || 'Collection'),
      folders: raw.folders.length,
      sources: raw.folders.reduce((n, f) => n + (f.sources?.length || 0), 0),
      backdrop: imageOf({ data: raw }),
      imported: !!byRawId(raw.id)
    })),
    addons: Object.values(r.addons).map((a) => a.name),
    missing: r.missing,
    errors: r.errors
  };
}

/** Ajoute (ou met a jour) les collections choisies d'un .json. Renvoie leurs ids. */
async function importFrom(input, rawIds) {
  const wanted = new Set((rawIds || []).map(String));
  const raws = (await readCollections(input)).filter((raw) => wanted.has(String(raw.id)));
  if (!raws.length) throw new Error('Aucune collection choisie');
  const addonUrls = addonList(input.addonUrls);
  const { addons } = await resolveAddons(addonUrls, raws);
  const origin = { json: input.jsonUrl ? String(input.jsonUrl) : null, addonUrls };
  const added = raws.map((raw) => store(raw, addons, origin).id);
  config.save();
  log(`${added.length} collection(s) ajoutee(s) depuis ${origin.json ? hostOf(origin.json) : 'un fichier .json'}`);
  return added;
}

/**
 * Met a jour les collections venues d'une adresse de .json (relue) ; celles qui n'y sont plus
 * restent, marquees. Les collections venues d'un fichier se mettent a jour en le renvoyant.
 */
async function refresh() {
  let updated = 0;
  let missing = 0;
  const errors = [];
  const groups = new Map();
  for (const c of all()) {
    if (!c.origin?.json) continue;
    if (!groups.has(c.origin.json)) groups.set(c.origin.json, []);
    groups.get(c.origin.json).push(c);
  }
  for (const [jsonUrl, list] of groups) {
    try {
      const raws = await readCollections({ jsonUrl });
      const addonUrls = [...new Set(list.flatMap((c) => c.origin.addonUrls || []))];
      const { addons } = await resolveAddons(addonUrls, raws);
      const found = new Map(raws.map((raw) => [String(raw.id), raw]));
      for (const c of list) {
        const raw = found.get(String(c.data.id));
        if (raw) {
          const rev = c.rev;
          if (store(raw, addons, c.origin).rev !== rev) updated++;
        } else if (!c.missing) {
          c.missing = true;
          missing++;
        }
      }
    } catch (e) {
      errors.push(`${hostOf(jsonUrl)} : ${e.message}`);
      log(`mise a jour KO ${hostOf(jsonUrl)} : ${e.message}`);
    }
  }
  config.save();
  if (groups.size) log(`mise a jour : ${updated} modifiee(s), ${missing} disparue(s)`);
  return { updated, missing, errors };
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

/** Image GIF (d'apres son adresse) : animee, mais ignoree par les apps Emby. */
function isGif(u) {
  try {
    return /\.gif$/i.test(new URL(u).pathname);
  } catch {
    return false;
  }
}

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

/** Image d'origine de la collection (.json) : son fond, sinon celui de son premier dossier. */
function nuvioImageOf(c) {
  const f = (c.data.folders || [])[0] || {};
  return safeUrl(c.data.backdropImageUrl) || safeUrl(f.heroBackdropUrl) || safeUrl(f.coverImageUrl);
}

/** Image de la bibliotheque ("Mes medias") : celle choisie dans l'interface, sinon celle du .json. */
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
  // Couverture (vignette), fond (page du dossier), GIF anime et logo fournis par la collection.
  const folders = (c.data.folders || []).map((f) => ({
    id: fid(f),
    title: String(f.title || ''),
    cover: safeUrl(f.coverImageUrl),
    hero: safeUrl(f.heroBackdropUrl),
    gif: f.focusGifEnabled === false ? null : safeUrl(f.focusGifUrl),
    logo: safeUrl(f.titleLogoUrl),
    shape: String(f.tileShape || shape).toUpperCase()
  }));
  return Promise.all(
    folders.map(async (f) => {
      let own = customImage(c, f.id);
      // Image choisie dans l'interface qui est un GIF : traitee comme le GIF du dossier.
      let gif = f.gif;
      if (own && isGif(own)) {
        gif = own;
        own = null;
      }
      let poster = own || f.cover;
      // Fond : le GIF anime (les apps Emby l'affichent derriere), sinon l'image de fond.
      let background = own || gif || f.hero || f.cover;
      if (!poster) {
        // Sans image de couverture : celle du premier titre du dossier.
        const first = await Promise.race([slice(folderView(c.id, f.id), 0, 1).then((r) => r.metas[0]), new Promise((r) => setTimeout(r, 5000))]).catch(() => null);
        poster = f.shape === 'LANDSCAPE' ? f.hero || first?.background || first?.poster : first?.poster;
        background = gif || f.hero || first?.background || first?.poster;
      }
      return { id: `colf:${c.id}:${f.id}`, type: 'colfolder', name: f.title, poster, background, gif: gif || undefined, logo: f.logo, colId: c.id, folderId: f.id, shape: f.shape, fr: true };
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
    // Origine : adresse du .json (relue toutes les 6 h), fichier .json, ou ancien import Nuvio.
    origin: c.origin?.json ? { kind: 'url', host: hostOf(c.origin.json) } : c.origin ? { kind: 'file' } : { kind: 'nuvio' },
    backdrop: imageOf(c),
    pinned: !!c.data.pinToTop,
    // Image de la tuile : choisie ici (image), sinon celle du .json (nuvioImage).
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

module.exports = { ADDON_URL, imageTarget, list, preview, importFrom, refresh, remove, assign, start, addon, folderView, subfolders, sourceViewOf, warmViews, catalog, byId };
