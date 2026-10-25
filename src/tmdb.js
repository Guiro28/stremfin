// Integration TMDB native : fiches (dans la langue choisie) pour tous les identifiants
// tt / tmdb, saisons et episodes, recommandations, et catalogues propres a Stremfin
// (tendances, plateformes, sagas) exposes comme un addon virtuel.
const config = require('./config');
const cache = require('./cache');
const { getJson } = require('./http');

const API = 'https://api.themoviedb.org/3';
const IMG = 'https://image.tmdb.org/t/p/';
const HOUR = 3600e3;
const DAY = 24 * HOUR;

const ADDON_URL = 'stremfin://tmdb';

// Plateformes : liste modifiable dans l'admin (settings.providers).
function providers() {
  return config.get().settings.providers || [];
}

const LABELS = {
  fr: {
    trending: 'Tendances', popular: 'Populaires', toprated: 'Les mieux notés', nowMovie: 'Au cinéma',
    nowSeries: 'En cours de diffusion', sagas: 'Sagas', search: 'Recherche', movie: 'Films', series: 'Séries',
    platforms: 'Plateformes'
  },
  en: {
    trending: 'Trending', popular: 'Popular', toprated: 'Top rated', nowMovie: 'In theaters',
    nowSeries: 'On the air', sagas: 'Collections', search: 'Search', movie: 'Movies', series: 'Shows',
    platforms: 'Platforms'
  },
  es: {
    trending: 'Tendencias', popular: 'Populares', toprated: 'Mejor valoradas', nowMovie: 'En cines',
    nowSeries: 'En emisión', sagas: 'Sagas', search: 'Búsqueda', movie: 'Películas', series: 'Series',
    platforms: 'Plataformas'
  },
  de: {
    trending: 'Trends', popular: 'Beliebt', toprated: 'Am besten bewertet', nowMovie: 'Im Kino',
    nowSeries: 'Läuft gerade', sagas: 'Filmreihen', search: 'Suche', movie: 'Filme', series: 'Serien',
    platforms: 'Plattformen'
  },
  it: {
    trending: 'Tendenze', popular: 'Popolari', toprated: 'I più votati', nowMovie: 'Al cinema',
    nowSeries: 'In onda', sagas: 'Saghe', search: 'Ricerca', movie: 'Film', series: 'Serie',
    platforms: 'Piattaforme'
  }
};

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function apiKey() {
  return config.get().settings.tmdbApiKey || process.env.TMDB_API_KEY || '';
}

function enabled() {
  return !!apiKey();
}

function lang() {
  return config.get().settings.metadataLanguage || 'fr-FR';
}

function iso() {
  return lang().split('-')[0];
}

function region() {
  return (lang().split('-')[1] || 'FR').toUpperCase();
}

function labels() {
  return LABELS[iso()] || LABELS.en;
}

function img(path, size) {
  return path ? IMG + size + path : undefined;
}

// ---- Requetes ----------------------------------------------------------------

// Limite de requetes simultanees vers TMDB.
let active = 0;
const waiting = [];
async function slot(fn) {
  if (active >= 12) await new Promise((r) => waiting.push(r));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    waiting.shift()?.();
  }
}

/** GET TMDB en cache. La cle API n'entre pas dans la cle de cache. */
function get(path, params = {}, { ttl = DAY, stale = 7 * DAY, language = lang() } = {}) {
  const q = new URLSearchParams({ language, ...params });
  const ck = `tmdb|${path}|${q}`;
  return cache.cached(
    ck,
    ttl,
    () => slot(() => getJson(`${API}${path}?${q}&api_key=${apiKey()}`, { timeout: 15000 })),
    { stale }
  );
}

/** Verifie une cle (utilise par l'admin avant de l'enregistrer). */
/** Plateformes de streaming connues de TMDB pour la region (choix dans l'admin). */
async function availableProviders() {
  if (!enabled()) return [];
  const [m, t] = await Promise.all([
    get('/watch/providers/movie', { watch_region: region() }, { ttl: 7 * DAY }),
    get('/watch/providers/tv', { watch_region: region() }, { ttl: 7 * DAY })
  ]);
  const all = new Map();
  for (const p of [...(m.results || []), ...(t.results || [])]) {
    if (!all.has(p.provider_id)) {
      all.set(p.provider_id, {
        id: p.provider_id,
        name: p.provider_name,
        logo: img(p.logo_path, 'w92'),
        logoLarge: img(p.logo_path, 'original'),
        priority: p.display_priorities?.[region()] ?? 999
      });
    }
  }
  return [...all.values()].sort((a, b) => a.priority - b.priority);
}

