const ids = require('./ids');
const stremio = require('./stremio');
const config = require('./config');
const tmdb = require('./tmdb');

const MAX_ITEMS = 2000; // plafond par catalogue (au-dela, les apps n'y vont jamais)
const PAGER_TTL = 3600e3;

const TYPE_LABEL = {
  fr: { movie: 'Films', series: 'Séries' },
  en: { movie: 'Movies', series: 'Shows' },
  es: { movie: 'Películas', series: 'Series' },
  de: { movie: 'Filme', series: 'Serien' },
  it: { movie: 'Film', series: 'Serie' }
};

function label(type) {
  const l = TYPE_LABEL[config.get().settings.language] || TYPE_LABEL.en;
  return l[type] || type;
}

/** Normalise les "extra" d'un catalogue (format actuel `extra` ou ancien `extraSupported`). */
function extrasOf(c) {
  if (Array.isArray(c.extra)) return c.extra.map((e) => (typeof e === 'string' ? { name: e } : e));
  const sup = c.extraSupported || [];
  const req = c.extraRequired || [];
  return sup.map((name) => ({ name, isRequired: req.includes(name), options: c.genres }));
}

function catalogKey(addonUrl, type, id) {
  return `${stremio.baseOf(addonUrl)}|${type}|${id}`;
}

/** Actif selon le reglage du profil, sinon selon le defaut du catalogue. */
function isEnabled(profile, c) {
  const pref = profile.catalogs?.[c.key]?.enabled;
  return pref !== undefined ? pref : c.defaultEnabled;
}

/** Tous les catalogues films/series/sagas/collections (TMDB integre, collections du profil, addons), pour l'admin. */
function allCatalogs(profile) {
  const out = [];
  // Un addon peut etre garde pour ses sources / fiches sans proposer ses catalogues.
  const collections = require('./collections').addon(profile);
  for (const a of [...tmdb.addons(), ...collections, ...stremio.enabledAddons(profile).filter((x) => !x.catalogsHidden)]) {
    for (const c of a.manifest.catalogs || []) {
      if (!['movie', 'series', 'collection', 'nuviocol'].includes(c.type)) continue;
      const extras = extrasOf(c);
      const genre = extras.find((e) => e.name === 'genre');
      const options = Array.isArray(genre?.options) ? genre.options : [];
      // Genre obligatoire (ex: "New" de Cinemeta = annee) : on prend la premiere valeur par defaut.
      const defaultGenre = genre?.isRequired && options.length ? options[0] : undefined;
      // Catalogues "recherche seule" ou exigeant un autre parametre : pas affichables comme bibliotheque.
      const browsable = !extras.some((e) => e.isRequired && e.name !== 'skip' && !(e.name === 'genre' && defaultGenre));
      out.push({
        key: catalogKey(a.url, c.type, c.id),
        addonUrl: a.url,
        addonName: stremio.nameOf(a),
        type: c.type,
        catId: c.id,
        defaultName: c.plainName || c.type === 'collection' ? c.name || c.id : `${c.name || c.id} · ${label(c.type)}`,
        // Collection epinglee : en tete tant que le profil ne l'a pas placee lui-meme.
        pinned: !!c.pinned,
        image: c.image || null,
        // Catalogues TMDB integres bases sur /discover : l'app peut les trier (nom, date, note).
        sortable: a.url === tmdb.ADDON_URL && /^tmdb-(cat-|provider-|popular|toprated)/.test(c.id),
        defaultEnabled: c.defaultEnabled !== false,
        browsable,
        searchable: extras.some((e) => e.name === 'search'),
        hasSkip: extras.some((e) => e.name === 'skip'),
        genres: options,
        defaultGenre
      });
    }
  }
  return out;
}

/** Position d'un catalogue dans l'ordre du profil (non place : a la fin, ou en tete si epingle). */
function positionOf(profile) {
  const order = profile.catalogOrder || [];
  return (c) => {
    const i = order.indexOf(c.key);
    return i !== -1 ? i : c.pinned ? -1 : Infinity;
  };
}

