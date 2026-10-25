// Routes de l'API Jellyfin. Les apps Jellyfin (Android TV, Swiftfin, Findroid, Streamyfin,
// Infuse, web...) s'y connectent comme a un vrai serveur.
const crypto = require('crypto');
const express = require('express');
const config = require('../config');
const ids = require('../ids');
const catalog = require('../catalog');
const cache = require('../cache');
const { st } = require('../db');
const auth = require('./auth');
const dto = require('./dto');
const library = require('./library');
const playback = require('./playback');
const avatars = require('../avatars');
const tmdb = require('../tmdb');
const { verifyPassword } = require('../security');

const router = express.Router({ caseSensitive: false });

// ---- Utilitaires ------------------------------------------------------------

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

/** Query avec cles en minuscules (les apps ecrivent parentId, ParentId, parentid...). */
function lq(req) {
  const out = {};
  for (const [k, v] of Object.entries(req.query || {})) out[k.toLowerCase()] = Array.isArray(v) ? v.join(',') : v;
  return out;
}

function int(v, def) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : def;
}

function list(v) {
  return String(v || '')
    .split(/[,|]/)
    .map((x) => x.trim())
    .filter(Boolean);
}

function baseUrl(req) {
  const s = config.get().settings;
  if (s.publicUrl) return s.publicUrl;
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}

// Les apps Emby refusent un serveur qui n'annonce pas une version Emby 4.x (4 nombres).
const EMBY_VERSION = '4.9.1.80';
const embyTokens = new Set();

function isEmby(req) {
  return !!req.authInfo?.emby || (req.tok && embyTokens.has(req.tok.token));
}

function publicInfo(req) {
  const s = config.get().settings;
  if (isEmby(req)) {
    return {
      LocalAddress: baseUrl(req),
      LocalAddresses: [baseUrl(req)],
      RemoteAddresses: [],
      ServerName: s.serverName,
      Version: EMBY_VERSION,
      Id: config.get().serverId
    };
  }
  return {
    LocalAddress: baseUrl(req),
    ServerName: s.serverName,
    Version: dto.VERSION,
    ProductName: 'Jellyfin Server',
    OperatingSystem: '',
    Id: config.get().serverId,
    StartupWizardCompleted: true
  };
}

function authResult(req, profile, tok) {
  if (req.authInfo?.emby) embyTokens.add(tok.token);
  return {
    User: dto.userDto(profile, { autoLogin: isEmby(req) }),
    SessionInfo: dto.sessionDto(tok, profile, req.ip),
    AccessToken: tok.token,
    ServerId: config.get().serverId
  };
}

const TYPE_MAP = { movie: 'movie', series: 'series' };

/** IncludeItemTypes Jellyfin -> types Stremio. null = aucun type gere demande. */
function stremioTypes(types) {
  if (!types.length) return ['movie', 'series'];
  const out = types.map((t) => TYPE_MAP[t.toLowerCase()]).filter(Boolean);
  return out.length ? out : null;
}

/**
 * Ajoute les "versions" (4K / 1080p / 720p) aux films et episodes quand l'app demande
 * Fields=MediaSources, ou toujours sur une fiche (`always`) : c'est ce qui affiche le
 * selecteur de version.
 */
function decorate(items, q, profile, always = false) {
  const fields = list(q.fields).map((f) => f.toLowerCase());
  if (always || fields.includes('mediasources')) {
    for (const i of items) if (i && (i.Type === 'Movie' || i.Type === 'Episode')) i.MediaSources = playback.qualitySources(profile, i.Id);
  }
  return items;
}

/**
 * Apps Emby : le lecteur prend les chapitres (marqueurs d'intro / generique) dans la liste
 * de lecture (Fields=Chapters). Dans une liste on n'attend pas TheIntroDB : seuls les
 * marqueurs deja en cache sont ajoutes, les autres sont recherches en arriere-plan.
 */