/** Infos TMDB d'une plateforme (nom, logo officiel), ou null si inconnue dans la region. */
async function providerInfo(id) {
  const list = await availableProviders().catch(() => []);
  return list.find((p) => p.id === Number(id)) || null;
}

async function checkKey(key) {
  await getJson(`${API}/configuration?api_key=${encodeURIComponent(key)}`, { timeout: 10000 });
  return true;
}

// ---- Identifiants -------------------------------------------------------------

/** Stremio (tt..., tmdb:123) -> { mediaType: movie|tv, id } ou null. */
async function resolve(type, sid) {
  const mediaType = type === 'series' ? 'tv' : type === 'movie' ? 'movie' : null;
  if (!mediaType || !sid) return null;
  const m = String(sid).match(/^tmdb:(\d+)$/);
  if (m) return { mediaType, id: Number(m[1]) };
  if (/^tt\d+$/.test(sid)) {
    const r = await get(`/find/${sid}`, { external_source: 'imdb_id' }, { ttl: 30 * DAY, stale: 90 * DAY });
    const hit = (mediaType === 'movie' ? r.movie_results : r.tv_results)?.[0];
    return hit ? { mediaType, id: hit.id } : null;
  }
  return null;
}

// ---- Fiches -------------------------------------------------------------------

function details(mediaType, id) {
  const append = ['credits', 'images', 'videos', 'external_ids', 'recommendations', mediaType === 'movie' ? 'release_dates' : 'content_ratings'];
  return get(`/${mediaType}/${id}`, {
    append_to_response: append.join(','),
    include_image_language: `${iso()},en,null`,
    include_video_language: `${iso()},en`
  });
}

function pickLogo(logos) {
  const list = logos || [];
  const by = (l) => list.filter((x) => x.iso_639_1 === l).sort((a, b) => b.vote_average - a.vote_average)[0];
  return (by(iso()) || by('en') || list[0])?.file_path;
}

function certification(d, mediaType) {
  if (mediaType === 'movie') {
    const r = (d.release_dates?.results || []).find((x) => x.iso_3166_1 === region());
    return (r?.release_dates || []).map((x) => x.certification).find(Boolean);
  }
  return (d.content_ratings?.results || []).find((x) => x.iso_3166_1 === region())?.rating || undefined;
}

let genreNames = { movie: {}, tv: {} };

/** Apercu (format meta Stremio) a partir d'un resultat de liste TMDB. */
function previewOf(r, type) {
  const mediaType = type === 'series' ? 'tv' : 'movie';
  const date = r.release_date || r.first_air_date || '';
  return {
    id: `tmdb:${r.id}`,
    type,
    name: r.title || r.name,
    poster: img(r.poster_path, 'w500'),
    background: img(r.backdrop_path, 'w1280'),
    description: r.overview || undefined,
    releaseInfo: date.slice(0, 4) || undefined,
    released: date ? `${date}T00:00:00.000Z` : undefined,
    imdbRating: r.vote_average ? r.vote_average.toFixed(1) : undefined,
    genres: (r.genre_ids || []).map((g) => genreNames[mediaType][g]).filter(Boolean),
    moviedb_id: r.id,
    fr: true
  };
}

