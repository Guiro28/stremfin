// Logique "bibliotheque" : traduit les objets Stremio en elements Jellyfin et inversement.
const ids = require('../ids');
const stremio = require('../stremio');
const catalog = require('../catalog');
const config = require('../config');
const tmdb = require('../tmdb');
const collections = require('../collections');
const libraryImages = require('../libraryImages');
const { st } = require('../db');
const dto = require('./dto');

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function udRow(profile, uuid) {
  return st.udGet.get(profile.id, uuid) || null;
}

function itemKey(type, sid) {
  return `item|${type}|${sid}`;
}

/** Fiche complete : TMDB d'abord (dans la langue choisie), sinon le premier addon capable. */
async function metaFor(profile, type, sid) {
  if (tmdb.enabled()) {
    try {
      const m = await tmdb.meta(type, sid);
      if (m) return m;
    } catch (e) {
      log(`[tmdb] fiche ${type}/${sid} KO : ${e.message}`);
    }
  }
  return stremio.meta(profile, type, sid);
}

// Champs fournis par la traduction TMDB : un apercu d'addon (souvent en anglais) ne les ecrase pas.
const TRANSLATED = ['name', 'description', 'poster', 'background', 'logo', 'genres', 'releaseInfo', 'runtime'];

/** Enregistre des metas Stremio (catalogue, recherche) et renvoie leurs entrees. */
function registerMetas(metas) {
  const list = metas
    .filter((m) => m?.id && ['movie', 'series', 'collection', 'colfolder', 'colcat'].includes(m.type))
    .map((m) => {
      const key = itemKey(m.type, m.id);
      const data = dto.preview(m);
      if (!m.fr && ids.get(ids.uuidOf(key))?.data.fr) for (const f of TRANSLATED) delete data[f];
      return { key, kind: m.type, data };
    });
  const entries = ids.registerMany(list).map((uuid) => ids.get(uuid));
  translateLater(entries);
  return entries;
}

// ---- Traduction en arriere-plan --------------------------------------------------
// Les elements venant d'addons (ex: Cinemeta, en anglais) sont traduits via TMDB des
// qu'ils apparaissent : au prochain affichage, titre, affiche et resume sont en francais.

const pendingTranslation = new Set();
let translating = false;

function translateLater(entries) {
  if (!tmdb.enabled()) return;
  for (const e of entries) {
    if (e && !e.data.fr && !e.data.tmdbMiss && ['movie', 'series'].includes(e.kind) && /^(tt\d+|tmdb:\d+)$/.test(e.data.sid)) {
      pendingTranslation.add(e.uuid);
    }
  }
  if (!translating && pendingTranslation.size) drainTranslations();
}

async function drainTranslations() {
  translating = true;
  try {
    while (pendingTranslation.size) {
      const batch = [...pendingTranslation].slice(0, 8);
      batch.forEach((u) => pendingTranslation.delete(u));
      await Promise.all(
        batch.map(async (u) => {
          const e = ids.get(u);
          if (!e) return;
          const type = e.data.type || e.kind;
          try {
            const m = await tmdb.previewMeta(type, e.data.sid);
            if (m) ids.register(e.key, e.kind, dto.preview({ ...m, id: e.data.sid, type }));
            else ids.register(e.key, e.kind, { tmdbMiss: true });
          } catch {}
        })
      );
    }
  } finally {
    translating = false;
  }
}