async function addChapters(req, q, items) {
  if (!isEmby(req) || !list(q.fields).some((f) => f.toLowerCase() === 'chapters')) return;
  await Promise.all(
    items
      .filter((i) => i && (i.Type === 'Movie' || i.Type === 'Episode'))
      .map(async (i) => {
        const ch = await playback.embyChapters(i.Id, 150);
        if (ch.length) i.Chapters = ch;
      })
  );
}

/** Tri Jellyfin (SortBy / SortOrder) -> tri des catalogues TMDB : name, date, rating, popularity. */
function sortOf(q) {
  const by = list(q.sortby)[0]?.toLowerCase();
  if (!by) return undefined;
  const dir = String(q.sortorder || '').toLowerCase().startsWith('desc') ? 'desc' : 'asc';
  if (['sortname', 'name'].includes(by)) return `name.${dir}`;
  if (['premieredate', 'productionyear', 'datecreated', 'dateadded'].includes(by)) return `date.${dir}`;
  if (['communityrating', 'criticrating'].includes(by)) return `rating.${dir}`;
  return 'popularity.desc';
}

/**
 * Tri d'une bibliotheque. Les apps Emby demandent toujours "par nom" par defaut : sauf
 * reglage contraire, on garde alors l'ordre du catalogue (populaires, tendances...), deja
 * prepare en cache. Les autres tris choisis dans l'app (date, note) sont respectes.
 */
function librarySort(req, q) {
  const sort = sortOf(q);
  if (isEmby(req) && sort?.startsWith('name.') && config.get().settings.embySort !== 'name') return undefined;
  return sort;
}

function filterPlayed(items, q) {
  if (q.isplayed === 'true') return items.filter((i) => i.UserData?.Played);
  if (q.isplayed === 'false') return items.filter((i) => !i.UserData?.Played);
  return items;
}

// ---- Routes publiques -------------------------------------------------------

router.get('/System/Info/Public', (req, res) => res.json(publicInfo(req)));
// Apps Emby : un texte contenant "jellyf" leur fait croire a un serveur incompatible.
router.all('/System/Ping', (req, res) => res.type('text/plain').send(isEmby(req) ? 'Emby Server' : 'Jellyfin Server'));
// Liste des profils a l'ecran "Qui regarde ?" : seulement ceux deja connectes depuis CET
// appareil (un appareil inconnu ne voit personne). L'app Emby ne reprend la session
// enregistree que si le profil apparait ici.
router.get('/Users/Public', (req, res) => {
  const deviceId = req.authInfo.deviceid;
  // Profils marques "visibles a la connexion" + ceux deja connectes depuis cet appareil.
  const ids = new Set(config.get().profiles.filter((p) => p.showOnLogin).map((p) => p.id));
  if (deviceId) for (const t of st.tokenList.all()) if (t.device_id === deviceId) ids.add(t.profile);
  const users = [...ids]
    .map((id) => config.getProfile(id))
    .filter((p) => p && !p.disabled)
    .map((p) => dto.userDto(p, { autoLogin: isEmby(req) }));
  res.json(users);
});

// Avatar d'un profil (public, comme sur Jellyfin : l'ecran de connexion l'affiche).
router.get(['/Users/:id/Images/:type', '/Users/:id/Images/:type/:index'], (req, res) => {
  const img = avatars.get(config.getProfile(req.params.id));
  if (!img) return res.status(404).end();
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.type(img.type).sendFile(img.file);
});
// CSS du client web : celui du profil connecte (vide avant la connexion).
router.get('/Branding/Configuration', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ LoginDisclaimer: '', CustomCss: req.profile?.customCss || '', SplashscreenEnabled: false });
});
router.get(['/Branding/Css', '/Branding/Css.css'], (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.type('text/css').send(req.profile?.customCss || '');
});

/** Champ du corps sans tenir compte de la casse (Pw, pw, PW...). */
function field(body, ...names) {
  const lower = Object.fromEntries(Object.entries(body || {}).map(([k, v]) => [k.toLowerCase(), v]));
  for (const n of names) if (lower[n] !== undefined && lower[n] !== '') return String(lower[n]);
  return undefined;
}

