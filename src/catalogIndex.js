// Index des catalogues : chaque liste active des profils (bibliotheques, dossiers des collections)
// est lue en entier en arriere-plan et rangee en base (idx_lists, idx_items, idx_titles).
// Une seule regle pour toutes les listes, quelle que soit leur source :
//   - mise a jour rapide : les N premieres pages de chaque liste, toutes les X heures (les
//     nouveautes d'une liste par date comme les changements d'une liste "populaires") ;
//   - relecture complete : chaque nuit ou chaque semaine, a l'heure choisie.
// La lecture ne remplit pas le cache general (cache.withoutStore). Reglages : Reglages -> Index
// des catalogues.
const config = require('./config');
const catalog = require('./catalog');
const collections = require('./collections');
const stremio = require('./stremio');
const tmdb = require('./tmdb');
const cache = require('./cache');
const { db, st, transaction } = require('./db');

// Vitesse : listes lues en parallele et pause entre deux pages d'une meme liste.
const SPEED = {
  gentle: { lists: 1, pause: 1500 },
  normal: { lists: 2, pause: 400 },
  fast: { lists: 4, pause: 0 }
};
const TYPES = ['movie', 'series', 'collection'];
const PAGE_GUARD = 2000; // pages lues au plus pour une liste (securite)
// Champs gardes de chaque titre : de quoi afficher, trier et filtrer sans relire l'addon.
// (fr : apercu deja traduit par TMDB, qui ne doit pas ecraser ni etre ecrase par un apercu anglais.)
const KEEP = ['name', 'poster', 'background', 'logo', 'releaseInfo', 'released', 'year', 'imdbRating', 'genres', 'genre', 'runtime', 'imdb_id', 'moviedb_id', 'certification', 'fr'];

const run = { mode: null, startedAt: 0, done: 0, total: 0, current: [], errors: [], stop: false };
let last = null; // dernier passage : { mode, at, duration, lists, errors }
let timer = null;

function log(...args) {
  console.log(new Date().toISOString(), '[index]', ...args);
}

const settings = () => config.get().settings;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Source lisible d'une liste : TMDB, collection ou adresse de l'addon. */
function sourceOf(view) {
  if (view.addonUrl === tmdb.ADDON_URL) return 'TMDB';
  if (view.addonUrl === collections.ADDON_URL) return 'Collections';
  try {
    return new URL(view.addonUrl).host;
  } catch {
    return String(view.addonUrl || '?');
  }
}

/** Toutes les listes actives des profils (une seule fois chacune), dossiers des collections compris. */
function listsToIndex() {
  const out = new Map();
  const add = (v) => v?.key && v.addonUrl && !out.has(v.key) && out.set(v.key, v);
  for (const p of config.get().profiles.filter((x) => !x.disabled)) {
    for (const v of catalog.views(p)) {
      // Racine d'une collection : ses dossiers, pas des titres ; on indexe les listes des dossiers.
      if (v.type === 'nuviocol') {
        const c = collections.byId(v.catId.slice(4));
        if (c) for (const w of collections.indexViews(c)) add(w);
        continue;
      }
      add(v);
    }
  }
  return [...out.values()];
}

function compact(m) {
  const out = {};
  for (const k of KEEP) if (m[k] !== undefined && m[k] !== null && m[k] !== '') out[k] = m[k];
  if (m.description) out.description = String(m.description).slice(0, 400);
  return out;
}

/** Lit une liste page par page. Renvoie { metas, complete } ; une erreur d'addon interrompt. */
async function readList(view, { pages, max, pause }) {
  const metas = [];
  const seen = new Set();
  let skip = 0;
  let complete = false;
  for (let page = 0; page < pages && !run.stop; page++) {
    const extra = {};
    if (view.defaultGenre) extra.genre = view.defaultGenre;
    if (skip) extra.skip = skip;
    const r = await stremio.catalog(view.addonUrl, view.type, view.catId, extra);
    const list = r?.metas || [];
    let fresh = 0;
    for (const m of list) {
      if (!m?.id || seen.has(m.id)) continue;
      seen.add(m.id);
      fresh++;
      const type = m.type || view.type;
      if (TYPES.includes(type)) metas.push({ ...m, type });
    }
    skip += list.length;
    // Page vide, page deja vue (addon qui ignore skip) ou liste sans pagination : fin de la liste.
    if (!fresh || !view.hasSkip) {
      complete = true;
      break;
    }
    if (max && metas.length >= max) break;
    if (pause) await sleep(pause);
  }
  return { metas: max ? metas.slice(0, max) : metas, complete };
}