function lightDto(profile, entry) {
  if (!entry) return null;
  switch (entry.kind) {
    case 'movie':
      return dto.mediaItem(entry.uuid, entry.kind, entry.data, udRow(profile, entry.uuid));
    case 'series':
      return seriesUserData(profile, entry, dto.mediaItem(entry.uuid, entry.kind, entry.data, udRow(profile, entry.uuid)));
    case 'episode':
      return dto.episodeItem(entry.uuid, entry, ids.get(entry.data.seriesUuid), udRow(profile, entry.uuid));
    case 'season': {
      const series = ids.get(entry.data.seriesUuid);
      return series ? dto.seasonItem(entry.uuid, series, entry.data.season, udRow(profile, entry.uuid)) : null;
    }
    case 'collection':
      return dto.boxSetItem(entry.uuid, entry.data, udRow(profile, entry.uuid));
    case 'colfolder':
    case 'colcat':
      return dto.folderItem(entry.uuid, entry.data, udRow(profile, entry.uuid));
    case 'view':
      // Image choisie dans l'admin, sinon le fond du titre le plus populaire.
      return dto.viewItem(entry.uuid, entry.data, libraryImages.custom(profile, entry.data.key) || entry.data.image);
    case 'genre':
      return dto.genreItem(entry.data.name);
    case 'person':
      return dto.personItem(entry.uuid, entry.data);
    default:
      return null;
  }
}

/** Option du profil "seulement ce qui est sorti en VOD / DVD / TV". */
function releasedFilter(profile) {
  if (!profile.onlyReleased || !tmdb.enabled()) return null;
  return { key: 'released', fn: (m) => tmdb.released(m.type, m.id, m) };
}

async function keepReleased(profile, metas) {
  const f = releasedFilter(profile);
  if (!f) return metas;
  const keep = await Promise.all(metas.map((m) => f.fn(m).catch(() => true)));
  return metas.filter((m, i) => keep[i]);
}

function metasToDtos(profile, metas) {
  return registerMetas(metas).map((e) => lightDto(profile, e));
}

// ---- Series : saisons et episodes ------------------------------------------

/**
 * Charge la fiche d'une serie et enregistre ses saisons/episodes.
 * Renvoie { meta, seasons: [{ n, uuid, episodes: [entry] }] }.
 */
async function seriesTree(profile, series) {
  const meta = await metaFor(profile, series.data.type || 'series', series.data.sid);
  if (!meta) return { meta: null, seasons: [] };
  ids.register(series.key, series.kind, dto.preview({ ...meta, type: series.data.type || 'series' }));

  const now = Date.now();
  const hide = config.get().settings.hideUnreleased;
  const videos = (meta.videos || []).filter((v) => {
    if (!v?.id) return false;
    if (!hide || !v.released) return true;
    const t = Date.parse(v.released);
    return !Number.isFinite(t) || t <= now;
  });

  const bySeason = new Map();
  videos.forEach((v, i) => {
    const n = Number.isFinite(Number(v.season)) ? Number(v.season) : 1;
    if (!bySeason.has(n)) bySeason.set(n, []);
    bySeason.get(n).push({ v, i });
  });
  // Ordre : saisons croissantes, les "speciaux" (saison 0) a la fin.
  const numbers = [...bySeason.keys()].sort((a, b) => (a === 0) - (b === 0) || a - b);

  const regs = [];
  const seasons = numbers.map((n) => {
    const seasonKey = `season|${series.data.sid}|${n}`;
    const seasonUuid = ids.uuidOf(seasonKey);
    regs.push({ key: seasonKey, kind: 'season', data: { seriesUuid: series.uuid, type: series.data.type, seriesSid: series.data.sid, season: n } });
    const eps = bySeason
      .get(n)
      .sort((a, b) => (Number(a.v.episode ?? a.v.number) || 0) - (Number(b.v.episode ?? b.v.number) || 0) || a.i - b.i)
      .map(({ v }, idx) => {
        const key = `ep|${series.data.sid}|${v.id}`;
        regs.push({
          key,
          kind: 'episode',
          data: {
            seriesUuid: series.uuid,
            seasonUuid,
            type: series.data.type || 'series',
            seriesSid: series.data.sid,
            vid: v.id,
            tmdbVid: v.tmdbVid,
            runtime: v.runtime,
            season: n,
            episode: Number(v.episode ?? v.number) || idx + 1,
            name: v.name || v.title,
            thumbnail: v.thumbnail,
            overview: v.overview || v.description,
            released: v.released
          }
        });
        return ids.uuidOf(key);
      });
    return { n, uuid: seasonUuid, episodeUuids: eps };
  });
  ids.registerMany(regs);
  for (const s of seasons) s.episodes = s.episodeUuids.map((u) => ids.get(u));
  // Episodes deja sortis (hors speciaux) : sert a la pastille "episodes restants" des listes.
  const aired = (meta.videos || []).filter((v) => v?.id && Number(v.season) !== 0 && isAired(v.released, now)).length;
  // Debut de l'id video des episodes (tt... ou tmdb:N) : identite de la serie commune a ses versions.
  const vidKey = String(videos.find((v) => Number(v.season) !== 0)?.id || '').replace(/:\d+:\d+$/, '') || undefined;
  if (aired !== series.data.airedCount || vidKey !== series.data.vidKey) ids.register(series.key, series.kind, { airedCount: aired, vidKey });
  return { meta, seasons };
}

