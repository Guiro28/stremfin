// Films et series des sources IPTV (VOD), sur le modele de Polyfin (docs/iptv-movies-and-series.md) :
//   - index en base (table iptv_vod) rempli a chaque telechargement : films et series d'un compte
//     Xtream (get_vod_streams, get_series), films et episodes d'une liste M3U ;
//   - bibliotheques "Films" et "Series" par source (addon virtuel stremfin-iptv://<source>) quand
//     l'option de la source est cochee ; titre avec id TMDB = fiche TMDB, sinon fiche du fournisseur ;
//   - recherche de secours : quand les addons Stremio ne trouvent aucune source pour un film ou un
//     episode, il est cherche dans la VOD des sources du profil (id TMDB / IMDb, sinon nom et annee).
const crypto = require('crypto');
const { db, transaction } = require('../db');
const config = require('../config');
const cache = require('../cache');
const fetchIptv = require('./fetch');
const xtream = require('./xtream');

function log(...args) {
  console.log(new Date().toISOString(), '[vod]', ...args);
}

db.exec(`
  CREATE TABLE IF NOT EXISTS iptv_vod (
    source   TEXT NOT NULL,
    kind     TEXT NOT NULL,
    id       TEXT NOT NULL,
    name     TEXT NOT NULL,
    norm     TEXT NOT NULL,
    year     INTEGER,
    tmdb     TEXT,
    imdb     TEXT,
    category TEXT,
    poster   TEXT,
    plot     TEXT,
    ext      TEXT,
    url      TEXT,
    series   TEXT,
    season   INTEGER,
    episode  INTEGER,
    added    INTEGER,
    PRIMARY KEY (source, kind, id)
  );
  CREATE INDEX IF NOT EXISTS iptv_vod_norm ON iptv_vod (kind, norm);
  CREATE INDEX IF NOT EXISTS iptv_vod_tmdb ON iptv_vod (kind, tmdb);
  CREATE INDEX IF NOT EXISTS iptv_vod_imdb ON iptv_vod (kind, imdb);
  CREATE INDEX IF NOT EXISTS iptv_vod_cat ON iptv_vod (source, kind, category, added);
  CREATE INDEX IF NOT EXISTS iptv_vod_series ON iptv_vod (source, series, season, episode);
`);

// Recherche TMDB deja faite pour ce titre (date) : pas refaite a chaque mise a jour de la liste.
try {
  db.exec('ALTER TABLE iptv_vod ADD COLUMN checked INTEGER');
} catch {}