/**
 * Range une liste lue. Relecture complete : la liste est remplacee. Mise a jour rapide : le debut
 * lu, puis la suite deja connue (sans doublons). Un titre garde sa date d'apparition dans la liste
 * (0 pour ceux trouves au premier passage, qui ne sont pas des ajouts).
 */
function writeList(view, metas, { mode, complete, duration }) {
  const now = Date.now();
  const prev = st.idxListGet.get(view.key);
  const old = prev ? st.idxItems.all(view.key) : [];
  const addedAt = new Map(old.map((r) => [r.id, r.added]));
  let order = metas.map((m) => m.id);
  if (mode === 'quick') {
    const head = new Set(order);
    order = order.concat(old.map((r) => r.id).filter((id) => !head.has(id)));
  }
  const max = settings().indexMaxItems;
  if (max) order = order.slice(0, max);
  transaction(() => {
    st.idxItemsDel.run(view.key);
    order.forEach((id, pos) => st.idxItemPut.run(view.key, pos, id, addedAt.get(id) ?? (prev?.full_at ? now : 0)));
    for (const m of metas) st.idxTitlePut.run(m.id, m.type, JSON.stringify(compact(m)), now);
    st.idxListPut.run(
      view.key,
      view.name || view.catId || '?',
      view.type,
      sourceOf(view),
      order.length,
      mode === 'full' ? (complete ? 1 : 0) : prev?.complete || 0,
      mode === 'full' ? now : prev?.full_at || null,
      now,
      mode === 'full' ? duration : prev?.duration ?? null,
      null
    );
  });
}

/** Un passage sur toutes les listes : "full" (relecture complete) ou "quick" (debut des listes). */
async function scan(mode) {
  if (run.mode) return false;
  const s = settings();
  const lists = listsToIndex();
  const speed = SPEED[s.indexSpeed] || SPEED.normal;
  Object.assign(run, { mode, startedAt: Date.now(), done: 0, total: lists.length, current: [], errors: [], stop: false });
  // Genres des catalogues TMDB : leurs noms doivent etre connus avant de lire les listes.
  await tmdb.ensureGenres().catch(() => {});
  log(`${mode === 'full' ? 'relecture complete' : 'mise a jour rapide'} de ${lists.length} liste(s)`);
  const queue = [...lists];
  const worker = async () => {
    while (queue.length && !run.stop) {
      const view = queue.shift();
      const name = view.name || view.catId || '?';
      run.current.push(name);
      const t0 = Date.now();
      try {
        const r = await cache.withoutStore(() => readList(view, { pages: mode === 'quick' ? s.indexQuickPages : PAGE_GUARD, max: s.indexMaxItems, pause: speed.pause }));
        if (!run.stop) writeList(view, r.metas, { mode, complete: r.complete, duration: Date.now() - t0 });
      } catch (e) {
        // La liste deja indexee est gardee telle quelle ; l'erreur est affichee dans les reglages,
        // sans adresse (celle d'un addon peut contenir un jeton personnel).
        const error = String(e.message || e).replace(/https?:\/\/\S+/g, '(adresse)');
        run.errors.push({ name, source: sourceOf(view), error });
        if (st.idxListGet.get(view.key)) st.idxListError.run(error, view.key);
        else st.idxListPut.run(view.key, name, view.type, sourceOf(view), 0, 0, null, null, null, error);
      } finally {
        run.current = run.current.filter((n) => n !== name);
        run.done++;
      }
    }
  };
  try {
    await Promise.all(Array.from({ length: speed.lists }, worker));
    if (mode === 'full' && !run.stop) {
      // Listes qui ne sont plus actives dans aucun profil, puis apercus devenus inutiles.
      const active = new Set(lists.map((v) => v.key));
      transaction(() => {
        for (const l of st.idxListAll.all()) {
          if (active.has(l.key)) continue;
          st.idxItemsDel.run(l.key);
          st.idxListDel.run(l.key);
        }
      });
      st.idxTitlesOrphan.run();
    }
    last = { mode, at: Date.now(), duration: Date.now() - run.startedAt, lists: lists.length, errors: run.errors.length, stopped: run.stop };
    log(`${mode === 'full' ? 'relecture complete' : 'mise a jour rapide'} terminee en ${Math.round(last.duration / 1000)} s, ${run.errors.length} erreur(s)`);
  } finally {
    run.mode = null;
    run.current = [];
  }
  return true;
}