/** Bibliotheques Jellyfin du profil = ses catalogues actifs, dans l'ordre choisi. */
function views(profile) {
  const list = allCatalogs(profile)
    .filter((c) => c.browsable && isEnabled(profile, c))
    .map((c) => {
      const name = profile.catalogs?.[c.key]?.name || c.defaultName;
      const uuid = ids.register(`view|${profile.id}|${c.key}`, 'view', {
        profileId: profile.id,
        key: c.key,
        addonUrl: c.addonUrl,
        type: c.type,
        catId: c.catId,
        name,
        hasSkip: c.hasSkip,
        genres: c.genres,
        defaultGenre: c.defaultGenre,
        sortable: c.sortable,
        image: c.image
      });
      return { uuid, ...c, name };
    });
  const pos = positionOf(profile);
  return list
    .map((v, i) => ({ v, i }))
    .sort((a, b) => pos(a.v) - pos(b.v) || a.i - b.i)
    .map((x) => x.v);
}

// ---- Pagination -------------------------------------------------------------
// Stremio pagine par "skip" avec des pages de taille variable ; Jellyfin demande
// StartIndex/Limit. On accumule les pages en memoire et on decoupe.
// La 1re page donne la taille des pages ; les suivantes se chargent ensuite par lots en
// parallele (l'app Emby demande 300 titres d'un coup : 15 pages TMDB).

const pagers = new Map();
const PARALLEL_PAGES = 6;

// `filter` (optionnel) : { key, fn: async (meta) => bool } applique a chaque page chargee,
// pour que la pagination reste juste quand on masque des titres (ex: pas encore sortis).
function pagerFor(view, genre, filter, sort) {
  const key = `${view.key}|${genre || ''}|${filter?.key || ''}|${sort || ''}`;
  let p = pagers.get(key);
  if (!p || Date.now() - p.at > PAGER_TTL) {
    p = { metas: [], seen: new Set(), raw: 0, lastSize: 0, pageSize: 0, done: false, at: Date.now(), loading: null };
    pagers.set(key, p);
  }
  return p;
}

/** Charge `count` pages a partir de la position courante (en parallele), dans l'ordre. */
function loadPages(p, view, count, genre, filter, sort) {
  if (p.loading) return p.loading;
  p.loading = (async () => {
    const base = p.raw;
    const step = p.pageSize;
    const fetchPage = (skip) => {
      const extra = {};
      if (genre) extra.genre = genre;
      if (sort) extra.sort = sort;
      if (skip) extra.skip = skip;
      return stremio.catalog(view.addonUrl, view.type, view.catId, extra).then(
        (r) => ({ metas: r.metas, partial: r.partial }),
        (error) => ({ error })
      );
    };
    const pages = await Promise.all(Array.from({ length: count }, (_, i) => fetchPage(base + i * step)));

    const fresh = [];
    // Page incomplete (une source d'un dossier de collection encore vide) : liste a refaire bientot.
    if (pages.some((page) => page.partial)) p.at = Math.min(p.at, Date.now() - PAGER_TTL + 2 * 60e3);
    for (const [i, page] of pages.entries()) {
      if (page.error) {
        console.log(new Date().toISOString(), `[catalog] KO ${view.key}: ${page.error.message}`);
        p.done = true;
        // Rien de charge du tout : on retentera dans une minute.
        if (!p.raw && i === 0) p.at = Date.now() - PAGER_TTL + 60e3;
        break;
      }
      const metas = page.metas;
      // Position dans le catalogue de l'addon (une page incomplete n'est pas forcement la fin).
      p.raw = base + i * step + metas.length;
      p.lastSize = metas.length || p.lastSize;
      if (!p.pageSize) p.pageSize = metas.length;
      let added = 0;
      for (const m of metas) {
        if (!m?.id || p.seen.has(m.id)) continue;
        p.seen.add(m.id);
        fresh.push({ ...m, type: m.type || view.type });
        added++;
      }
      // Page vide, page deja vue (addon qui ignore skip) ou catalogue sans pagination : fin.
      // Les pages suivantes du lot sont ignorees.
      if (!added || !view.hasSkip || p.raw >= MAX_ITEMS) {
        p.done = true;
        break;
      }
    }
    // Filtre (ex: titres sortis) applique a tout le lot en une fois.
    const keep = filter ? await Promise.all(fresh.map((m) => filter.fn(m).catch(() => true))) : null;
    p.metas.push(...fresh.filter((m, i) => !keep || keep[i]));
    if (p.metas.length >= MAX_ITEMS) p.done = true;
    // Liste vide : on retentera dans 2 minutes (addon qui prepare encore sa liste).
    if (p.done && !p.metas.length) p.at = Math.min(p.at, Date.now() - PAGER_TTL + 2 * 60e3);
  })().finally(() => {
    p.loading = null;
  });
  return p.loading;
}