/** Connexion : nom d'utilisateur + mot de passe du profil (crees par l'admin), et rien d'autre. */
function authenticate(b) {
  const p = config.findProfileByName(field(b, 'username', 'name'));
  const pw = field(b, 'pw', 'password');
  if (!p || p.disabled || !p.passwordHash || !pw) return null;
  return verifyPassword(pw, p.passwordHash) ? p : null;
}

router.post('/Users/AuthenticateByName', (req, res) => {
  const b = req.body || {};
  const pw = field(b, 'pw', 'password');
  const profile = authenticate(b);
  if (!profile) {
    // Jamais les valeurs : seulement le format et le nom des champs recus, pour diagnostiquer.
    log(`[auth] echec de connexion (${req.authInfo.client || '?'} / ${req.authInfo.device || '?'}) ` +
      `type=${req.headers['content-type'] || '-'} champs=[${Object.keys(b).join(', ')}] mdp=${pw ? pw.length + ' car.' : 'vide'}`);
    return res.status(401).send('Invalid username or password entered.');
  }
  const tok = auth.createToken(profile, req.authInfo);
  log(`[auth] ${profile.name} connecte depuis ${tok.client || '?'} (${tok.device || '?'})`);
  res.json(authResult(req, profile, tok));
});

router.get('/QuickConnect/Enabled', (req, res) => res.json(true));
router.all('/QuickConnect/Initiate', (req, res) => res.json(auth.qcInitiate(req.authInfo)));
router.get('/QuickConnect/Connect', (req, res) => {
  const s = auth.qcState(lq(req).secret);
  if (!s) return res.status(404).send('Unknown secret');
  res.json(s);
});
router.post('/Users/AuthenticateWithQuickConnect', (req, res) => {
  const r = auth.qcConsume(req.body?.Secret ?? req.body?.secret);
  if (!r?.profile) return res.status(401).send('Quick connect not authorized');
  const tok = auth.createToken(r.profile, r.info);
  log(`[auth] ${r.profile.name} connecte par Quick Connect (${tok.client || '?'})`);
  res.json(authResult(req, r.profile, tok));
});

// Images : publiques chez Jellyfin (les apps ne passent pas toujours le jeton).
router.get(['/Items/:id/Images/:type', '/Items/:id/Images/:type/:index', '/Items/:id/Images/:type/:index/*rest'], async (req, res) => {
  const url = await library.imageUrl(req.params.id, req.params.type, int(req.params.index, 0));
  if (!url) return res.status(404).end();
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.redirect(302, url);
});

// Flux video : la source est designee par un id non devinable, le jeton est optionnel.
const streamPaths = ['/Videos/:id/stream', '/Videos/:id/stream.:ext', '/Videos/:id/:file.:ext', '/Items/:id/Download'];
router.get(streamPaths, stream);
router.head(streamPaths, stream);
async function stream(req, res) {
  const q = lq(req);
  const src = await playback.resolveSource(req, req.params.id, q.mediasourceid);
  if (!src) return res.status(req.profile ? 404 : 401).send('Source introuvable');
  try {
    await playback.pipe(req, res, src);
  } catch (e) {
    log(`[play] erreur: ${e.message}`);
    if (!res.headersSent) res.status(502).send('Source injoignable');
  }
}

router.get(['/Videos/:id/:msid/Subtitles/:index/:start/Stream.:ext', '/Videos/:id/:msid/Subtitles/:index/Stream.:ext'], playback.subtitle);

// ---- A partir d'ici : authentification obligatoire ----------------------------

router.use(auth.required);

// Bandeau Spotlight du theme Abyss (client web) : films tendance TMDB, meme hors bibliotheques.
// Chaque film devient un element Stremfin : sa fiche s'ouvre et se lit via les addons.
router.get('/Stremfin/Spotlight', async (req, res) => {
  let metas = [];
  try {
    metas = await tmdb.spotlight();
  } catch (e) {
    console.log(new Date().toISOString(), `[spotlight] ${e.message}`);
  }
  const entries = library.registerMetas(metas);
  res.json({
    Items: metas.map((m, i) => ({
      Id: entries[i].uuid,
      Type: 'Movie',
      Name: m.name,
      Overview: m.description || '',
      ProductionYear: Number(m.releaseInfo) || undefined,
      CommunityRating: Number(m.imdbRating) || undefined,
      OfficialRating: m.certification || undefined,
      RunTimeTicks: parseInt(m.runtime, 10) * 6e8 || undefined
    }))
  });
});