/** Episode sorti (ou sans date connue) ? */
function isAired(released, now = Date.now()) {
  const t = Date.parse(released || '');
  return !Number.isFinite(t) || t <= now;
}

/**
 * Identite d'une serie commune a ses deux versions (tt... / tmdb:...) : l'id IMDb, sinon tmdb:N.
 * C'est aussi le debut de l'id video de ses episodes (tt..:s:e ou tmdb:N:s:e).
 */
function seriesKeyOf(data) {
  return data?.vidKey || data?.imdb || (data?.tmdb ? `tmdb:${data.tmdb}` : data?.sid) || null;
}

const episodeSeriesKey = (data) => String(data?.vid || '').replace(/:\d+:\d+$/, '') || null;

// Episodes vus de chaque profil, par serie : "saison:episode". Relus apres chaque changement.
const playedCache = new Map();

// Version des vus de chaque profil : les listes filtrees par vu / pas vu se refont quand elle change.
const playedVersion = new Map();

function forgetPlayed(profileId) {
  playedCache.delete(profileId);
  nextUpMemo.delete(profileId);
  playedVersion.set(profileId, (playedVersion.get(profileId) || 0) + 1);
}

function playedBySeries(profileId) {
  if (playedCache.has(profileId)) return playedCache.get(profileId);
  const map = new Map();
  for (const r of st.udPlayedEpisodes.all(profileId)) {
    const d = JSON.parse(r.data);
    const k = episodeSeriesKey(d);
    if (!k || !Number(d.season)) continue;
    if (!map.has(k)) map.set(k, new Set());
    map.get(k).add(`${d.season}:${d.episode}`);
  }
  playedCache.set(profileId, map);
  return map;
}

/**
 * Serie dans une liste : coche quand tous les episodes sortis sont vus, pastille du nombre
 * d'episodes restants (comme Jellyfin). Connu des que la fiche de la serie a ete chargee une fois.
 */
function seriesUserData(profile, entry, d, always = false) {
  const total = entry.data.airedCount;
  const k = seriesKeyOf(entry.data);
  if (!total || !k || !d?.UserData) return d;
  const seen = playedBySeries(profile.id).get(k)?.size || 0;
  // Dans les listes, seulement pour les series commencees (sur la fiche, toujours).
  if (!seen && !always) return d;
  d.UserData.UnplayedItemCount = Math.max(0, total - seen);
  d.UserData.Played = seen >= total;
  d.UserData.PlayedPercentage = Math.min(100, (seen / total) * 100);
  return d;
}

// ---- Fiche detaillee --------------------------------------------------------