const q = {
  del: db.prepare('DELETE FROM iptv_vod WHERE source = ?'),
  put: db.prepare(`INSERT OR REPLACE INTO iptv_vod (source, kind, id, name, norm, year, tmdb, imdb, category, poster, plot, ext, url, series, season, episode, added)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  one: db.prepare('SELECT * FROM iptv_vod WHERE source = ? AND kind = ? AND id = ?'),
  counts: db.prepare('SELECT kind, COUNT(*) AS n FROM iptv_vod WHERE source = ? GROUP BY kind'),
  categories: db.prepare('SELECT category, COUNT(*) AS n FROM iptv_vod WHERE source = ? AND kind = ? AND category IS NOT NULL GROUP BY category ORDER BY category')
};

// ---- Noms : normalisation, annee, saison / episode ------------------------------------------

const TAGS = /\b(multi|vostfr|vost|vf|vff|vfq|vf2|truefrench|french|english|4k|uhd|fhd|hd|sd|1080p|720p|2160p|hdr|hdr10|hevc|x264|x265|h\.?264|h\.?265|web-?dl|webrip|bluray|dvdrip|imax|remux|exclu)\b/gi;

// Prefixe pays / langue d'une liste IPTV : "|FR| ", "FR| ", "FR: ", "[FR] ", "FR - " (en
// majuscules : "Dune: Part Two" ou "Alien - ..." ne sont pas touches).
const PREFIX_RE = /^\s*(\|[^|]{1,8}\|\s*|\[[^\]]{1,12}\]\s*|[A-Z]{2,3}(?:-[A-Z]{2})?\s*\|\s*|[A-Z]{2}\s*:\s+|[A-Z]{2,3}\s+-\s+)/;

/** "|FR| After Life 2019 FHD MULTI" -> "After Life" (nom affiche et cherche dans TMDB). */
function cleanTitle(s) {
  const out = String(s || '')
    .replace(PREFIX_RE, '')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(TAGS, ' ')
    .replace(/\(\s*(19|20)\d{2}\s*\)/g, ' ')
    // Parentheses vides (etiquettes retirees, caracteres perdus) et tirets orphelins.
    .replace(/\(\s*[.\-]*\s*\)/g, ' ')
    .replace(/\s+-(?=\s|$)/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s+(19|20)\d{2}\s*$/, ' ')
    .replace(/[\s\-|:,]+$/, '')
    .trim();
  return out || String(s || '').trim();
}

/** Nom compare (index, secours, resultats TMDB) : nettoye, sans accents ni ponctuation. */
function norm(s) {
  return cleanTitle(s)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' et ')
    .replace(/[^a-z0-9]+/g, '');
}

function yearOf(...vals) {
  for (const v of vals) {
    const m = String(v || '').match(/\b(19[2-9]\d|20[0-4]\d)\b/);
    if (m) return Number(m[1]);
  }
  return null;
}

/** "Serie S01E02", "Serie S01 E02", "Serie 1x02" -> { show, season, episode }. */
function episodeOf(name) {
  const m = String(name).match(/^(.*?)[\s._-]*(?:S(\d{1,2})\s*[ ._-]?\s*E(\d{1,3})|\b(\d{1,2})x(\d{2,3})\b)/i);
  if (!m) return null;
  return { show: m[1].trim(), season: Number(m[2] || m[4]), episode: Number(m[3] || m[5]) };
}

const hash = (s) => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 16);

// ---- Index ------------------------------------------------------------------------------

/** Films et series d'un compte Xtream, au format des lignes de l'index. */
async function xtreamRows(src) {
  const [mCats, movies, sCats, series] = await Promise.all([
    xtream.categories(src, 'movie').catch(() => []),
    xtream.call(src, 'get_vod_streams', {}, 100e6).then(xtream.list).catch(() => []),
    xtream.categories(src, 'series').catch(() => []),
    xtream.call(src, 'get_series', {}, 100e6).then(xtream.list).catch(() => [])
  ]);
  const mc = new Map(mCats.map((c) => [c.id, c.name]));
  const sc = new Map(sCats.map((c) => [c.id, c.name]));
  const rows = [];
  for (const m of movies) {
    if (m.stream_id === undefined || !m.name) continue;
    const tmdb = String(m.tmdb || m.tmdb_id || '').replace(/\D/g, '') || null;
    rows.push({ kind: 'movie', id: String(m.stream_id), name: String(m.name).trim(), year: yearOf(m.year, m.name, m.releasedate), tmdb, imdb: null, category: mc.get(String(m.category_id)) || null, poster: /^https?:/i.test(m.stream_icon || '') ? m.stream_icon : null, plot: null, ext: m.container_extension || 'mp4', url: null, added: Number(m.added) * 1000 || null });
  }
  for (const s of series) {
    if (s.series_id === undefined || !s.name) continue;
    const tmdb = String(s.tmdb || s.tmdb_id || '').replace(/\D/g, '') || null;
    rows.push({ kind: 'series', id: String(s.series_id), name: String(s.name).trim(), year: yearOf(s.year, s.releaseDate, s.release_date, s.name), tmdb, imdb: null, category: sc.get(String(s.category_id)) || null, poster: /^https?:/i.test(s.cover || '') ? s.cover : null, plot: s.plot || null, ext: null, url: null, added: Number(s.last_modified) * 1000 || null });
  }
  return rows;
}

/** Films et episodes d'une liste M3U (entrees "movie" / "series" de m3u.parse). */
function m3uRows(entries) {
  const rows = [];
  const shows = new Map();
  for (const e of entries) {
    if (e.kind === 'movie') {
      rows.push({ kind: 'movie', id: hash(e.url), name: e.name, year: yearOf(e.name), tmdb: null, imdb: null, category: e.group || null, poster: e.logo || null, plot: null, ext: (e.url.match(/\.(\w{2,4})(\?|$)/) || [])[1] || 'mp4', url: e.url, added: null });
    } else if (e.kind === 'series') {
      const ep = episodeOf(e.name);
      const show = ep ? ep.show : e.name;
      const key = norm(show);
      if (!shows.has(key)) {
        shows.set(key, true);
        rows.push({ kind: 'series', id: key, name: show, year: yearOf(show), tmdb: null, imdb: null, category: e.group || null, poster: e.logo || null, plot: null, ext: null, url: null, added: null });
      }
      if (ep) rows.push({ kind: 'episode', id: hash(e.url), name: e.name, year: null, tmdb: null, imdb: null, category: null, poster: null, plot: null, ext: (e.url.match(/\.(\w{2,4})(\?|$)/) || [])[1] || 'mp4', url: e.url, series: key, season: ep.season, episode: ep.episode, added: null });
    }
  }
  return rows;
}

/** Remplace l'index d'une source (la VOD suit la liste du fournisseur). */
function store(sourceId, rows) {
  // Ids TMDB trouves par recherche (et recherches deja faites) : gardes.
  const kept = new Map(
    db
      .prepare('SELECT kind, id, tmdb, checked FROM iptv_vod WHERE source = ? AND checked IS NOT NULL')
      .all(sourceId)
      .map((r) => [`${r.kind}|${r.id}`, r])
  );
  transaction(() => {
    q.del.run(sourceId);
    for (const r of rows) {
      const k = kept.get(`${r.kind}|${r.id}`);
      if (k && !r.tmdb) r.tmdb = k.tmdb;
    }
    for (const r of rows) q.put.run(sourceId, r.kind, r.id, r.name, norm(r.name) || r.name.toLowerCase(), r.year, r.tmdb, r.imdb, r.category, r.poster, r.plot, r.ext, r.url, r.series || null, r.season ?? null, r.episode ?? null, r.added);
    const mark = db.prepare('UPDATE iptv_vod SET checked = ? WHERE source = ? AND kind = ? AND id = ?');
    for (const [, k] of kept) mark.run(k.checked, sourceId, k.kind, k.id);
  });
}

/** Lignes de l'index d'une source : films et series Xtream, ou entrees VOD de la liste M3U. */
function rowsOf(src, entries = []) {
  return src.kind === 'xtream' ? xtreamRows(src) : Promise.resolve(m3uRows(entries));
}

// ---- Categories (groupes des films et des series) ------------------------------------------

const EXCLUDED = { movie: 'excludedMovies', series: 'excludedSeries' };

/** Categories masquees d'une source pour un type (films : movie, series : series). */
function hiddenOf(src, kind) {
  return new Set((src?.options?.[EXCLUDED[kind]] || []).map(String));
}

/** Categories d'une liste de lignes : [{ key, name, count }] (key '' = sans categorie). */
function categoryCounts(rows, kind) {
  const m = new Map();
  for (const r of rows) {
    if (r.kind !== kind) continue;
    const k = r.category || '';
    m.set(k, (m.get(k) || 0) + 1);
  }
  return [...m].map(([key, count]) => ({ key, name: key, count })).sort((a, b) => a.name.localeCompare(b.name));
}

/** Categories d'une source, avec leur etat (pour l'admin). */
function categoriesOf(src, kind) {
  const hidden = hiddenOf(src, kind);
  return db
    .prepare("SELECT COALESCE(category, '') AS key, COUNT(*) AS count FROM iptv_vod WHERE source = ? AND kind = ? GROUP BY COALESCE(category, '') ORDER BY key")
    .all(src.id, kind)
    .map((c) => ({ key: c.key, name: c.key, count: c.count, enabled: !hidden.has(c.key) }));
}

/**
 * Categories arrivees depuis le dernier telechargement : masquees quand la source n'active pas
 * les nouveautes (meme regle que les groupes de chaines). Renvoie true si les options changent.
 */
function noteCategories(src, rows) {
  const o = src.options || (src.options = {});
  const known = o.vodKnown || {};
  let changed = false;
  for (const kind of ['movie', 'series']) {
    const names = categoryCounts(rows, kind).map((c) => c.key);
    if (Array.isArray(known[kind]) && o.newEnabled === false) {
      const before = new Set(known[kind]);
      const fresh = names.filter((n) => !before.has(n));
      if (fresh.length) {
        o[EXCLUDED[kind]] = [...new Set([...(o[EXCLUDED[kind]] || []), ...fresh])];
        changed = true;
      }
    }
    if (JSON.stringify(known[kind]) !== JSON.stringify(names)) changed = true;
    known[kind] = names;
  }
  o.vodKnown = known;
  return changed;
}

/** Met a jour l'index d'une source (apres le telechargement de sa liste). entries : liste M3U lue ;
 * rows : lignes deja telechargees (apercu de l'ajout). */
async function refreshSource(src, entries = [], ready = null) {
  const t0 = Date.now();
  const rows = ready || (await rowsOf(src, entries));
  store(src.id, rows);
  if (noteCategories(src, rows)) config.save();
  // Bibliotheques de la source : relues a la prochaine ouverture.
  require('../catalog').invalidate(`${PREFIX}${src.id}|`);
  const c = counts(src.id);
  resolveSource(src).catch((e) => log(`${src.name} : recherche des ids TMDB interrompue (${e.message})`));
  if (rows.length) log(`${src.name} : ${c.movies} film(s), ${c.series} série(s) (${Date.now() - t0} ms)`);
  return c;
}

function counts(sourceId) {
  const out = { movies: 0, series: 0, episodes: 0 };
  for (const r of q.counts.all(sourceId)) out[r.kind === 'movie' ? 'movies' : r.kind === 'series' ? 'series' : 'episodes'] = r.n;
  return out;
}

function drop(sourceId) {
  q.del.run(sourceId);
}

// ---- Bibliotheques (addon virtuel) ----------------------------------------------------------

const PREFIX = 'stremfin-iptv://';
const PAGE = 100;

function addonUrl(sourceId) {
  return `${PREFIX}${sourceId}/manifest.json`;
}
function sourceOfUrl(url) {
  return String(url || '').startsWith(PREFIX) ? String(url).slice(PREFIX.length).split('/')[0] : null;
}

/** Addons virtuels des sources du profil qui importent films ou series. */
function addons(profile) {
  const sources = require('../iptvSources');
  const out = [];
  for (const { source: s } of sources.activeFor(profile)) {
    const o = s.options || {};
    if (!o.movies && !o.series) continue;
    const catalogs = [];
    for (const [kind, on] of [['movie', o.movies], ['series', o.series]]) {
      if (!on) continue;
      const hidden = hiddenOf(s, kind);
      const genres = q.categories.all(s.id, kind).map((c) => c.category).filter((c) => !hidden.has(c));
      catalogs.push({ type: kind, id: `iptv-${kind}`, name: s.name, extra: [{ name: 'skip' }, { name: 'genre', options: genres }, { name: 'search' }] });
    }
    out.push({ url: addonUrl(s.id), name: s.name, manifest: { id: `stremfin.iptv.${s.id}`, name: s.name, catalogs, resources: [], types: ['movie', 'series'] } });
  }
  return out;
}

function metaOfRow(sourceId, r) {
  const type = r.kind === 'series' ? 'series' : 'movie';
  return {
    // Toujours un element propre a la source (lu par l'IPTV, pas par les addons) ; avec un id
    // TMDB, la fiche vient de TMDB (meta).
    id: `iptv:${sourceId}:${r.kind}:${r.id}`,
    type,
    name: cleanTitle(r.name),
    poster: r.poster || undefined,
    releaseInfo: r.year ? String(r.year) : undefined,
    description: r.plot || undefined
  };
}

/** Page d'un catalogue VOD : plus recents d'abord, filtre categorie (genre) ou recherche. */
function catalog(url, type, id, extra = {}) {
  const sourceId = sourceOfUrl(url);
  const kind = type === 'series' ? 'series' : 'movie';
  const skip = Math.max(0, Number(extra.skip) || 0);
  const where = ['source = ?', 'kind = ?'];
  const args = [sourceId, kind];
  const hidden = [...hiddenOf(require('../iptvSources').byId(sourceId), kind)];
  if (hidden.length) {
    where.push(`COALESCE(category, '') NOT IN (${hidden.map(() => '?').join(',')})`);
    args.push(...hidden);
  }
  if (extra.genre) {
    where.push('category = ?');
    args.push(String(extra.genre));
  }
  if (extra.search) {
    where.push('norm LIKE ?');
    args.push(`%${norm(extra.search)}%`);
  }
  const rows = db.prepare(`SELECT * FROM iptv_vod WHERE ${where.join(' AND ')} ORDER BY COALESCE(added, 0) DESC, rowid LIMIT ? OFFSET ?`).all(...args, PAGE, skip);
  return Promise.resolve({ metas: rows.map((r) => metaOfRow(sourceId, r)) });
}

/** Fiche d'un titre sans id TMDB (iptv:<source>:<kind>:<id>) : fiche du fournisseur. */
async function meta(type, id) {
  const [, sourceId, kind, xid] = String(id).split(':');
  const r = q.one.get(sourceId, kind, xid);
  if (!r) return null;
  // Fiche TMDB quand l'id est connu, ou trouve maintenant (fiche du fournisseur, recherche).
  if (!r.tmdb && !r.checked) r.tmdb = await findTmdb(require('../iptvSources').byId(sourceId), r).catch(() => null);
  const tm = r.tmdb ? await require('../tmdb').meta(type === 'series' ? 'series' : 'movie', `tmdb:${r.tmdb}`).catch(() => null) : null;
  const m = tm ? { ...tm, poster: tm.poster || r.poster || undefined } : metaOfRow(sourceId, r);
  m.id = id;
  if (kind !== 'series') return m;
  // Episodes : ceux du fournisseur (les seuls lisibles), avec titre et image de TMDB si connus.
  const src = require('../iptvSources').byId(sourceId);
  const eps = await seriesEpisodes(src, r).catch(() => []);
  const tmEp = new Map((tm?.videos || []).map((v) => [`${v.season}:${v.episode}`, v]));
  m.videos = eps.map((e) => {
    const t = tmEp.get(`${e.season}:${e.episode}`) || {};
    return { ...t, id: `${id}:${e.season}:${e.episode}`, season: e.season, episode: e.episode, title: t.title || t.name || e.title || undefined, thumbnail: t.thumbnail || e.thumb || undefined, released: t.released || e.released || undefined };
  });
  return m;
}

// ---- Ids TMDB des titres sans id (recherche) ------------------------------------------------
// Beaucoup de fournisseurs ne donnent pas l'id TMDB dans leur liste (Xtream : seulement dans la
// fiche get_vod_info d'un film ; series : jamais). Il est cherche :
//   - a l'ouverture d'une fiche : fiche du fournisseur (films Xtream), sinon recherche TMDB ;
//   - en arriere-plan, lentement, pour tout le catalogue (titres recents d'abord, categories
//     desactivees exclues). Le resultat est garde dans l'index (colonne tmdb, et checked).

/** Id TMDB par recherche : le nom nettoye, puis ses deux parties s'il finit par "(titre original)". */
async function searchTmdb(kind, name, year) {
  const tmdb = require('../tmdb');
  const type = kind === 'series' ? 'series' : 'movie';
  const clean = cleanTitle(name);
  const tries = [clean];
  const m = clean.match(/^(.+?)\s*\(([^()]{2,})\)$/);
  if (m) tries.push(m[1], m[2]);
  for (const t of tries) {
    const id = await tmdb.searchId(type, t, year, norm);
    if (id) return id;
  }
  return null;
}

// Fiches demandees au fournisseur (get_vod_info, get_series_info) : une file par source, au moins
// 3 s entre deux appels, pour ne jamais le solliciter en rafale.
const POLITE_GAP = 3000;
const politeQueues = new Map();
function politeCall(src, action, params, max) {
  const qd = politeQueues.get(src.id) || { last: 0, chain: Promise.resolve(), waiting: 0 };
  politeQueues.set(src.id, qd);
  qd.waiting++;
  const run = qd.chain.then(async () => {
    const wait = qd.last + POLITE_GAP - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    try {
      return await xtream.call(src, action, params, max);
    } finally {
      qd.last = Date.now();
      qd.waiting--;
    }
  });
  qd.chain = run.catch(() => {});
  return run;
}
/** Appels en attente pour une source (fiche du fournisseur sautee si la file est chargee). */
function politeBusy(src) {
  return (politeQueues.get(src.id)?.waiting || 0) >= 2;
}

const setTmdb = db.prepare('UPDATE iptv_vod SET tmdb = ?, checked = ? WHERE source = ? AND kind = ? AND id = ?');

async function findTmdb(src, row) {
  let id = null;
  // Fiche du fournisseur (id exact) seulement si sa file est libre ; sinon recherche TMDB directe.
  if (src?.kind === 'xtream' && row.kind === 'movie' && !politeBusy(src)) {
    const info = await politeCall(src, 'get_vod_info', { vod_id: row.id }, 5e6).catch(() => null);
    id = String(info?.info?.tmdb_id || info?.info?.tmdb || '').replace(/\D/g, '') || null;
  }
  if (!id) {
    const found = await searchTmdb(row.kind, row.name, row.year);
    id = found ? String(found) : null;
  }
  setTmdb.run(id, Date.now(), row.source || src?.id, row.kind, row.id);
  return id;
}

const resolving = new Set();
/** Recherche en arriere-plan des ids TMDB manquants d'une source (une seule a la fois). */
async function resolveSource(src) {
  if (!src || resolving.has(src.id) || !require('../tmdb').enabled()) return;
  const o = src.options || {};
  if (!o.movies && !o.series && config.get().settings.iptvFallback === false) return;
  resolving.add(src.id);
  const t0 = Date.now();
  let done = 0;
  let found = 0;
  try {
    for (const kind of ['movie', 'series']) {
      const hidden = hiddenOf(src, kind);
      const rows = db
        .prepare('SELECT source, kind, id, name, year, category FROM iptv_vod WHERE source = ? AND kind = ? AND tmdb IS NULL AND checked IS NULL ORDER BY COALESCE(added, 0) DESC')
        .all(src.id, kind)
        .filter((r) => !hidden.has(r.category || ''));
      for (const r of rows) {
        if (!require('../iptvSources').byId(src.id)) return;
        // Recherche TMDB seulement (la fiche du fournisseur, un appel par film, est gardee pour
        // l'ouverture d'une fiche) ; environ 8 par seconde.
        const id = await searchTmdb(kind, r.name, r.year).catch(() => undefined);
        if (id === undefined) {
          await new Promise((res) => setTimeout(res, 5000));
          continue;
        }
        setTmdb.run(id ? String(id) : null, Date.now(), src.id, kind, r.id);
        done++;
        if (id) found++;
        if (done % 1000 === 0) log(`${src.name} : ids TMDB, ${done} titre(s) cherché(s), ${found} trouvé(s)`);
        await new Promise((res) => setTimeout(res, 120));
      }
    }
    if (done) {
      log(`${src.name} : ids TMDB, ${done} titre(s) cherché(s), ${found} trouvé(s) (${Math.round((Date.now() - t0) / 60e3)} min)`);
      require('../catalog').invalidate(`${PREFIX}${src.id}|`);
    }
  } finally {
    resolving.delete(src.id);
  }
}

// ---- Episodes d'une serie -----------------------------------------------------------------

/** Episodes d'une serie : get_series_info (Xtream, garde 6 h) ou lignes "episode" (M3U). */
async function seriesEpisodes(src, row) {
  if (!src) return [];
  if (src.kind !== 'xtream') {
    return db
      .prepare('SELECT * FROM iptv_vod WHERE source = ? AND kind = ? AND series = ? ORDER BY season, episode')
      .all(src.id, 'episode', row.id)
      .map((e) => ({ season: e.season, episode: e.episode, title: null, url: e.url, ext: e.ext }));
  }
  const info = await cache.cached(`iptv-series|${src.id}|${row.id}`, 6 * 3600e3, async () => {
    const r = await politeCall(src, 'get_series_info', { series_id: row.id }, 20e6);
    return { episodes: r?.episodes || {} };
  });
  const out = [];
  for (const [season, list] of Object.entries(info.episodes || {})) {
    for (const e of xtream.list(list)) {
      out.push({ season: Number(e.season ?? season), episode: Number(e.episode_num), title: e.title || null, id: String(e.id), ext: e.container_extension || 'mp4', thumb: e.info?.movie_image || null, released: e.info?.releasedate || e.info?.air_date || null });
    }
  }
  return out.sort((a, b) => a.season - b.season || a.episode - b.episode);
}

// ---- Sources d'un titre ---------------------------------------------------------------------

function streamOf(src, mode, row, url, label) {
  return {
    addon: src.name,
    addonLogo: null,
    mode,
    iptv: true,
    stream: { url, name: `IPTV · ${src.name}`, title: label || row.name, behaviorHints: { filename: `${(label || row.name).replace(/[\\/:*?"<>|]+/g, ' ')}.${row.ext || 'mp4'}` } }
  };
}

function movieUrl(src, row) {
  return row.url || xtream.vodUrl(src, 'movie', row.id, row.ext);
}

/** Sources d'un titre d'une bibliotheque VOD (id iptv:... ou ses episodes). */
async function streamsById(profile, type, id) {
  const parts = String(id).split(':');
  if (parts[0] !== 'iptv') return [];
  const [, sourceId, kind, xid, season, episode] = parts;
  const sources = require('../iptvSources');
  const active = sources.activeFor(profile).find((x) => x.source.id === sourceId);
  if (!active) return [];
  const row = q.one.get(sourceId, kind, xid);
  if (!row) return [];
  if (kind === 'movie') return [streamOf(active.source, active.mode, row, movieUrl(active.source, row))];
  const ep = (await seriesEpisodes(active.source, row)).find((e) => e.season === Number(season) && e.episode === Number(episode));
  if (!ep) return [];
  const url = ep.url || xtream.vodUrl(active.source, 'series', ep.id, ep.ext);
  return [streamOf(active.source, active.mode, { ...row, ext: ep.ext }, url, `${row.name} S${String(ep.season).padStart(2, '0')}E${String(ep.episode).padStart(2, '0')}${ep.title ? ' · ' + ep.title : ''}`)];
}

/** Lignes de la VOD des sources du profil qui correspondent a un titre (ids, sinon nom et annee). */
function matches(sourceIds, kind, { tmdb, imdb, name, year }) {
  if (!sourceIds.length) return [];
  const inSrc = `source IN (${sourceIds.map(() => '?').join(',')})`;
  if (tmdb) {
    const r = db.prepare(`SELECT * FROM iptv_vod WHERE kind = ? AND tmdb = ? AND ${inSrc}`).all(kind, String(tmdb), ...sourceIds);
    if (r.length) return r;
  }
  if (imdb) {
    const r = db.prepare(`SELECT * FROM iptv_vod WHERE kind = ? AND imdb = ? AND ${inSrc}`).all(kind, String(imdb), ...sourceIds);
    if (r.length) return r;
  }
  const n = norm(name);
  if (!n) return [];
  const rows = db.prepare(`SELECT * FROM iptv_vod WHERE kind = ? AND norm = ? AND ${inSrc}`).all(kind, n, ...sourceIds);
  if (!year) return rows.filter((r) => !r.year).concat(rows.filter((r) => r.year)).slice(0, 5);
  const close = rows.filter((r) => r.year && Math.abs(r.year - year) <= 1);
  return close.length ? close : rows.filter((r) => !r.year);
}

/**
 * Recherche de secours (aucune source des addons) : versions trouvees dans la VOD des sources IPTV
 * du profil pour un film ou un episode (entree ids). Renvoie des sources au format de stremio.streams.
 */
async function fallback(profile, entry) {
  if (config.get().settings.iptvFallback === false || !entry) return [];
  const sources = require('../iptvSources');
  const active = sources.activeFor(profile);
  if (!active.length) return [];
  const ids = active.map((x) => x.source.id);
  const modeOf = (sid) => active.find((x) => x.source.id === sid)?.mode;
  const srcOf = (sid) => active.find((x) => x.source.id === sid)?.source;
  const shown = (r) => !hiddenOf(srcOf(r.source), r.kind).has(r.category || '');
  const out = [];
  if (entry.kind === 'movie') {
    const d = entry.data;
    const tmdb = d.tmdb || (String(d.sid || '').match(/^tmdb:(\d+)$/) || [])[1];
    for (const r of matches(ids, 'movie', { tmdb, imdb: d.imdb, name: d.name, year: yearOf(d.releaseInfo, d.released) }).filter(shown)) {
      out.push(streamOf(srcOf(r.source), modeOf(r.source), r, movieUrl(srcOf(r.source), r)));
    }
  } else if (entry.kind === 'episode') {
    const ids2 = require('../ids');
    const series = ids2.get(entry.data.seriesUuid);
    if (!series) return [];
    const d = series.data;
    const tmdb = d.tmdb || (String(d.sid || '').match(/^tmdb:(\d+)$/) || [])[1];
    for (const r of matches(ids, 'series', { tmdb, imdb: d.imdb, name: d.name, year: yearOf(d.releaseInfo, d.released) }).filter(shown).slice(0, 3)) {
      const src = srcOf(r.source);
      const ep = (await seriesEpisodes(src, r).catch(() => [])).find((e) => e.season === Number(entry.data.season) && e.episode === Number(entry.data.episode));
      if (!ep) continue;
      const url = ep.url || xtream.vodUrl(src, 'series', ep.id, ep.ext);
      out.push(streamOf(src, modeOf(r.source), { ...r, ext: ep.ext }, url, `${r.name} S${String(ep.season).padStart(2, '0')}E${String(ep.episode).padStart(2, '0')}`));
    }
  }
  if (out.length) log(`${entry.data.name || entry.data.vid} : ${out.length} version(s) trouvée(s) dans l'IPTV (aucune source des addons)`);
  return out;
}

module.exports = { resolveSource, searchTmdb, cleanTitle, refreshSource, rowsOf, categoryCounts, categoriesOf, hiddenOf, EXCLUDED, counts, drop, addons, catalog, meta, streamsById, fallback, sourceOfUrl, addonUrl, norm, episodeOf, PREFIX, m3uRows };