/** Fiche complete au format meta Stremio (ce qu'attend le reste de Stremfin). */
function toMeta(type, sid, d, mediaType) {
  const isMovie = mediaType === 'movie';
  const imdb = d.external_ids?.imdb_id || d.imdb_id || undefined;
  const date = d.release_date || d.first_air_date || '';
  const ended = ['Ended', 'Canceled'].includes(d.status);
  const runtime = isMovie ? d.runtime : d.episode_run_time?.[0] || d.last_episode_to_air?.runtime;
  const crew = d.credits?.crew || [];
  const links = [];
  for (const c of crew.filter((x) => x.job === 'Director').slice(0, 3)) links.push({ name: c.name, category: 'Directors' });
  for (const c of (d.created_by || []).slice(0, 3)) links.push({ name: c.name, category: 'Writers' });
  for (const c of crew.filter((x) => ['Screenplay', 'Writer'].includes(x.job)).slice(0, 4)) links.push({ name: c.name, category: 'Writers' });
  const videos = (d.videos?.results || [])
    .filter((v) => v.site === 'YouTube' && ['Trailer', 'Teaser'].includes(v.type))
    .sort((a, b) => (a.iso_639_1 === iso() ? 0 : 1) - (b.iso_639_1 === iso() ? 0 : 1) || (a.type === 'Trailer' ? 0 : 1) - (b.type === 'Trailer' ? 0 : 1));
  return {
    id: sid,
    type,
    name: d.title || d.name,
    description: d.overview || undefined,
    poster: img(d.poster_path, 'w500'),
    background: img(d.backdrop_path, 'w1280'),
    logo: img(pickLogo(d.images?.logos), 'w500'),
    releaseInfo: isMovie ? date.slice(0, 4) : `${date.slice(0, 4)}–${ended ? (d.last_air_date || '').slice(0, 4) : ''}`,
    released: date ? `${date}T00:00:00.000Z` : undefined,
    imdbRating: d.vote_average ? d.vote_average.toFixed(1) : undefined,
    genres: (d.genres || []).map((g) => g.name),
    runtime: runtime ? `${runtime} min` : undefined,
    imdb_id: imdb,
    moviedb_id: d.id,
    tagline: d.tagline || undefined,
    certification: certification(d, mediaType),
    studios: (isMovie ? d.production_companies : d.networks || []).map((x) => x.name).slice(0, 5),
    app_extras: {
      cast: (d.credits?.cast || []).slice(0, 25).map((c) => ({ name: c.name, character: c.character, photo: img(c.profile_path, 'w185') }))
    },
    links,
    trailers: videos.slice(0, 3).map((v) => ({ source: v.key, type: v.type })),
    collection: d.belongs_to_collection
      ? { id: d.belongs_to_collection.id, name: d.belongs_to_collection.name, poster: img(d.belongs_to_collection.poster_path, 'w500'), background: img(d.belongs_to_collection.backdrop_path, 'w1280') }
      : undefined,
    recommendations: (d.recommendations?.results || []).slice(0, 20).map((r) => previewOf(r, type)),
    fr: true
  };
}

/** Si le resume manque dans la langue choisie, on prend celui en anglais. */
async function withFallbackOverview(mediaType, id, d) {
  if (d.overview || iso() === 'en') return d;
  try {
    const en = await get(`/${mediaType}/${id}`, {}, { language: 'en-US' });
    return { ...d, overview: en.overview };
  } catch {
    return d;
  }
}

/** Episodes de toutes les saisons (20 saisons par requete grace a append_to_response). */
async function episodes(d, imdb) {
  const numbers = (d.seasons || []).map((s) => s.season_number);
  const out = [];
  for (let i = 0; i < numbers.length; i += 20) {
    const chunk = numbers.slice(i, i + 20);
    const r = await get(`/tv/${d.id}`, { append_to_response: chunk.map((n) => `season/${n}`).join(',') }, { ttl: 12 * HOUR });
    for (const n of chunk) {
      for (const e of r[`season/${n}`]?.episodes || []) {
        const tmdbVid = `tmdb:${d.id}:${n}:${e.episode_number}`;
        out.push({
          // Id tt:saison:episode si connu : c'est le format que comprennent presque tous les addons de sources.
          id: imdb ? `${imdb}:${n}:${e.episode_number}` : tmdbVid,
          tmdbVid,
          season: n,
          episode: e.episode_number,
          name: e.name,
          overview: e.overview || undefined,
          thumbnail: img(e.still_path, 'w780'),
          released: e.air_date ? `${e.air_date}T00:00:00.000Z` : undefined,
          runtime: e.runtime ? `${e.runtime} min` : undefined
        });
      }
    }
  }
  return out;
}