async function itemDto(profile, id) {
  const entry = ids.get(id);
  if (!entry) return null;
  // Id d'une "version" (4K/1080p/720p) : c'est le film ou l'episode qui est demande.
  if (entry.kind === 'quality') return itemDto(profile, entry.data.itemUuid);

  if (entry.kind === 'collection') {
    const parts = await collectionParts(profile, entry);
    return dto.boxSetItem(entry.uuid, ids.get(entry.uuid).data, udRow(profile, entry.uuid), parts.length);
  }

  if (entry.kind === 'movie' || entry.kind === 'series') {
    const meta = await metaFor(profile, entry.data.type || entry.kind, entry.data.sid);
    if (meta) ids.register(entry.key, entry.kind, dto.preview({ ...meta, type: entry.data.type || entry.kind }));
    const fresh = ids.get(entry.uuid);
    const d = dto.mediaItem(entry.uuid, entry.kind, { ...fresh.data, ...(meta || {}) }, udRow(profile, entry.uuid), { full: true });
    if (entry.kind === 'series') {
      const tree = await seriesTree(profile, fresh);
      d.ChildCount = tree.seasons.length;
      d.RecursiveItemCount = tree.seasons.reduce((n, s) => n + s.episodes.length, 0);
      seriesUserData(profile, ids.get(entry.uuid), d, true);
    } else {
      prefetch(profile, entry.uuid);
    }
    return d;
  }

  if (entry.kind === 'season') {
    const series = ids.get(entry.data.seriesUuid);
    if (!series) return null;
    const tree = await seriesTree(profile, series);
    const s = tree.seasons.find((x) => x.n === entry.data.season);
    return dto.seasonItem(entry.uuid, ids.get(series.uuid), entry.data.season, udRow(profile, entry.uuid), s?.episodes.length);
  }

  if (entry.kind === 'episode') {
    prefetch(profile, entry.uuid);
    return lightDto(profile, entry);
  }

  return lightDto(profile, entry);
}

/** Lance la recherche des sources des l'ouverture de la fiche : la lecture demarre sans attente. */
function prefetch(profile, uuid) {
  setImmediate(() => {
    const playback = require('./playback');
    playback.sourcesFor(profile, uuid).catch(() => {});
    playback.mediaSegments(uuid).catch(() => {});
  });
}

// ---- Listes ------------------------------------------------------------------

function viewByUuid(profile, uuid) {
  return catalog.views(profile).find((v) => v.uuid === ids.norm(uuid)) || null;
}

/** Film ou serie vu par le profil (film : l'une de ses deux versions ; serie : tous ses episodes sortis). */
function isPlayed(profile, type, sid) {
  const uuid = ids.uuidOf(itemKey(type, sid));
  const e = ids.get(uuid);
  if (type === 'series') return !!(e && seriesUserData(profile, e, { UserData: {} }).UserData.Played);
  if (udRow(profile, uuid)?.played) return true;
  return !!(e?.data.twin && udRow(profile, e.data.twin)?.played);
}

/**
 * Filtre d'une liste pour un profil : "seulement sortis", "masquer les vus" (films) et filtre
 * vu / pas vu demande par l'app (`played`). Applique avant le decoupage en pages : les pages
 * restent pleines et le total juste. La cle change avec les vus du profil (liste a refaire).
 */
function listFilter(profile, played) {
  const rel = releasedFilter(profile);
  const hide = !!profile.hideWatched;
  if (!rel && !hide && played === undefined) return null;
  const usesPlayed = hide || played !== undefined;
  return {
    // Sans "seulement sortis", le filtre ne depend que des vus : reponse immediate, total exact.
    sync: !rel,
    key: [rel?.key || '', hide ? 'hide' : '', played === undefined ? '' : `played:${played}`, usesPlayed ? `v${playedVersion.get(profile.id) || 0}` : ''].join('|'),
    fn: async (m) => {
      if (usesPlayed) {
        const seen = isPlayed(profile, m.type, m.id);
        if (hide && m.type === 'movie' && seen) return false;
        if (played !== undefined && seen !== played) return false;
      }
      return rel ? rel.fn(m) : true;
    }
  };
}

async function viewItems(profile, view, { start = 0, limit = 50, genre, sort, years, played } = {}) {
  const { metas, total } = await catalog.slice(view, start, limit, genre, listFilter(profile, played), sort, { years });
  const items = metasToDtos(profile, metas);
  // Image de la bibliotheque = fond du premier element (les apps l'affichent dans "Mes medias"),
  // sauf image propre (fond d'une collection).
  if (start === 0 && metas[0] && !view.image) ids.register(`view|${profile.id}|${view.key}`, 'view', { image: metas[0].background || metas[0].poster });
  return { items, total };
}