router.get('/System/Info', (req, res) =>
  res.json({
    ...publicInfo(req),
    OperatingSystemDisplayName: '',
    PackageName: 'stremfin',
    HasPendingRestart: false,
    IsShuttingDown: false,
    SupportsLibraryMonitor: false,
    WebSocketPortNumber: Number(process.env.PORT) || 8096,
    CompletedInstallations: [],
    CanSelfRestart: false,
    CanLaunchWebBrowser: false,
    ProgramDataPath: '',
    WebPath: '',
    ItemsByNamePath: '',
    CachePath: '',
    LogPath: '',
    InternalMetadataPath: '',
    TranscodingTempPath: '',
    CastReceiverApplications: [],
    HasUpdateAvailable: false,
    EncoderLocation: 'System',
    SystemArchitecture: 'X64'
  })
);
router.get('/System/Endpoint', (req, res) => res.json({ IsLocal: false, IsInNetwork: false }));
router.get('/System/Configuration', (req, res) =>
  res.json({ EnableMetrics: false, ServerName: config.get().settings.serverName, UICulture: 'fr-FR', IsStartupWizardCompleted: true, QuickConnectAvailable: true })
);

router.post('/QuickConnect/Authorize', (req, res) => res.json(auth.qcAuthorize(lq(req).code, req.profile.id)));

// ---- Utilisateur ------------------------------------------------------------

router.get('/Users/Me', (req, res) => res.json(dto.userDto(req.profile, { autoLogin: isEmby(req) })));
router.get('/Users', (req, res) => res.json([dto.userDto(req.profile)]));
router.get('/Users/:u', (req, res) => {
  if (ids.norm(req.params.u) !== req.profile.id) return res.status(404).send('User not found');
  res.json(dto.userDto(req.profile, { autoLogin: isEmby(req) }));
});
router.get(['/Users/:u/Views', '/UserViews'], (req, res) => {
  const views = catalog.views(req.profile).map((v) => library.lightDto(req.profile, ids.get(v.uuid)));
  res.json(dto.queryResult(views));
});
router.get('/Library/MediaFolders', (req, res) => {
  const views = catalog.views(req.profile).map((v) => library.lightDto(req.profile, ids.get(v.uuid)));
  res.json(dto.queryResult(views));
});
router.get(['/Users/:u/GroupingOptions', '/UserViews/GroupingOptions', '/Library/VirtualFolders'], (req, res) => res.json([]));

// ---- Listes -----------------------------------------------------------------

router.get(['/Users/:u/Items/Latest', '/Items/Latest'], async (req, res) => {
  const q = lq(req);
  const limit = Math.min(int(q.limit, 16), 100);
  if (!q.parentid) return res.json([]);
  const entry = ids.get(q.parentid);
  if (!entry || entry.kind !== 'view') return res.json([]);
  const view = library.viewByUuid(req.profile, entry.uuid);
  if (!view) return res.json([]);
  const sort = view.sortable && /^tmdb-cat-/.test(view.catId) ? 'recent' : undefined;
  const { items } = await library.viewItems(req.profile, view, { start: 0, limit, sort });
  res.json(decorate(filterPlayed(items, q), q, req.profile));
});

router.get(['/Users/:u/Items/Resume', '/UserItems/Resume'], (req, res) => {
  const q = lq(req);
  const types = list(q.includeitemtypes);
  const items = library.resume(req.profile, int(q.limit, 20), types.length ? types : null);
  res.json(dto.queryResult(decorate(items, q, req.profile)));
});