/** Fiche complete (series : avec les episodes). null si TMDB ne connait pas l'id. */
async function meta(type, sid) {
  if (!enabled()) return null;
  const r = await resolve(type, sid);
  if (!r) return null;
  const d = await withFallbackOverview(r.mediaType, r.id, await details(r.mediaType, r.id));
  const m = toMeta(type, sid, d, r.mediaType);
  if (r.mediaType === 'tv') m.videos = await episodes(d, m.imdb_id);
  return m;
}

/** Version legere (sans episodes) pour traduire les elements des listes. */
async function previewMeta(type, sid) {
  if (!enabled()) return null;
  const r = await resolve(type, sid);
  if (!r) return null;
  return toMeta(type, sid, await details(r.mediaType, r.id), r.mediaType);
}

// Types de sortie TMDB : 4 = numerique (VOD), 5 = physique (DVD/Blu-ray), 6 = TV.
const HOME_RELEASE = [4, 5, 6];
const THEATRICAL_WINDOW = 180 * DAY;

/**
 * Le titre est-il deja sorti en VOD, DVD ou a la TV ?
 * Series : premiere diffusion passee. Films : sortie numerique/physique/TV passee
 * (n'importe quel pays), ou a defaut sortie en salle de plus de 6 mois.
 * Titre inconnu de TMDB : considere comme disponible (on ne masque pas a l'aveugle).
 */
async function released(type, sid, preview = {}) {
  const now = Date.now();
  if (type === 'series' && preview.released) return Date.parse(preview.released) <= now;
  if (!enabled()) return true;
  try {
    const r = await resolve(type, sid);
    if (!r) return true;
    // Requete legere (dates seules, ~20 Ko) : verifiee pour chaque titre des bibliotheques,
    // la fiche complete (~230 Ko) rendrait l'ouverture d'une bibliotheque tres lente.
    const d = await get(`/${r.mediaType}/${r.id}`, r.mediaType === 'movie' ? { append_to_response: 'release_dates' } : {});
    if (r.mediaType === 'tv') return !!d.first_air_date && Date.parse(d.first_air_date) <= now;
    const dates = (d.release_dates?.results || []).flatMap((c) => c.release_dates || []);
    if (dates.some((x) => HOME_RELEASE.includes(x.type) && Date.parse(x.release_date) <= now)) return true;
    return !!d.release_date && Date.parse(d.release_date) <= now - THEATRICAL_WINDOW;
  } catch {
    return true;
  }
}

async function collection(id) {
  const c = await get(`/collection/${id}`);
  return {
    id: `tmdbcol:${c.id}`,
    type: 'collection',
    name: c.name,
    description: c.overview || undefined,
    poster: img(c.poster_path, 'w500'),
    background: img(c.backdrop_path, 'w1280'),
    parts: (c.parts || [])
      .filter((p) => p.release_date)
      .sort((a, b) => a.release_date.localeCompare(b.release_date))
      .map((p) => previewOf(p, 'movie')),
    fr: true
  };
}

// ---- Catalogues ------------------------------------------------------------------

// Bibliotheques "Mes medias" : grandes categories, triables (nom, date, note) depuis les apps.
const CATEGORIES = [
  { id: 'tmdb-cat-movies', type: 'movie', fr: 'Films', en: 'Movies', es: 'Películas', de: 'Filme', it: 'Film', params: { without_genres: '16,99' } },
  { id: 'tmdb-cat-series', type: 'series', fr: 'Séries TV', en: 'TV shows', es: 'Series de TV', de: 'TV-Serien', it: 'Serie TV', params: { without_genres: '16,99,10762,10763,10764,10767' } },
  { id: 'tmdb-cat-anim-movies', type: 'movie', fr: "Films d'animation", en: 'Animated movies', es: 'Películas de animación', de: 'Animationsfilme', it: 'Film d\'animazione', params: { with_genres: '16' } },
  { id: 'tmdb-cat-anim-series', type: 'series', fr: "Séries d'animation", en: 'Animated series', es: 'Series de animación', de: 'Animationsserien', it: 'Serie d\'animazione', params: { with_genres: '16' } },
  { id: 'tmdb-cat-anime', type: 'series', fr: 'Animés', en: 'Anime', es: 'Anime', de: 'Anime', it: 'Anime', params: { with_genres: '16', with_original_language: 'ja' }, defaultEnabled: false },
  { id: 'tmdb-cat-docs', type: 'movie', fr: 'Documentaires', en: 'Documentaries', es: 'Documentales', de: 'Dokumentarfilme', it: 'Documentari', params: { with_genres: '99' }, defaultEnabled: false },
  { id: 'tmdb-cat-docuseries', type: 'series', fr: 'Séries documentaires', en: 'Docuseries', es: 'Series documentales', de: 'Dokuserien', it: 'Docuserie', params: { with_genres: '99' }, defaultEnabled: false },
  { id: 'tmdb-cat-kids', type: 'series', fr: 'Jeunesse', en: 'Kids', es: 'Infantil', de: 'Kinder', it: 'Bambini', params: { with_genres: '10762' }, defaultEnabled: false }
];