async function seasonsOf(profile, seriesId) {
  const series = ids.get(seriesId);
  if (!series || series.kind !== 'series') return [];
  const tree = await seriesTree(profile, series);
  const fresh = ids.get(series.uuid);
  // Episodes vus, quelle que soit la version de la serie sur laquelle ils l'ont ete.
  const seen = playedBySeries(profile.id).get(seriesKeyOf(fresh.data)) || new Set();
  const played = (e) => seen.has(`${e.data.season}:${e.data.episode}`) || !!udRow(profile, e.uuid)?.played;
  return tree.seasons.map((s) => {
    const d = dto.seasonItem(s.uuid, fresh, s.n, udRow(profile, s.uuid), s.episodes.length);
    d.UserData.UnplayedItemCount = s.episodes.filter((e) => !played(e)).length;
    d.UserData.Played = d.UserData.UnplayedItemCount === 0 && s.episodes.length > 0;
    return d;
  });
}

async function episodesOf(profile, seriesId, { seasonId, season } = {}) {
  const series = ids.get(seriesId);
  if (!series || series.kind !== 'series') return [];
  const tree = await seriesTree(profile, series);
  const fresh = ids.get(series.uuid);
  let seasons = tree.seasons;
  if (seasonId) seasons = seasons.filter((s) => s.uuid === ids.norm(seasonId));
  else if (season !== undefined && season !== null && season !== '') seasons = seasons.filter((s) => s.n === Number(season));
  // Toute la serie (file de lecture des apps) : sans les "Speciaux", comme Jellyfin par defaut.
  else seasons = seasons.filter((s) => s.n !== 0);
  return seasons.flatMap((s) => s.episodes.map((e) => dto.episodeItem(e.uuid, e, fresh, udRow(profile, e.uuid))));
}

/** Films d'une saga, dans l'ordre de sortie (enregistres comme elements). */
async function collectionParts(profile, entry) {
  const m = String(entry.data.sid).match(/^tmdbcol:(\d+)$/);
  if (!m || !tmdb.enabled()) return [];
  const c = await tmdb.collection(m[1]);
  ids.register(entry.key, entry.kind, dto.preview(c));
  return registerMetas(await keepReleased(profile, c.parts));
}

/** "Similaires" : recommandations TMDB (films ou series). */
async function similar(profile, id, limit = 12) {
  const entry = ids.get(id);
  if (!entry || !['movie', 'series'].includes(entry.kind) || !tmdb.enabled()) return [];
  const m = await tmdb.meta(entry.data.type || entry.kind, entry.data.sid).catch(() => null);
  return metasToDtos(profile, (await keepReleased(profile, m?.recommendations || [])).slice(0, limit));
}

/** Enfants d'un element : bibliotheque -> films/series, serie -> saisons, saison -> episodes. */
async function children(profile, parentId, opts = {}) {
  const entry = ids.get(parentId);
  if (!entry) return { items: [], total: 0 };
  if (entry.kind === 'collection') {
    const parts = (await collectionParts(profile, entry)).map((e) => lightDto(profile, e));
    return page(parts, opts);
  }
  // Dossier d'une collection -> un sous-dossier par catalogue (ou ses titres s'il n'en a qu'un) ;
  // sous-dossier -> titres du catalogue (pagines).
  if (entry.kind === 'colfolder') {
    const subs = await collections.subfolders(entry.data.colId, entry.data.folderId);
    if (subs) return page(registerMetas(subs).map((e) => lightDto(profile, e)), opts);
    return viewItems(profile, collections.folderView(entry.data.colId, entry.data.folderId), opts);
  }
  if (entry.kind === 'colcat') {
    const view = collections.sourceViewOf(entry.data.colId, entry.data.folderId, entry.data.srcIndex);
    return view ? viewItems(profile, view, opts) : { items: [], total: 0 };
  }
  if (entry.kind === 'view') {
    const view = viewByUuid(profile, entry.uuid);
    if (!view) return { items: [], total: 0 };
    return viewItems(profile, view, opts);
  }
  if (entry.kind === 'series') {
    const items = opts.episodes ? await episodesOf(profile, entry.uuid) : await seasonsOf(profile, entry.uuid);
    return page(items, opts);
  }
  if (entry.kind === 'season') {
    const items = await episodesOf(profile, entry.data.seriesUuid, { seasonId: entry.uuid });
    return page(items, opts);
  }
  return { items: [], total: 0 };
}