const lastAt = (col) => db.prepare(`SELECT MAX(${col}) AS t FROM idx_lists`).get().t || 0;

/** Derniere heure prevue de relecture complete avant `now` (chaque nuit ou chaque semaine). */
function lastSlot(now = Date.now()) {
  const s = settings();
  const d = new Date(now);
  d.setHours(s.indexFullHour, 0, 0, 0);
  if (d.getTime() > now) d.setDate(d.getDate() - 1);
  if (s.indexFullFrequency === 'weekly') while (d.getDay() !== s.indexFullDay) d.setDate(d.getDate() - 1);
  return d.getTime();
}

function nextSlot(now = Date.now()) {
  const step = settings().indexFullFrequency === 'weekly' ? 7 : 1;
  const d = new Date(lastSlot(now));
  d.setDate(d.getDate() + step);
  return d.getTime();
}

/** Toutes les minutes : relecture complete si son heure est passee, sinon mise a jour rapide si due. */
function tick() {
  const s = settings();
  if (!s.indexEnabled || run.mode) return;
  const full = lastAt('full_at');
  // Jamais indexe (ou nouvelle heure prevue passee) : relecture complete.
  if (!full || full < lastSlot()) return void scan('full').catch((e) => log(`KO : ${e.message}`));
  const quick = Math.max(full, lastAt('quick_at'));
  if (Date.now() - quick >= s.indexQuickEvery * 3600e3) scan('quick').catch((e) => log(`KO : ${e.message}`));
}

function start() {
  clearInterval(timer);
  timer = setInterval(tick, 60e3);
  timer.unref();
  // Premier passage peu apres le demarrage (le prechauffage des bibliotheques passe d'abord).
  setTimeout(tick, 3 * 60e3).unref();
}

/** Lance un passage tout de suite (bouton "Scanner maintenant"). */
function scanNow(mode = 'full') {
  if (run.mode) return false;
  scan(mode).catch((e) => log(`KO : ${e.message}`));
  return true;
}

/** Vide l'index (arrete le passage en cours). */
async function clear() {
  run.stop = true;
  while (run.mode) await sleep(200);
  db.exec('DELETE FROM idx_items; DELETE FROM idx_titles; DELETE FROM idx_lists;');
  last = null;
  log('index vide');
}

/**
 * Liste servie depuis l'index (index active, liste lue au moins une fois) : { count, version }, sinon
 * null. `version` change a chaque mise a jour de la liste.
 */
function listInfo(key) {
  if (!settings().indexEnabled) return null;
  const l = st.idxListGet.get(key);
  if (!l || !l.count) return null;
  return { count: l.count, version: Math.max(l.full_at || 0, l.quick_at || 0), complete: !!l.complete };
}

// ---- Tris et filtres des apps sur une liste indexee -------------------------------------------
// La liste est chargee en memoire une fois par version (8 listes au plus), puis triee et filtree
// localement : nom, date de sortie, note, date d'ajout, aleatoire ; genre et annees.

const loaded = new Map(); // cle de liste -> { version, rows, results }
const LOADED_MAX = 8;
const collator = new Intl.Collator('fr', { sensitivity: 'base', numeric: true });

function rowsOf(key) {
  const info = listInfo(key);
  if (!info) return null;
  let m = loaded.get(key);
  if (!m || m.version !== info.version) {
    const rows = st.idxRows.all(key).map((r) => ({ ...JSON.parse(r.data), id: r.id, type: r.type, _pos: r.pos, _added: r.added }));
    m = { version: info.version, rows, results: new Map() };
  }
  loaded.delete(key);
  loaded.set(key, m);
  if (loaded.size > LOADED_MAX) loaded.delete(loaded.keys().next().value);
  return m;
}

const yearOf = (m) => Number(String(m.releaseInfo ?? m.year ?? m.released ?? '').match(/\d{4}/)?.[0]) || 0;
const dateOf = (m) => Date.parse(m.released || '') || (yearOf(m) ? Date.UTC(yearOf(m), 0, 1) : 0);
const genresOf = (m) => (Array.isArray(m.genres) ? m.genres : m.genre ? [].concat(m.genre) : []).map((g) => String(g));

/** Petit hachage (aleatoire stable sur la journee : les pages se suivent sans doublons). */
function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