// Rayons de chaque plateforme (dossiers sous la carte de la plateforme).
const PLATFORM_LISTS = [
  { id: 'movies-popular', type: 'movie', fr: 'Films populaires', en: 'Popular movies', es: 'Películas populares', de: 'Beliebte Filme', it: 'Film popolari', sort: 'popularity' },
  { id: 'series-popular', type: 'series', fr: 'Séries populaires', en: 'Popular shows', es: 'Series populares', de: 'Beliebte Serien', it: 'Serie popolari', sort: 'popularity' },
  { id: 'movies-new', type: 'movie', fr: 'Nouveaux films', en: 'New movies', es: 'Películas nuevas', de: 'Neue Filme', it: 'Nuovi film', sort: 'recent' },
  { id: 'series-new', type: 'series', fr: 'Nouvelles séries', en: 'New shows', es: 'Series nuevas', de: 'Neue Serien', it: 'Nuove serie', sort: 'recent' },
  { id: 'movies-top', type: 'movie', fr: 'Films les mieux notés', en: 'Top rated movies', es: 'Películas mejor valoradas', de: 'Bestbewertete Filme', it: 'Film più votati', sort: 'rating' },
  { id: 'series-top', type: 'series', fr: 'Séries les mieux notées', en: 'Top rated shows', es: 'Series mejor valoradas', de: 'Bestbewertete Serien', it: 'Serie più votate', sort: 'rating' }
];

const tr = (x) => x[iso()] || x.en;

/**
 * Tri demande par l'app -> parametres /discover. Les tris par nom ou par date ne gardent que des
 * titres un minimum connus (sinon : des milliers de titres obscurs en tete de liste).
 */
function sortParams(mediaType, sort) {
  const [k, dir = 'desc'] = String(sort || 'popularity').split('.');
  const today = new Date().toISOString().slice(0, 10);
  const dateField = mediaType === 'movie' ? 'primary_release_date' : 'first_air_date';
  switch (k) {
    case 'name':
      return { sort_by: `${mediaType === 'movie' ? 'title' : 'name'}.${dir}`, 'vote_count.gte': 200 };
    case 'date':
      return { sort_by: `${dateField}.${dir}`, [`${dateField}.lte`]: today, 'vote_count.gte': 30 };
    case 'recent':
      return { sort_by: `${dateField}.desc`, [`${dateField}.lte`]: today, 'vote_count.gte': 20 };
    case 'rating':
      return { sort_by: `vote_average.${dir}`, 'vote_count.gte': 500 };
    default:
      return { sort_by: `popularity.${dir}` };
  }
}

/** Plateformes (cartes larges) : premier niveau de la bibliotheque "Plateformes". */
function platformMetas() {
  const images = require('./images');
  return providers().map((p) => {
    const card = images.platformCardUrl(p);
    return { id: `platform:${p.id}`, type: 'platform', name: p.name, poster: card, background: card, providerId: p.id, fr: true };
  });
}

/** Rayons d'une plateforme. */
function platformListMetas(providerId) {
  const p = providers().find((x) => x.id === Number(providerId));
  if (!p) return [];
  const card = require('./images').platformCardUrl(p);
  return PLATFORM_LISTS.map((l) => ({
    id: `plist:${p.id}:${l.id}`,
    type: 'platformlist',
    name: tr(l),
    poster: card,
    background: card,
    providerId: p.id,
    listType: l.type,
    sort: l.sort,
    fr: true
  }));
}