/** Charge les pages jusqu'a avoir `want` titres (ou la fin du catalogue). */
async function fill(p, view, want, genre, filter, sort) {
  while (!p.done && p.metas.length < want) {
    if (p.loading) {
      await p.loading;
      continue;
    }
    // Taille des pages inconnue (1re page) : une seule page ; ensuite, un lot.
    const missing = want - p.metas.length;
    const count = p.pageSize && view.hasSkip ? Math.min(PARALLEL_PAGES, Math.max(1, Math.ceil(missing / p.pageSize))) : 1;
    await loadPages(p, view, count, genre, filter, sort);
  }
}

/** Renvoie { metas, total } pour la tranche [start, start+limit[ d'un catalogue. */
async function slice(view, start = 0, limit = 50, genre, filter, sort) {
  genre = genre || view.defaultGenre;
  // Le tri n'a de sens que pour les catalogues TMDB integres bases sur /discover.
  if (!view.sortable) sort = undefined;
  const p = pagerFor(view, genre, filter, sort);
  await fill(p, view, start + limit, genre, filter, sort);
  // Anticipation : la tranche suivante se prepare pendant que l'app affiche celle-ci.
  if (!p.done) fill(p, view, start + limit + Math.min(limit, 100), genre, filter, sort).catch(() => {});
  const metas = p.metas.slice(start, start + limit);
  // Tant qu'on n'a pas tout charge, on annonce une page de plus pour que l'app continue a defiler.
  const total = p.done ? p.metas.length : p.metas.length + (p.lastSize || limit);
  return { metas, total };
}

/** Recherche dans tous les catalogues "search" du profil, pour les types demandes. */
async function search(profile, query, types = ['movie', 'series']) {
  // Un catalogue desactive dans l'admin ne sert pas non plus a la recherche
  // (evite les doublons Cinemeta en anglais / TMDB en francais).
  const cats = allCatalogs(profile).filter(
    (c) => c.searchable && types.includes(c.type) && isEnabled(profile, c)
  );
  const results = await Promise.all(
    cats.map(async (c) => {
      try {
        return (await stremio.catalog(c.addonUrl, c.type, c.catId, { search: query })).metas.map((m) => ({
          ...m,
          type: m.type || c.type
        }));
      } catch {
        return [];
      }
    })
  );
  // Fusion en alternant les catalogues pour ne pas noyer les series sous les films.
  const out = [];
  const seen = new Set();
  const max = Math.max(0, ...results.map((r) => r.length));
  for (let i = 0; i < max; i++) {
    for (const r of results) {
      const m = r[i];
      if (!m?.id) continue;
      const k = `${m.type}|${m.id}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(m);
    }
  }
  return out;
}

module.exports = { allCatalogs, isEnabled, views, positionOf, slice, search, catalogKey, label };