function page(items, { start = 0, limit } = {}) {
  return { items: limit ? items.slice(start, start + limit) : items.slice(start), total: items.length };
}

/**
 * Un meme titre peut exister en deux versions (tt... d'un addon, tmdb:... d'un catalogue TMDB) :
 * meme cle pour les deux. Episode : son id video (tt..:s:e) ; film : IMDb, ou son jumeau (data.twin).
 */
function sameKey(e) {
  if (e.kind === 'episode') return `ep|${e.data.vid || e.uuid}`;
  return `mv|${e.data.twin ? [e.uuid, e.data.twin].sort()[0] : e.data.imdb || e.uuid}`;
}

function resume(profile, limit = 20, types) {
  // Une seule fois par titre ; la version la plus complete (duree connue) l'emporte.
  const byKey = new Map();
  for (const r of st.udResume.all(profile.id, 200)) {
    const e = ids.get(r.uuid);
    if (!e || !['movie', 'episode'].includes(e.kind)) continue;
    const k = sameKey(e);
    if (!byKey.has(k) || (!byKey.get(k).data.runtime && e.data.runtime)) byKey.set(k, e);
  }
  return [...byKey.values()]
    .map((e) => lightDto(profile, e))
    .filter((d) => d && (!types || types.includes(d.Type)))
    .slice(0, limit);
}

function favorites(profile, types) {
  return st.udFavorites
    .all(profile.id)
    .map((r) => lightDto(profile, ids.get(r.uuid)))
    .filter((d) => d && (!types || types.includes(d.Type)));
}

/**
 * "A suivre", comme Jellyfin. Series candidates : toutes celles dont un episode a ete vu, commence
 * ou lance depuis `cutoff` (reglage "jours dans A suivre" des apps), la plus recemment regardee
 * d'abord. Pour chacune : le premier episode sorti et pas vu apres l'episode vu le plus avance
 * (saison puis numero, speciaux a part) ; une nouvelle saison y apparait donc d'elle-meme. Un
 * episode deja commence n'y est que si `resumable` (sinon il est dans "Reprendre"). `rewatching` :
 * pour une serie que l'on revoit, l'episode deja vu qui suit le dernier regarde. Vu et en cours se
 * lisent sur les deux versions de la serie (tt... / tmdb:...).
 */