function catalogDefs() {
  const L = labels();
  const defs = [];
  const genres = (t) => Object.values(genreNames[t === 'series' ? 'tv' : 'movie']);
  for (const c of CATEGORIES) {
    defs.push({ type: c.type, id: c.id, name: tr(c), plainName: true, extra: [{ name: 'genre', options: genres(c.type) }, { name: 'skip' }], defaultEnabled: c.defaultEnabled !== false });
  }
  defs.push({ type: 'platforms', id: 'tmdb-platforms', name: L.platforms, plainName: true, extra: [{ name: 'skip' }] });
  for (const type of ['movie', 'series']) {
    const g = { name: 'genre', options: genres(type) };
    // Listes : desormais proposees en option (les categories alimentent "Mes medias").
    defs.push(
      { type, id: 'tmdb-trending', name: L.trending, extra: [{ name: 'skip' }], defaultEnabled: false },
      { type, id: 'tmdb-popular', name: L.popular, extra: [g, { name: 'skip' }], defaultEnabled: false },
      { type, id: 'tmdb-toprated', name: L.toprated, extra: [g, { name: 'skip' }], defaultEnabled: false },
      { type, id: 'tmdb-now', name: type === 'movie' ? L.nowMovie : L.nowSeries, extra: [{ name: 'skip' }], defaultEnabled: false }
    );
    for (const p of providers()) {
      defs.push({ type, id: `tmdb-provider-${p.id}`, name: p.name, extra: [g, { name: 'skip' }], defaultEnabled: false });
    }
    defs.push({ type, id: 'tmdb-search', name: L.search, extra: [{ name: 'search', isRequired: true }] });
  }
  defs.push({ type: 'collection', id: 'tmdb-sagas', name: L.sagas, plainName: true, extra: [{ name: 'skip' }] });
  return defs;
}

/** Addon virtuel, place avant les addons du profil quand une cle TMDB est configuree. */
function addons() {
  if (!enabled()) return [];
  return [
    {
      url: ADDON_URL,
      manifest: { id: 'stremfin.tmdb', name: 'TMDB', version: '1.0.0', resources: ['catalog'], types: ['movie', 'series', 'collection', 'platforms'], catalogs: catalogDefs() }
    }
  ];
}

function genreId(type, name) {
  const map = genreNames[type === 'series' ? 'tv' : 'movie'];
  const hit = Object.entries(map).find(([, n]) => n === name);
  return hit ? hit[0] : null;
}

async function catalog(type, id, extra = {}) {
  const mediaType = type === 'series' ? 'tv' : 'movie';
  const page = Math.floor((Number(extra.skip) || 0) / 20) + 1;
  if (page > 500) return { metas: [] };
  const genre = extra.genre ? genreId(type, extra.genre) : null;
  let path;
  let params = { page };

  if (id === 'tmdb-sagas') return { metas: await sagas(Number(extra.skip) || 0) };
  if (id === 'tmdb-platforms') return { metas: Number(extra.skip) ? [] : platformMetas() };
  const category = CATEGORIES.find((c) => c.id === id);
  if (id === 'tmdb-search') {
    if (!extra.search) return { metas: [] };
    path = `/search/${mediaType}`;
    params.query = extra.search;
  } else if (id === 'tmdb-trending') {
    path = `/trending/${mediaType}/day`;
  } else if (id === 'tmdb-now') {
    path = mediaType === 'movie' ? '/movie/now_playing' : '/tv/on_the_air';
    params.region = region();
  } else if (id === 'tmdb-popular' && !genre && !extra.sort) {
    path = `/${mediaType}/popular`;
    params.region = region();
  } else if (id === 'tmdb-toprated' && !genre && !extra.sort) {
    path = `/${mediaType}/top_rated`;
  } else {
    // Categorie, genre, plateforme ou tri : /discover.
    path = `/discover/${mediaType}`;
    Object.assign(params, category?.params || {}, sortParams(mediaType, extra.sort || (id === 'tmdb-toprated' ? 'rating' : 'popularity')));
    // Genre choisi dans l'app : s'ajoute a celui de la categorie (ET logique).
    if (genre) params.with_genres = [params.with_genres, genre].filter(Boolean).join(',');
    const prov = id.match(/^tmdb-provider-(\d+)$/);
    if (prov) {
      params.with_watch_providers = prov[1];
      params.watch_region = region();
      params.with_watch_monetization_types = 'flatrate';
    }
  }
  const r = await get(path, params, { ttl: 3 * HOUR, stale: 2 * DAY });
  return { metas: (r.results || []).map((x) => previewOf(x, type)) };
}