// Valeur de tri ; 0 / vide = inconnue (toujours en fin de liste, quel que soit le sens).
const SORT_VALUE = {
  // Nom sans la ponctuation de debut (guillemets, points de suspension, ¡...), comme Jellyfin.
  name: (m) => String(m.name || '').replace(/^[^\p{L}\p{N}]+/u, ''),
  date: dateOf,
  rating: (m) => Number(m.imdbRating) || 0,
  added: (m) => m._added || 0
};

/** Liste triee et filtree : opts { sort: "name.asc" | "date.desc" | ... | "random", genre, years }. */
function query(key, { sort, genre, years } = {}) {
  const m = rowsOf(key);
  if (!m) return null;
  const k = JSON.stringify([sort || '', genre || '', years || []]);
  if (m.results.has(k)) return m.results.get(k);
  let out = m.rows;
  if (genre) {
    const g = String(genre).toLowerCase();
    out = out.filter((r) => genresOf(r).some((x) => x.toLowerCase() === g));
  }
  if (years?.length) out = out.filter((r) => years.includes(yearOf(r)));
  const [by, dir = 'asc'] = String(sort || '').split('.');
  if (by === 'random') {
    const day = new Date().toISOString().slice(0, 10);
    out = [...out].sort((a, b) => hash(a.id + day) - hash(b.id + day));
  } else if (SORT_VALUE[by]) {
    const val = SORT_VALUE[by];
    const sign = dir === 'desc' ? -1 : 1;
    const cmp = by === 'name' ? (a, b) => collator.compare(a, b) : (a, b) => a - b;
    out = [...out].sort((a, b) => {
      const va = val(a);
      const vb = val(b);
      if (!va || !vb) return (!va) - (!vb) || a._pos - b._pos;
      return sign * cmp(va, vb) || a._pos - b._pos;
    });
  }
  if (m.results.size > 30) m.results.clear();
  m.results.set(k, out);
  return out;
}

const hasOpts = (o) => !!(o && (o.sort || o.genre || o.years?.length));

/** Titres d'une liste indexee, a partir de la position `skip` (dans l'ordre et le filtre demandes). */
function page(key, skip, limit, opts) {
  if (hasOpts(opts)) return (query(key, opts) || []).slice(skip, skip + limit);
  return st.idxPage.all(key, skip, limit).map((r) => ({ ...JSON.parse(r.data), id: r.id, type: r.type }));
}

/** Nombre de titres d'une liste indexee avec ce filtre. */
function count(key, opts) {
  if (hasOpts(opts)) return query(key, opts)?.length || 0;
  return listInfo(key)?.count || 0;
}

/** Genres et annees presents dans une liste indexee (filtres des apps), ou null. */
function facets(key) {
  const m = rowsOf(key);
  if (!m) return null;
  const genres = new Map();
  const years = new Set();
  for (const r of m.rows) {
    for (const g of genresOf(r)) genres.set(g.toLowerCase(), genres.get(g.toLowerCase()) || g);
    if (yearOf(r)) years.add(yearOf(r));
  }
  return { genres: [...genres.values()].sort(collator.compare), years: [...years].sort((a, b) => b - a) };
}

/** Etat pour la page des reglages. */
function status() {
  const s = settings();
  const stats = st.idxStats.get();
  const full = lastAt('full_at');
  const quick = Math.max(full, lastAt('quick_at'));
  const lists = st.idxListAll.all();
  return {
    enabled: s.indexEnabled,
    running: run.mode ? { mode: run.mode, startedAt: run.startedAt, done: run.done, total: run.total, current: run.current, errors: run.errors.length } : null,
    last,
    lastFull: full || null,
    lastQuick: quick || null,
    nextFull: s.indexEnabled ? (full ? nextSlot() : null) : null,
    nextQuick: s.indexEnabled && full ? quick + s.indexQuickEvery * 3600e3 : null,
    // Place prise : apercus + une ligne par titre de chaque liste (environ 40 octets avec l'index).
    stats: { lists: stats.lists, items: stats.items, titles: stats.titles, bytes: stats.bytes + stats.items * 40 },
    lists: lists.map((l) => ({ name: l.name, source: l.source, type: l.type, count: l.count, complete: !!l.complete, fullAt: l.full_at, quickAt: l.quick_at, duration: l.duration, error: l.error }))
  };
}

module.exports = { start, scanNow, clear, status, listsToIndex, listInfo, page, count, facets };