router.get('/Items/Filters', (req, res) => {
  const v = library.viewByUuid(req.profile, lq(req).parentid);
  res.json({ Genres: v?.genres || [], Tags: [], OfficialRatings: [], Years: [] });
});
router.get('/Items/Filters2', (req, res) => {
  const v = library.viewByUuid(req.profile, lq(req).parentid);
  res.json({ Genres: (v?.genres || []).map((g) => ({ Name: g, Id: ids.uuidOf(`genre|${g}`) })), Tags: [] });
});
router.get('/Items/Counts', (req, res) =>
  res.json({ MovieCount: 0, SeriesCount: 0, EpisodeCount: 0, ArtistCount: 0, ProgramCount: 0, TrailerCount: 0, SongCount: 0, AlbumCount: 0, MusicVideoCount: 0, BoxSetCount: 0, BookCount: 0, ItemCount: 0 })
);

router.get('/Genres', (req, res) => {
  const q = lq(req);
  const v = library.viewByUuid(req.profile, q.parentid);
  const items = (v?.genres || []).map((g) => dto.genreItem(g, v.uuid));
  const start = int(q.startindex, 0);
  const limit = int(q.limit, 0);
  res.json(dto.queryResult(limit ? items.slice(start, start + limit) : items.slice(start), items.length, start));
});

router.get(['/Users/:u/Items', '/Items'], async (req, res) => {
  const p = req.profile;
  const q = lq(req);
  const start = int(q.startindex, 0);
  const limit = int(q.limit, 0);
  const types = list(q.includeitemtypes);
  const filters = list(q.filters).map((f) => f.toLowerCase());
  const send = async (items, total) => {
    await addChapters(req, q, items);
    res.json(dto.queryResult(decorate(items, q, req.profile), total, start));
  };
  const typeOk = (i) => !types.length || types.some((t) => t.toLowerCase() === i.Type.toLowerCase());

  if (q.ids) {
    const items = list(q.ids).map((id) => library.lightDto(p, ids.get(id))).filter(Boolean);
    return send(items, items.length);
  }

  if (q.personids || q.studioids || q.artistids) return send([], 0);

  if (q.searchterm) {
    const stypes = stremioTypes(types);
    if (!stypes) return send([], 0);
    const metas = await library.keepReleased(p, await catalog.search(p, String(q.searchterm), stypes));
    const all = library.metasToDtos(p, metas);
    const { items, total } = library.page(all, { start, limit: limit || 50 });
    return send(items, total);
  }

  if (filters.includes('isfavorite') || q.isfavorite === 'true') {
    const all = library.favorites(p).filter(typeOk);
    const { items, total } = library.page(all, { start, limit });
    return send(items, total);
  }

  if (filters.includes('isresumable')) {
    const all = library.resume(p, 100).filter(typeOk);
    const { items, total } = library.page(all, { start, limit });
    return send(items, total);
  }

  let parentId = q.parentid;
  // Pas de parent mais un type demande ("tous les films") : premiere bibliotheque de ce type.
  if (!parentId && types.length) {
    const stypes = stremioTypes(types);
    const v = stypes && catalog.views(p).find((x) => stypes.includes(x.type));
    if (!v) return send([], 0);
    parentId = v.uuid;
  }
  if (!parentId) return send([], 0);

  let genre;
  if (q.genres) genre = list(q.genres)[0];
  else if (q.genreids) genre = ids.get(list(q.genreids)[0])?.data?.name;

  const wantEpisodes = types.some((t) => t.toLowerCase() === 'episode') && q.recursive === 'true';
  const { items, total } = await library.children(p, parentId, { start, limit: limit || 100, genre, episodes: wantEpisodes, sort: librarySort(req, q) });
  const parent = ids.get(parentId);
  // Collection (dossiers) et dossier de collection (films et series melanges) : pas de filtre de type.
  const loose = ['colfolder', 'colcat'].includes(parent?.kind) || (parent?.kind === 'view' && parent.data.type === 'nuviocol');
  const shown = filterPlayed(loose ? items : items.filter(typeOk), q);
  send(shown, shown.length === items.length ? total : shown.length + start);
});

// ---- Series -----------------------------------------------------------------