async function nextUp(profile, { start = 0, limit = 20, seriesId, cutoff = 0, resumable = true, rewatching = false } = {}) {
  const memoKey = JSON.stringify([start, limit, seriesId || '', cutoff ? Math.floor(cutoff / 3600e3) : 0, resumable, rewatching]);
  const memo = nextUpMemo.get(profile.id);
  if (memo?.has(memoKey) && memo.get(memoKey).exp > Date.now()) return memo.get(memoKey).items;

  const groups = new Map(); // serie -> { last, recent: { at, seriesUuid }, eps: Map("s:e" -> etat) }
  let wanted = null;
  if (seriesId) {
    const s = ids.get(seriesId);
    if (!s || s.kind !== 'series') return [];
    await seriesTree(profile, s).catch(() => null);
    wanted = seriesKeyOf(ids.get(s.uuid).data);
    groups.set(wanted, { last: 0, recent: { at: 0, seriesUuid: s.uuid }, eps: new Map() });
  }
  for (const r of st.udEpisodesSince.all(profile.id, seriesId ? 0 : cutoff || 0)) {
    const d = JSON.parse(r.data);
    const k = episodeSeriesKey(d) || d.seriesUuid;
    if (!k || (wanted && k !== wanted)) continue;
    let g = groups.get(k);
    if (!g) groups.set(k, (g = { last: 0, recent: { at: -1, seriesUuid: null }, eps: new Map() }));
    const at = r.last_played || 0;
    g.last = Math.max(g.last, at);
    // Version de la serie regardee en dernier : "A suivre" continue dans celle-la.
    if (!wanted && at > g.recent.at && d.seriesUuid) g.recent = { at, seriesUuid: d.seriesUuid };
    const n = Number(d.season);
    if (!n) continue;
    const se = `${n}:${Number(d.episode)}`;
    const cur = g.eps.get(se) || { played: false, position: 0, at: 0 };
    g.eps.set(se, { played: cur.played || !!r.played, position: Math.max(cur.position, r.position || 0), at: Math.max(cur.at, at) });
  }
  const order = [...groups.values()].filter((g) => g.recent.seriesUuid).sort((a, b) => b.last - a.last);
  const out = [];
  // Par lots : les fiches des series se lisent en parallele (cache TMDB, rafraichi en arriere-plan).
  for (let i = 0; i < order.length && out.length < start + limit; i += 8) {
    const found = await Promise.all(order.slice(i, i + 8).map((g) => nextOfSeries(profile, g, { resumable, rewatching }).catch(() => [])));
    for (const items of found) out.push(...items);
  }
  const items = out.slice(start, start + limit);
  if (!nextUpMemo.has(profile.id)) nextUpMemo.set(profile.id, new Map());
  nextUpMemo.get(profile.id).set(memoKey, { items, exp: Date.now() + 60e3 });
  return items;
}

// Resultats recents de "A suivre" (une minute), oublies a chaque changement de vu / reprise.
const nextUpMemo = new Map();

/** Episode(s) "A suivre" d'une serie candidate. */
async function nextOfSeries(profile, g, { resumable, rewatching }) {
  const series = ids.get(g.recent.seriesUuid);
  if (!series || series.kind !== 'series') return [];
  const tree = await seriesTree(profile, series);
  const now = Date.now();
  // Episodes sortis, dans l'ordre (saison puis numero), sans les speciaux.
  const flat = tree.seasons.filter((s) => s.n !== 0).flatMap((s) => s.episodes).filter((e) => e && isAired(e.data.released, now));
  const state = (e) => g.eps.get(`${e.data.season}:${e.data.episode}`) || { played: false, position: 0, at: 0 };
  let furthest = -1;
  flat.forEach((e, i) => {
    if (state(e).played) furthest = i;
  });
  const picks = [];
  const next = flat.slice(furthest + 1).find((e) => !state(e).played);
  if (next && (resumable || !(state(next).position > 0))) picks.push(next);
  if (rewatching) {
    let last = -1;
    flat.forEach((e, i) => {
      if (state(e).played && (last < 0 || state(e).at > state(flat[last]).at)) last = i;
    });
    const again = last >= 0 ? flat.slice(last + 1).find((e) => state(e).played) : null;
    if (again && again !== next) picks.push(again);
  }
  const fresh = ids.get(series.uuid);
  return picks.map((e) => dto.episodeItem(e.uuid, e, fresh, udRow(profile, e.uuid)));
}

// ---- Images -----------------------------------------------------------------