// ---- Sagas -------------------------------------------------------------------------
// TMDB n'a pas de liste des collections : on les deduit des films populaires et les
// mieux notes (belongs_to_collection), puis on les classe par popularite.

let sagasList = null;
let sagasLoading = null;

function loadSagas() {
  if (sagasLoading) return sagasLoading;
  sagasLoading = (async () => {
    const t0 = Date.now();
    const lists = [];
    for (let page = 1; page <= 5; page++) {
      lists.push(get('/movie/popular', { page }), get('/movie/top_rated', { page }));
    }
    for (let page = 1; page <= 3; page++) lists.push(get('/trending/movie/week', { page }));
    const movies = new Map();
    for (const r of await Promise.allSettled(lists)) {
      for (const m of r.value?.results || []) movies.set(m.id, m);
    }
    const found = new Map();
    await Promise.all(
      [...movies.values()].map(async (m) => {
        try {
          const d = await details('movie', m.id);
          const c = d.belongs_to_collection;
          if (c) found.set(c.id, (found.get(c.id) || 0) + (m.popularity || 0));
        } catch {}
      })
    );
    const cols = await Promise.all(
      [...found.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => collection(id).catch(() => null))
    );
    sagasList = cols.filter((c) => c && c.parts.length > 1);
    log(`[tmdb] ${sagasList.length} sagas indexees en ${Date.now() - t0} ms`);
    return sagasList;
  })().finally(() => {
    sagasLoading = null;
  });
  return sagasLoading;
}

async function sagas(skip) {
  const list = sagasList || (await loadSagas());
  return list.slice(skip, skip + 50).map(({ parts, ...c }) => c);
}

// ---- Prechauffage ---------------------------------------------------------------------

let warmTimer = null;

/** Charge les genres et indexe les sagas. force : on refait l'index des sagas. */
async function warm(force = false) {
  clearTimeout(warmTimer);
  if (force) sagasList = null;
  if (!enabled()) return;
  try {
    const [m, t] = await Promise.all([get('/genre/movie/list', {}, { ttl: 7 * DAY }), get('/genre/tv/list', {}, { ttl: 7 * DAY })]);
    genreNames = {
      movie: Object.fromEntries((m.genres || []).map((g) => [g.id, g.name])),
      tv: Object.fromEntries((t.genres || []).map((g) => [g.id, g.name]))
    };
    loadSagas().catch(() => {});
    warmTimer = setTimeout(() => { sagasList = null; warm(); }, DAY);
    warmTimer.unref();
  } catch (e) {
    log(`[tmdb] indisponible : ${e.message}`);
  }
}

// ---- Bandeau Spotlight du client web -------------------------------------------------

/**
 * Films tendance du jour (fiches completes, dans la langue des fiches) pour le bandeau
 * Spotlight : image de fond, logo, resume, annee, note, duree.
 */
async function spotlight(limit = 10) {
  if (!enabled()) return [];
  const r = await get('/trending/movie/day', { page: 1 }, { ttl: 3 * HOUR, stale: 2 * DAY });
  const list = (r.results || []).filter((x) => x.backdrop_path).slice(0, limit);
  const metas = await Promise.all(
    list.map(async (x) => {
      try {
        const d = await withFallbackOverview('movie', x.id, await details('movie', x.id));
        return toMeta('movie', `tmdb:${x.id}`, d, 'movie');
      } catch (e) {
        log(`[spotlight] film ${x.id} : ${e.message}`);
        return null;
      }
    })
  );
  return metas.filter(Boolean);
}

module.exports = { ADDON_URL, enabled, spotlight, availableProviders, providerInfo, platformListMetas, PLATFORM_LISTS, checkKey, resolve, meta, previewMeta, released, collection, catalog, addons, warm };