router.get('/Shows/NextUp', async (req, res) => {
  const q = lq(req);
  const items = await library.nextUp(req.profile, { limit: int(q.limit, 20), seriesId: q.seriesid });
  res.json(dto.queryResult(decorate(items, q, req.profile)));
});

router.get('/Shows/:id/Seasons', async (req, res) => {
  const items = await library.seasonsOf(req.profile, req.params.id);
  res.json(dto.queryResult(items));
});

router.get('/Shows/:id/Episodes', async (req, res) => {
  const q = lq(req);
  let items = await library.episodesOf(req.profile, req.params.id, { seasonId: q.seasonid, season: q.season });
  if (q.startitemid) {
    const i = items.findIndex((x) => x.Id === ids.norm(q.startitemid));
    if (i > 0) items = items.slice(i);
  }
  const start = int(q.startindex, 0);
  const { items: pageItems, total } = library.page(items, { start, limit: int(q.limit, 0) });
  await addChapters(req, q, pageItems);
  res.json(dto.queryResult(decorate(pageItems, q, req.profile), total, start));
});

router.get(['/Items/:id/Similar', '/Movies/:id/Similar', '/Shows/:id/Similar'], async (req, res) => {
  const items = await library.similar(req.profile, req.params.id, int(lq(req).limit, 12));
  res.json(dto.queryResult(items));
});

// ---- Recherche --------------------------------------------------------------

router.get('/Search/Hints', async (req, res) => {
  const q = lq(req);
  const stypes = stremioTypes(list(q.includeitemtypes));
  if (!q.searchterm || !stypes) return res.json({ SearchHints: [], TotalRecordCount: 0 });
  const metas = await library.keepReleased(req.profile, await catalog.search(req.profile, String(q.searchterm), stypes));
  const items = library.metasToDtos(req.profile, metas).slice(0, int(q.limit, 30));
  res.json({
    SearchHints: items.map((i) => ({
      ItemId: i.Id,
      Id: i.Id,
      Name: i.Name,
      Type: i.Type,
      IsFolder: i.IsFolder,
      MediaType: i.MediaType,
      ProductionYear: i.ProductionYear,
      RunTimeTicks: i.RunTimeTicks,
      PrimaryImageTag: i.ImageTags.Primary,
      ThumbImageTag: i.ImageTags.Thumb,
      ThumbImageItemId: i.ImageTags.Thumb ? i.Id : undefined,
      BackdropImageTag: i.BackdropImageTags[0],
      BackdropImageItemId: i.BackdropImageTags[0] ? i.Id : undefined,
      Artists: []
    })),
    TotalRecordCount: items.length
  });
});

// ---- Element ----------------------------------------------------------------

router.get(['/Users/:u/Items/:id/Intros', '/Items/:id/Intros'], (req, res) => res.json(dto.queryResult([])));
router.get(['/Users/:u/Items/:id/SpecialFeatures', '/Items/:id/SpecialFeatures', '/Users/:u/Items/:id/LocalTrailers', '/Items/:id/LocalTrailers', '/Items/:id/Ancestors'], (req, res) => res.json([]));
router.get('/Items/:id/ThemeMedia', (req, res) => {
  const empty = { Items: [], TotalRecordCount: 0, StartIndex: 0, OwnerId: req.params.id };
  res.json({ ThemeVideosResult: empty, ThemeSongsResult: empty, SoundtrackSongsResult: empty });
});
router.get('/MediaSegments/:id', async (req, res) => {
  const types = list(lq(req).includesegmenttypes);
  res.json(dto.queryResult(await playback.mediaSegments(req.params.id, types.length ? types : null)));
});

router.get(['/Users/:u/Items/:id', '/Items/:id', '/UserItems/:id'], async (req, res) => {
  const item = await library.itemDto(req.profile, req.params.id);
  if (!item) return res.status(404).send('Item not found');
  const out = decorate([item], lq(req), req.profile, true)[0];
  // Fiche d'un film ou episode : versions selon le profil (3 qualites ou releases).
  if (out.Type === 'Movie' || out.Type === 'Episode') out.MediaSources = await playback.versionSources(req.profile, out.Id);
  // Apps Emby : "Passer l'intro / le generique" via les marqueurs de chapitres.
  if (isEmby(req) && (out.Type === 'Movie' || out.Type === 'Episode')) out.Chapters = await playback.embyChapters(out.Id);
  res.json(out);
});

