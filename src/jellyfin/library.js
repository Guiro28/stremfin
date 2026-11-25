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
      return series ? seasonUserData(profile, series, entry.data.season, dto.seasonItem(entry.uuid, series, entry.data.season, udRow(profile, entry.uuid))) : null;
    }
    case 'collection':
      return dto.boxSetItem(entry.uuid, entry.data, udRow(profile, entry.uuid));
    case 'colfolder':
    case 'colcat':
      return dto.folderItem(entry.uuid, entry.data, udRow(profile, entry.uuid));
    case 'view':
      // Image choisie dans l'admin, sinon celle generee avec les jaquettes, sinon le fond du titre le plus populaire.
      return dto.viewItem(entry.uuid, entry.data, viewImage(profile, entry));
    case 'genre':
      return dto.genreItem(entry.data.name);
    case 'person':
      return dto.personItem(entry.uuid, entry.data);
    case 'channel':
      return require('./livetv').channelFromEntry(profile, entry);
    case 'livetv':
      return require('./livetv').viewDto(profile);
    case 'replay':
      return require('./livetv').replayViewDto(profile);
    case 'replaychan': {
      const lt = require('./livetv');
      const r = require('../iptv/store').channel(entry.data.chan);
      return r ? lt.replayFolderDto(profile, r) : null;
    }
    case 'replayprog':
      return require('./livetv').replayEntryDto(profile, entry);
    case 'recording':
      return require('./livetv').recordingFromEntry(profile, entry);
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
  const regs = [];
  const seasons = seasonGroups(profile, meta, now).map(({ n, list }) => {
    const seasonKey = `season|${series.data.sid}|${n}`;
    const seasonUuid = ids.uuidOf(seasonKey);
    regs.push({ key: seasonKey, kind: 'season', data: { seriesUuid: series.uuid, type: series.data.type, seriesSid: series.data.sid, season: n } });
    const eps = list
      .map(({ v, episode }) => {
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
            episode,
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
  saveAired(series, seasons.map((s) => ({ n: s.n, episodes: s.episodes.map((e) => e?.data || {}) })), now);
  return { meta, seasons };
}

/**
 * Episodes d'une fiche ranges par saison, avec leur numero : [{ n, list: [{ v, episode }] }].
 * Saisons croissantes, les "speciaux" (saison 0) a la fin.
 */
function seasonGroups(profile, meta, now = Date.now()) {
  // Episodes pas encore diffuses : masques par le reglage du serveur, sauf pour un profil qui
  // a choisi "Afficher les episodes manquants" dans l'app (ils s'affichent alors grises).
  const hide = config.get().settings.hideUnreleased && !profile.displayMissingEpisodes;
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
  const numbers = [...bySeason.keys()].sort((a, b) => (a === 0) - (b === 0) || a - b);
  return numbers.map((n) => ({
    n,
    list: bySeason
      .get(n)
      .sort((a, b) => (Number(a.v.episode ?? a.v.number) || 0) - (Number(b.v.episode ?? b.v.number) || 0) || a.i - b.i)
      .map(({ v }, idx) => ({ v, episode: Number(v.episode ?? v.number) || idx + 1 }))
  }));
}

/** Compte les episodes sortis d'une serie d'apres sa fiche, sans enregistrer ses episodes. */
async function countFromMeta(profile, series) {
  const meta = await metaFor(profile, series.data.type || 'series', series.data.sid);
  if (!meta) return;
  const now = Date.now();
  const groups = seasonGroups(profile, meta, now);
  saveAired(series, groups.map(({ n, list }) => ({ n, episodes: list.map(({ v, episode }) => ({ episode, released: v.released, vid: v.id })) })), now);
}

/** Episode sorti (ou sans date connue) ? */
function isAired(released, now = Date.now()) {
  const t = Date.parse(released || '');
  return !Number.isFinite(t) || t <= now;
}

// ---- Episodes sortis : pastille "episodes restants" -------------------------
// Comme Polyfin : chaque serie garde la liste de ses episodes deja sortis ("saison:episode"), et
// la pastille compte ceux que le profil n'a pas vus parmi eux. Un episode vu qui n'est pas dans la
// liste (numerotation differente d'un import Trakt / Simkl, episode en double) ne fausse rien.

/** Episodes sortis en plages compactes : "1:1-10,2:1-8.10" (saison:episodes). */
function encodeAired(pairs) {
  const by = new Map();
  for (const [s, e] of pairs) {
    if (!Number.isInteger(s) || !Number.isInteger(e)) continue;
    if (!by.has(s)) by.set(s, new Set());
    by.get(s).add(e);
  }
  return [...by.keys()]
    .sort((a, b) => a - b)
    .map((s) => {
      const nums = [...by.get(s)].sort((a, b) => a - b);
      const runs = [];
      for (let i = 0; i < nums.length; ) {
        let j = i;
        while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++;
        runs.push(i === j ? `${nums[i]}` : `${nums[i]}-${nums[j]}`);
        i = j + 1;
      }
      return `${s}:${runs.join('.')}`;
    })
    .join(',');
}

const airedMemo = new Map();

/** Episodes sortis d'une serie ("saison:episode"), ou null s'ils ne sont pas encore connus. */
function airedSet(data) {
  const str = data?.airedKeys;
  if (typeof str !== 'string') return null;
  let set = airedMemo.get(str);
  if (set) return set;
  set = new Set();
  for (const part of str.split(',')) {
    const [s, runs] = part.split(':');
    if (!runs) continue;
    for (const r of runs.split('.')) {
      const [a, b = a] = r.split('-').map(Number);
      if (!Number.isInteger(a) || !Number.isInteger(b) || b - a > 20000) continue;
      for (let e = a; e <= b; e++) set.add(`${s}:${e}`);
    }
  }
  if (airedMemo.size > 3000) airedMemo.delete(airedMemo.keys().next().value);
  airedMemo.set(str, set);
  return set;
}

/** Enregistre sur la serie ses episodes sortis (seasons : [{ n, episodes: [{ episode, released, vid }] }]). */
function saveAired(series, seasons, now = Date.now()) {
  const pairs = [];
  for (const s of seasons) for (const e of s.episodes) if (isAired(e.released, now)) pairs.push([s.n, e.episode]);
  const airedKeys = encodeAired(pairs);
  const airedCount = pairs.filter(([n]) => n !== 0).length;
  // Debut de l'id video des episodes (tt... ou tmdb:N) : identite de la serie commune a ses versions.
  const first = seasons.find((s) => s.n !== 0)?.episodes.find((e) => e.vid);
  const vidKey = String(first?.vid || '').replace(/:\d+:\d+$/, '') || undefined;
  // airedAt : date du calcul (refait chaque jour, pour les nouveaux episodes).
  const stale = !series.data.airedAt || now - series.data.airedAt > 24 * 3600e3;
  if (airedKeys !== series.data.airedKeys || vidKey !== series.data.vidKey || stale) {
    ids.register(series.key, series.kind, { airedKeys, airedCount, vidKey, airedAt: now });
  }
}

// Lecture des fiches pour compter les episodes : 8 a la fois au plus, une seule lecture par serie
// en cours, une nouvelle tentative par heure au plus apres un echec. Deux files : les series d'une
// reponse attendue passent avant celles du prechauffage et des recomptages quotidiens.
const counting = new Map(); // uuid -> promesse
const countTried = new Map(); // uuid -> derniere lecture
const countUrgent = [];
const countLow = [];
const lowRuns = new Map(); // uuid -> lecture en attente dans countLow
let countActive = 0;

function countNext() {
  while (countActive < 8) {
    const run = countUrgent.shift() || countLow.shift();
    if (!run) return;
    run();
  }
}

function countAired(profile, uuid, low = false) {
  if (counting.has(uuid)) {
    // Deja en attente en arriere-plan, et maintenant attendue par une reponse : passe devant.
    const run = !low && lowRuns.get(uuid);
    if (run) {
      lowRuns.delete(uuid);
      const i = countLow.indexOf(run);
      if (i >= 0) countLow.splice(i, 1);
      countUrgent.push(run);
      countNext();
    }
    return counting.get(uuid);
  }
  if (Date.now() - (countTried.get(uuid) || 0) < 3600e3) return Promise.resolve();
  // Serie IPTV : ses episodes viennent du fournisseur (get_series_info) ; pas de comptage en serie
  // depuis les listes (un appel par serie chez lui), seulement a l'ouverture de sa fiche.
  if (/^iptv:/.test(String(ids.get(uuid)?.data?.sid || ''))) return Promise.resolve();
  countTried.set(uuid, Date.now());
  if (countTried.size > 20000) countTried.delete(countTried.keys().next().value);
  const p = new Promise((resolve) => {
    const run = () => {
      lowRuns.delete(uuid);
      countActive++;
      Promise.resolve()
        .then(() => {
          const e = ids.get(uuid);
          return e?.kind === 'series' ? countFromMeta(profile, e) : null;
        })
        .catch(() => {})
        .finally(() => {
          countActive--;
          counting.delete(uuid);
          resolve();
          countNext();
        });
    };
    if (low) {
      lowRuns.set(uuid, run);
      countLow.push(run);
    } else {
      countUrgent.push(run);
    }
  });
  counting.set(uuid, p);
  countNext();
  return p;
}

/** Prechauffage : series d'une liste dont les episodes sortis sont inconnus ou comptes il y a plus d'un jour. */
function countAiredSoon(profile, metas) {
  // Enregistrees sans traduction en arriere-plan (elle se fera a leur premier affichage).
  const fresh = [];
  const series = [];
  for (const m of metas || []) {
    if (m?.type !== 'series' || !m.id) continue;
    const key = itemKey('series', m.id);
    const e = ids.get(ids.uuidOf(key));
    if (e) series.push(e);
    else fresh.push({ key, kind: 'series', data: dto.preview(m) });
  }
  if (fresh.length) for (const u of ids.registerMany(fresh)) series.push(ids.get(u));
  for (const e of series) {
    if (!e) continue;
    if (!airedSet(e.data) || Date.now() - (e.data.airedAt || 0) > 24 * 3600e3) countAired(profile, e.uuid, true);
  }
}

// Series lues pour une reponse, et attente maximale (comme Polyfin) : celles lues plus tard ont
// leur pastille a l'affichage suivant.
const COUNT_READ = 300;
const COUNT_WAIT = 1500;

/**
 * Pastilles des series d'une reponse (liste d'elements deja construits) : les series dont les
 * episodes sortis ne sont pas connus sont lues tout de suite (1,5 s au plus), celles comptees il y a
 * plus d'un jour sont relues en arriere-plan.
 */
async function withSeriesCounts(profile, items) {
  const series = [];
  for (const d of items) {
    if (d?.Type !== 'Series' || !d.UserData) continue;
    const e = ids.get(d.Id);
    if (e?.kind === 'series') series.push({ d, e });
  }
  if (!series.length) return items;
  const waits = [];
  for (const { e } of series) {
    if (!airedSet(e.data)) {
      if (waits.length < COUNT_READ) waits.push(countAired(profile, e.uuid));
    } else if (Date.now() - (e.data.airedAt || 0) > 24 * 3600e3) {
      countAired(profile, e.uuid, true);
    }
  }
  if (waits.length) {
    let timer;
    await Promise.race([Promise.all(waits), new Promise((r) => (timer = setTimeout(r, COUNT_WAIT)))]);
    clearTimeout(timer);
  }
  for (const { d, e } of series) seriesUserData(profile, ids.get(e.uuid) || e, d);
  return items;
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

function forgetPlayed(profileId) {
  playedCache.delete(profileId);
  nextUpMemo.delete(profileId);
}

function playedBySeries(profileId) {
  if (playedCache.has(profileId)) return playedCache.get(profileId);
  const map = new Map();
  for (const r of st.udPlayedEpisodes.all(profileId)) {
    const d = JSON.parse(r.data);
    if (!Number.isFinite(Number(d.season))) continue;
    // Range sous l'identite de la serie (debut de l'id video) et sous l'id de sa version
    // (tt... ou tmdb:...) : une serie se retrouve meme si sa fiche n'a jamais ete ouverte.
    for (const k of new Set([episodeSeriesKey(d), d.seriesSid])) {
      if (!k) continue;
      if (!map.has(k)) map.set(k, new Set());
      map.get(k).add(`${d.season}:${d.episode}`);
    }
  }
  playedCache.set(profileId, map);
  return map;
}

/**
 * Episodes sortis d'une serie (season : une saison, sinon toute la serie hors speciaux) et ceux que
 * le profil a vus parmi eux, quelle que soit la version de la serie (tt... / tmdb:...) sur laquelle
 * ils l'ont ete. null tant que les episodes sortis ne sont pas connus.
 */
function airedCounts(profile, data, season) {
  const aired = airedSet(data);
  if (!aired) return null;
  const played = playedBySeries(profile.id);
  const seen = [...new Set([seriesKeyOf(data), data.sid])].map((k) => k && played.get(k)).filter(Boolean);
  let total = 0;
  let watched = 0;
  for (const k of aired) {
    const s = Number(k.slice(0, k.indexOf(':')));
    if (season === undefined ? s === 0 : s !== season) continue;
    total++;
    if (seen.some((set) => set.has(k))) watched++;
  }
  return { total, watched };
}

function applyCounts(d, c) {
  d.UserData.UnplayedItemCount = c.total - c.watched;
  d.UserData.Played = c.total > 0 && c.watched >= c.total;
  d.UserData.PlayedPercentage = c.total ? (c.watched / c.total) * 100 : 0;
  return d;
}

/**
 * Serie : coche quand tous les episodes sortis sont vus, pastille du nombre d'episodes restants
 * (comme Jellyfin), sur toutes les series, commencees ou non, des que ses episodes sont connus.
 */
function seriesUserData(profile, entry, d) {
  if (!entry?.data || !d?.UserData) return d;
  const c = airedCounts(profile, entry.data);
  return c ? applyCounts(d, c) : d;
}

/** Saison : meme pastille, d'apres les episodes sortis de cette saison. */
function seasonUserData(profile, series, n, d) {
  if (!series?.data || !d?.UserData) return d;
  const c = airedCounts(profile, series.data, Number(n));
  return c ? applyCounts(d, c) : d;
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
      seriesUserData(profile, ids.get(entry.uuid), d);
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
    const fresh = ids.get(series.uuid);
    return seasonUserData(profile, fresh, entry.data.season, dto.seasonItem(entry.uuid, fresh, entry.data.season, udRow(profile, entry.uuid), s?.episodes.length));
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

async function viewItems(profile, view, { start = 0, limit = 50, genre, sort } = {}) {
  const { metas, total } = await catalog.slice(view, start, limit, genre, releasedFilter(profile), sort);
  let items = metasToDtos(profile, metas);
  if (profile.hideWatched) items = items.filter((i) => !(i.Type === 'Movie' && i.UserData.Played));
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
  // Pastille de chaque saison : ses episodes sortis pas encore vus (sur l'une ou l'autre version).
  return tree.seasons.map((s) => seasonUserData(profile, fresh, s.n, dto.seasonItem(s.uuid, fresh, s.n, udRow(profile, s.uuid), s.episodes.length)));
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
  // Vue TV en direct : vide, comme dans Jellyfin (les apps passent par /LiveTv/Channels).
  if (entry.kind === 'livetv') return { items: [], total: 0 };
  // Replay : dossiers des chaines, puis leurs programmes passes.
  if (entry.kind === 'replay' || entry.kind === 'replaychan') return require('./livetv').replayChildren(profile, entry, opts);
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

/** Image de la tuile d'une bibliotheque : choisie, sinon generee (jaquettes + nom), sinon le fond du 1er titre. */
function viewImage(profile, entry) {
  const d = entry.data;
  return libraryImages.custom(profile, d.key) || libraryImages.autoImage(profile, { uuid: entry.uuid, key: d.key, name: d.name, type: d.type }) || d.image;
}

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
      return viewImage(config.getProfile(d.profileId), e) || null;
    case 'person':
      return t === 'primary' ? d.photo : null;
    case 'channel':
      return t === 'primary' || t === 'thumb' || t === 'logo' ? require('./livetv').imageUrl(e) : null;
    case 'replaychan':
    case 'replayprog':
      return t === 'primary' || t === 'thumb' || t === 'backdrop' ? require('./livetv').replayImage(e) : null;
    case 'recording':
      return t === 'primary' || t === 'thumb' || t === 'backdrop' ? require('../iptv/dvr').timer(d.timer)?.image || null : null;
    default:
      return null;
  }
}

// ---- Prechauffage ----------------------------------------------------------------
// Bibliotheques puis dossiers des collections, prepares en arriere-plan dans l'ordre du
// catalogue : une app qui en ouvre un recoit aussitot ses premiers titres (l'app Emby en
// demande 300 d'un coup). Une liste deja en cache ne coute presque rien.

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
  const warmOne = async (profile, view, filter, sort) => {
    // Meme liste pour plusieurs profils (meme filtre) : une seule fois.
    const k = `${view.key}|${filter?.key || ''}|${sort || ''}`;
    if (done.has(k)) return;
    done.add(k);
    try {
      // Jusqu'au nombre de titres du reglage, gardes en base.
      const metas = await catalog.warm(view, filter, sort);
      // Pastilles "episodes restants" pretes des le premier affichage.
      countAiredSoon(profile, metas);
      lists++;
    } catch (e) {
      log(`[warm] ${view.key} : ${e.message}`);
    }
  };
  try {
    const profiles = config.get().profiles.filter((p) => !p.disabled);
    const shelves = [];
    for (const profile of profiles) {
      const filter = releasedFilter(profile);
      for (const view of catalog.views(profile)) {
        await warmOne(profile, view, filter);
        if (view.type !== 'nuviocol') continue;
        // Collection : ses dossiers et sous-dossiers, apres toutes les bibliotheques.
        const c = collections.byId(view.catId.slice(4));
        if (c) for (const v of collections.warmViews(c)) shelves.push({ profile, view: v, filter });
      }
    }
    for (const s of shelves) await warmOne(s.profile, s.view, s.filter, s.sort);
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
  withSeriesCounts,
  seriesUserData,
  seasonUserData,
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