async function imageUrl(id, type, index = 0, imageTag = '') {
  const e = ids.get(id);
  if (!e) return null;
  const t = String(type).toLowerCase();
  const d = e.data;
  const pick = (src) => {
    if (t === 'primary') return src.poster;
    if (t === 'backdrop' || t === 'thumb' || t === 'banner' || t === 'art') return src.background || src.poster;
    if (t === 'logo') return src.logo;
    return null;
  };
  switch (e.kind) {
    case 'movie':
    case 'series':
    case 'collection':
    case 'colcat':
      return pick(d);
    case 'colfolder':
      // Icone demandee avec l'etiquette du GIF (apps Jellyfin) : le GIF, sinon l'image fixe.
      if (d.gif && (t === 'primary' || t === 'thumb') && imageTag && imageTag === dto.tag(d.gif)) return d.gif;
      // Vignette = icone (le fond peut etre le GIF, que les apps Emby n'affichent pas).
      if (t === 'thumb') return d.poster || d.background;
      return pick(d);
    case 'season': {
      const s = ids.get(d.seriesUuid);
      return s ? pick(s.data) : null;
    }
    case 'episode': {
      const s = ids.get(d.seriesUuid);
      if (t === 'primary' || t === 'thumb') return d.thumbnail || s?.data.background || s?.data.poster;
      return s ? pick(s.data) : null;
    }
    case 'view':
      return libraryImages.custom(config.getProfile(d.profileId), d.key) || d.image || null;
    case 'person':
      return t === 'primary' ? d.photo : null;
    default:
      return null;
  }
}

// ---- Prechauffage ----------------------------------------------------------------
// Bibliotheques puis dossiers des collections, prepares en arriere-plan dans l'ordre du
// catalogue : une app qui en ouvre un recoit aussitot ses premiers titres (l'app Emby en
// demande 300 d'un coup). Une liste deja en cache ne coute presque rien.

const WARM_ITEMS = 300;
const WARM_EVERY = 2 * 3600e3;
const WARM_DELAY = 60e3;
let warmTimer = null;
let warming = false;

async function warmLibraries() {
  if (warming) return;
  warming = true;
  const t0 = Date.now();
  let lists = 0;
  const done = new Set();
  const warmOne = async (view, filter, sort) => {
    // Meme liste pour plusieurs profils (meme filtre) : une seule fois.
    const k = `${view.key}|${filter?.key || ''}|${sort || ''}`;
    if (done.has(k)) return;
    done.add(k);
    try {
      await catalog.slice(view, 0, WARM_ITEMS, undefined, filter, sort);
      lists++;
    } catch (e) {
      log(`[warm] ${view.key} : ${e.message}`);
    }
  };
  try {
    const profiles = config.get().profiles.filter((p) => !p.disabled);
    const shelves = [];
    for (const profile of profiles) {
      const filter = listFilter(profile);
      for (const view of catalog.views(profile)) {
        await warmOne(view, filter);
        if (view.type !== 'nuviocol') continue;
        // Collection : ses dossiers et sous-dossiers, apres toutes les bibliotheques.
        const c = collections.byId(view.catId.slice(4));
        if (c) for (const v of collections.warmViews(c)) shelves.push({ view: v, filter });
      }
    }
    for (const s of shelves) await warmOne(s.view, s.filter, s.sort);
    log(`[warm] ${lists} listes prechauffees en ${Math.round((Date.now() - t0) / 1000)} s`);
  } finally {
    warming = false;
  }
}

/** Lance le prechauffage peu apres le demarrage, puis regulierement. */
function startWarming() {
  clearTimeout(warmTimer);
  const run = () => {
    warmLibraries()
      .catch((e) => log(`[warm] ${e.message}`))
      .finally(() => {
        warmTimer = setTimeout(run, WARM_EVERY);
        warmTimer.unref();
      });
  };
  warmTimer = setTimeout(run, WARM_DELAY);
  warmTimer.unref();
}

module.exports = {
  udRow,
  forgetPlayed,
  metaFor,
  keepReleased,
  similar,
  registerMetas,
  lightDto,
  metasToDtos,
  seriesTree,
  itemDto,
  viewByUuid,
  viewItems,
  seasonsOf,
  episodesOf,
  children,
  page,
  resume,
  favorites,
  nextUp,
  imageUrl,
  warmLibraries,
  startWarming
};