// ---- Lecture ----------------------------------------------------------------

router.all('/Items/:id/PlaybackInfo', async (req, res) => {
  const q = lq(req);
  const msid = req.body?.MediaSourceId || q.mediasourceid;
  res.json(await playback.playbackInfo(req.profile, req.tok.token, req.params.id, msid));
});

router.post('/Sessions/Playing', (req, res) => {
  playback.report(req.profile, req.body, 'start');
  res.status(204).end();
});
router.post('/Sessions/Playing/Progress', (req, res) => {
  playback.report(req.profile, req.body, 'progress');
  res.status(204).end();
});
router.post('/Sessions/Playing/Stopped', (req, res) => {
  playback.report(req.profile, req.body, 'stopped');
  res.status(204).end();
});
router.post('/Sessions/Playing/Ping', (req, res) => res.status(204).end());

// Anciennes routes de progression (encore utilisees par certaines apps).
router.post(['/Users/:u/PlayingItems/:id', '/PlayingItems/:id'], (req, res) => {
  playback.report(req.profile, { ItemId: req.params.id, PositionTicks: lq(req).positionticks }, 'start');
  res.status(204).end();
});
router.post(['/Users/:u/PlayingItems/:id/Progress', '/PlayingItems/:id/Progress'], (req, res) => {
  playback.report(req.profile, { ItemId: req.params.id, PositionTicks: lq(req).positionticks }, 'progress');
  res.status(204).end();
});
router.delete(['/Users/:u/PlayingItems/:id', '/PlayingItems/:id'], (req, res) => {
  playback.report(req.profile, { ItemId: req.params.id, PositionTicks: lq(req).positionticks }, 'stopped');
  res.status(204).end();
});

// ---- Vu / favoris / j'aime ----------------------------------------------------

router.post(['/Users/:u/PlayedItems/:id', '/UserPlayedItems/:id'], async (req, res) => {
  const d = await playback.setPlayed(req.profile, req.params.id, true);
  d ? res.json(d) : res.status(404).end();
});
router.delete(['/Users/:u/PlayedItems/:id', '/UserPlayedItems/:id'], async (req, res) => {
  const d = await playback.setPlayed(req.profile, req.params.id, false);
  d ? res.json(d) : res.status(404).end();
});
router.post(['/Users/:u/FavoriteItems/:id', '/UserFavoriteItems/:id'], (req, res) => {
  const d = playback.setFlag(req.profile, req.params.id, { favorite: 1 });
  d ? res.json(d) : res.status(404).end();
});
router.delete(['/Users/:u/FavoriteItems/:id', '/UserFavoriteItems/:id'], (req, res) => {
  const d = playback.setFlag(req.profile, req.params.id, { favorite: 0 });
  d ? res.json(d) : res.status(404).end();
});
router.post(['/Users/:u/Items/:id/Rating', '/UserItems/:id/Rating'], (req, res) => {
  const d = playback.setFlag(req.profile, req.params.id, { likes: lq(req).likes === 'false' ? 0 : 1 });
  d ? res.json(d) : res.status(404).end();
});
router.delete(['/Users/:u/Items/:id/Rating', '/UserItems/:id/Rating'], (req, res) => {
  const d = playback.setFlag(req.profile, req.params.id, { likes: null });
  d ? res.json(d) : res.status(404).end();
});
router.get(['/Users/:u/Items/:id/UserData', '/UserItems/:id/UserData'], (req, res) => {
  const e = ids.get(req.params.id);
  if (!e) return res.status(404).end();
  res.json(dto.userData(e.uuid, library.udRow(req.profile, e.uuid)));
});
router.post(['/Users/:u/Items/:id/UserData', '/UserItems/:id/UserData'], (req, res) => {
  const d = playback.updateUserData(req.profile, req.params.id, req.body || {});
  d ? res.json(d) : res.status(404).end();
});

// ---- Sessions / appareil ---------------------------------------------------------

router.post(['/Sessions/Capabilities', '/Sessions/Capabilities/Full'], (req, res) => res.status(204).end());
router.get('/Sessions', (req, res) => res.json([dto.sessionDto(req.tok, req.profile, req.ip)]));
router.post('/Sessions/Logout', (req, res) => {
  st.tokenDel.run(req.tok.token);
  res.status(204).end();
});

router.get('/DisplayPreferences/:id', (req, res) => {
  const q = lq(req);
  const key = `dp|${req.profile.id}|${req.params.id}|${q.client || ''}`;
  const saved = cache.peek(key)?.v;
  const prefs = saved || {
      Id: req.params.id,
      SortBy: 'SortName',
      RememberIndexing: false,
      PrimaryImageHeight: 250,
      PrimaryImageWidth: 250,
      CustomPrefs: {},
      ScrollDirection: 'Horizontal',
      ShowBackdrop: true,
      RememberSorting: false,
      SortOrder: 'Ascending',
      ShowSidebar: false,
      Client: q.client || 'emby'
    };
  const sections = req.profile.homeSections;
  if (req.params.id.toLowerCase() === 'usersettings' && Array.isArray(sections)) {
    prefs.CustomPrefs = { ...(prefs.CustomPrefs || {}) };
    for (let i = 0; i < 10; i++) prefs.CustomPrefs[`homesection${i}`] = sections[i] || 'none';
  }
  res.json(prefs);
});
router.post('/DisplayPreferences/:id', (req, res) => {
  const q = lq(req);
  const body = req.body || {};
  cache.put(`dp|${req.profile.id}|${req.params.id}|${q.client || ''}`, body, 10 * 365 * 864e5);
  // L'utilisateur a reorganise son accueil dans l'app : l'admin affiche la meme chose.
  const custom = body.CustomPrefs || {};
  if (req.params.id.toLowerCase() === 'usersettings' && Object.keys(custom).some((k) => /^homesection\d$/.test(k))) {
    const sections = [];
    for (let i = 0; i < 10; i++) sections.push(custom[`homesection${i}`] || 'none');
    while (sections.length && sections[sections.length - 1] === 'none') sections.pop();
    try { config.updateProfile(req.profile.id, { homeSections: sections }); } catch {}
  }
  res.status(204).end();
});

router.get('/Localization/Options', (req, res) =>
  res.json([
    { Name: 'Français', Value: 'fr' },
    { Name: 'English', Value: 'en-US' }
  ])
);
router.get(['/Localization/Cultures', '/Localization/Countries', '/Localization/ParentalRatings', '/Plugins', '/Packages', '/ScheduledTasks', '/SyncPlay/List'], (req, res) => res.json([]));

// App Emby Android TV : la reponse WakeOnLanInfo referme l'ecran "Qui regarde ?". Si elle
// arrive avant la fin de la verification de licence de l'app (en ligne, ~0,5 s), l'accueil
// s'ouvre sans fenetre visible et Android 14 le bloque. On repond donc un peu plus tard,
// comme un vrai serveur Emby dont la licence est en cache (accueil ouvert avant la reponse).
router.get('/System/WakeOnLanInfo', async (req, res) => {
  if (isEmby(req)) await new Promise((r) => setTimeout(r, 2500));
  res.json([]);
});

router.get('/Playback/BitrateTest', (req, res) => {
  const size = Math.min(int(lq(req).size, 500000), 10_000_000);
  res.type('application/octet-stream').send(crypto.randomBytes(size));
});

// ---- Le reste : reponse vide plutot qu'une erreur (on note la route pour l'ajouter) ----

const unknown = new Set();
router.use((req, res) => {
  const key = `${req.method} ${req.path.replace(/[0-9a-f]{32}/gi, ':id')}`;
  if (!unknown.has(key)) {
    unknown.add(key);
    log(`[api] route non geree : ${key}`);
  }
  if (req.method === 'GET') return res.json(dto.queryResult([]));
  res.status(204).end();
});

module.exports = router;
