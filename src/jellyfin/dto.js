// Construction des objets au format de l'API Jellyfin (BaseItemDto, UserDto...).
// Les SDK officiels (Kotlin, Swift) refusent un objet si un champ obligatoire manque :
// on renseigne donc toujours les champs non-nullables du schema OpenAPI.
const crypto = require('crypto');
const clientContext = require('./clientContext');
const config = require('../config');
const ids = require('../ids');
const avatars = require('../avatars');

const TICKS = 10_000_000;
const VERSION = '10.11.11';

const L = {
  fr: { season: (n) => `Saison ${n}`, specials: 'Spéciaux', episode: (n) => `Épisode ${n}` },
  en: { season: (n) => `Season ${n}`, specials: 'Specials', episode: (n) => `Episode ${n}` },
  es: { season: (n) => `Temporada ${n}`, specials: 'Especiales', episode: (n) => `Episodio ${n}` },
  de: { season: (n) => `Staffel ${n}`, specials: 'Specials', episode: (n) => `Folge ${n}` },
  it: { season: (n) => `Stagione ${n}`, specials: 'Speciali', episode: (n) => `Episodio ${n}` }
};
function t() {
  return L[config.get().settings.language] || L.en;
}

function serverId() {
  return config.get().serverId;
}

function tag(s) {
  return s ? crypto.createHash('md5').update(String(s)).digest('hex').slice(0, 16) : undefined;
}

function iso(d) {
  if (d === undefined || d === null || d === '') return undefined;
  const x = new Date(d);
  return isNaN(x) ? undefined : x.toISOString();
}

function yearOf(m) {
  const x = String(m.releaseInfo || m.year || m.released || '').match(/\d{4}/);
  return x ? Number(x[0]) : undefined;
}

/** "148 min", "2h 28min", "45" -> ticks */
function runtimeTicks(r) {
  if (!r) return undefined;
  const s = String(r).toLowerCase();
  const h = s.match(/(\d+)\s*h/);
  const m = s.match(/(\d+)\s*m/);
  let min = (h ? Number(h[1]) * 60 : 0) + (m ? Number(m[1]) : 0);
  if (!h && !m) min = parseInt(s, 10) || 0;
  return min ? min * 60 * TICKS : undefined;
}

function rating(r) {
  const n = parseFloat(r);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 10) / 10 : undefined;
}

function genresOf(m) {
  const g = m.genres || m.genre || [];
  return Array.isArray(g) ? g.filter((x) => typeof x === 'string') : [];
}

/** Sous-ensemble d'un meta Stremio qu'on garde en base pour afficher un element sans addon. */
function preview(m) {
  return {
    type: m.type,
    sid: m.id,
    name: m.name,
    poster: m.poster,
    background: m.background,
    logo: m.logo,
    releaseInfo: m.releaseInfo !== undefined ? String(m.releaseInfo) : m.year !== undefined ? String(m.year) : undefined,
    released: m.released,
    description: m.description,
    imdbRating: m.imdbRating,
    genres: genresOf(m).length ? genresOf(m) : undefined,
    runtime: m.runtime,
    imdb: m.imdb_id || (/^tt\d+$/.test(m.id) ? m.id : undefined),
    tmdb: m.moviedb_id || (String(m.id).match(/^tmdb:(\d+)$/) || [])[1],
    certification: m.certification,
    // Dossiers de collection : de quoi retrouver leur contenu, et la forme des vignettes.
    colId: m.colId,
    folderId: m.folderId,
    srcIndex: m.srcIndex,
    shape: m.shape,
    // GIF anime d'un dossier de collection : icone dans les apps Jellyfin (Emby : image fixe).
    gif: m.gif,
    // Fiche deja traduite (TMDB) : les apercus des catalogues ne doivent plus l'ecraser.
    fr: m.fr ? true : undefined
  };
}

function userData(uuid, row, ticks) {
  const r = row || {};
  const d = {
    PlaybackPositionTicks: r.position || 0,
    PlayCount: r.play_count || 0,
    IsFavorite: !!r.favorite,
    Played: !!r.played,
    Key: uuid,
    ItemId: uuid
  };
  if (r.last_played) d.LastPlayedDate = iso(r.last_played);
  if (ticks && r.position) d.PlayedPercentage = Math.min(100, (r.position / ticks) * 100);
  if (r.likes !== null && r.likes !== undefined) d.Likes = !!r.likes;
  return d;
}

function base(uuid, type, name) {
  return {
    Name: name || '',
    ServerId: serverId(),
    Id: uuid,
    Etag: tag(uuid),
    Type: type,
    CanDelete: false,
    CanDownload: false,
    PlayAccess: 'Full',
    LocationType: 'FileSystem',
    LockedFields: [],
    LockData: false,
    Taglines: [],
    Genres: [],
    GenreItems: [],
    Studios: [],
    People: [],
    Tags: [],
    ImageTags: {},
    BackdropImageTags: [],
    ImageBlurHashes: {},
    ProviderIds: {},
    RemoteTrailers: [],
    ExternalUrls: []
  };
}

function people(m, full) {
  if (!full) return [];
  const list = [];
  const add = (name, type, role, photo) => {
    if (!name || list.some((p) => p.Name === name && p.Type === type)) return;
    const id = ids.register(`person|${name}`, 'person', { name, photo });
    const p = { Name: name, Id: id, Type: type };
    if (role) p.Role = role;
    if (photo) p.PrimaryImageTag = tag(photo);
    list.push(p);
  };
  const extras = m.app_extras?.cast;
  if (Array.isArray(extras)) for (const c of extras) add(c.name, 'Actor', c.character, c.photo);
  for (const l of m.links || []) {
    if (l.category === 'Cast') add(l.name, 'Actor');
    else if (l.category === 'Directors') add(l.name, 'Director');
    else if (l.category === 'Writers') add(l.name, 'Writer');
  }
  for (const n of m.cast || []) add(n, 'Actor');
  for (const n of m.director || []) add(n, 'Director');
  for (const n of m.writer || []) add(n, 'Writer');
  return list.slice(0, 40);
}

/** Film ou serie. `m` = meta Stremio (complet ou apercu stocke). */
function mediaItem(uuid, kind, m, udRow, { full = false } = {}) {
  const isSeries = kind === 'series';
  const d = base(uuid, isSeries ? 'Series' : 'Movie', m.name);
  const ticks = runtimeTicks(m.runtime);
  const genres = genresOf(m);
  d.SortName = m.name;
  d.OriginalTitle = m.name;
  d.IsFolder = isSeries;
  d.MediaType = isSeries ? 'Unknown' : 'Video';
  d.Overview = m.description;
  d.ProductionYear = yearOf(m);
  d.PremiereDate = iso(m.released) || (d.ProductionYear ? `${d.ProductionYear}-01-01T00:00:00.0000000Z` : undefined);
  d.DateCreated = d.PremiereDate;
  d.CommunityRating = rating(m.imdbRating);
  d.RunTimeTicks = ticks;
  d.Genres = genres;
  d.GenreItems = genres.map((g) => ({ Name: g, Id: ids.uuidOf(`genre|${g}`) }));
  d.People = people(m, full);
  const imdb = m.imdb || m.imdb_id || (/^tt\d+$/.test(m.sid || m.id || '') ? m.sid || m.id : undefined);
  if (imdb) d.ProviderIds.Imdb = imdb;
  if (m.moviedb_id || m.tmdb) d.ProviderIds.Tmdb = String(m.moviedb_id || m.tmdb);
  if (m.certification) d.OfficialRating = m.certification;
  if (m.tagline) d.Taglines = [m.tagline];
  d.Studios = (m.studios || []).map((n) => ({ Name: n, Id: ids.uuidOf(`studio|${n}`) }));
  if (m.poster) d.ImageTags.Primary = tag(m.poster);
  if (m.logo) d.ImageTags.Logo = tag(m.logo);
  if (m.background) {
    d.BackdropImageTags = [tag(m.background)];
    d.ImageTags.Thumb = tag(m.background);
  }
  d.PrimaryImageAspectRatio = m.posterShape === 'landscape' ? 16 / 9 : m.posterShape === 'square' ? 1 : 2 / 3;
  if (Array.isArray(m.trailers)) {
    d.RemoteTrailers = m.trailers
      .filter((x) => x?.source)
      .map((x) => ({ Url: `https://www.youtube.com/watch?v=${x.source}`, Name: 'Trailer' }));
  }
  if (isSeries) {
    const ri = String(m.releaseInfo || '');
    d.Status = /[–-]\s*$/.test(ri) ? 'Continuing' : /[–-]\s*\d{4}/.test(ri) ? 'Ended' : undefined;
    d.AirDays = [];
  } else {
    d.VideoType = 'VideoFile';
    d.HasSubtitles = true;
    d.Container = 'mkv';
  }
  d.UserData = userData(uuid, udRow, ticks);
  return d;
}

function seasonItem(uuid, series, n, udRow, childCount) {
  const d = base(uuid, 'Season', n === 0 ? t().specials : t().season(n));
  d.IsFolder = true;
  d.MediaType = 'Unknown';
  d.IndexNumber = n;
  d.SortName = String(n).padStart(4, '0');
  d.SeriesId = series.uuid;
  d.SeriesName = series.data.name;
  d.ParentId = series.uuid;
  d.ChildCount = childCount;
  parentImages(d, series);
  if (series.data.poster) d.ImageTags.Primary = tag(series.data.poster);
  d.PrimaryImageAspectRatio = 2 / 3;
  d.UserData = userData(uuid, udRow);
  return d;
}

function episodeItem(uuid, e, series, udRow) {
  const v = e.data;
  const d = base(uuid, 'Episode', v.name || t().episode(v.episode));
  const ticks = runtimeTicks(v.runtime || series?.data.runtime);
  d.IsFolder = false;
  d.MediaType = 'Video';
  d.VideoType = 'VideoFile';
  d.Container = 'mkv';
  d.HasSubtitles = true;
  d.IndexNumber = v.episode;
  d.ParentIndexNumber = v.season;
  d.Overview = v.overview;
  d.PremiereDate = iso(v.released);
  d.DateCreated = d.PremiereDate;
  d.ProductionYear = v.released ? new Date(v.released).getUTCFullYear() || undefined : undefined;
  d.RunTimeTicks = ticks;
  d.SeriesId = v.seriesUuid;
  d.SeriesName = series?.data.name;
  d.SeasonId = v.seasonUuid;
  d.SeasonName = v.season === 0 ? t().specials : t().season(v.season);
  d.ParentId = v.seasonUuid;
  if (series) parentImages(d, series);
  if (v.thumbnail) {
    d.ImageTags.Primary = tag(v.thumbnail);
    d.PrimaryImageAspectRatio = 16 / 9;
  }
  if (series?.data.imdb) d.ProviderIds.Imdb = series.data.imdb;
  d.UserData = userData(uuid, udRow, ticks);
  return d;
}

/** Images heritees de la serie (fond, logo, affiche) : utilisees par toutes les apps. */
function parentImages(d, series) {
  const s = series.data;
  if (s.poster) d.SeriesPrimaryImageTag = tag(s.poster);
  if (s.background) {
    d.ParentBackdropItemId = series.uuid;
    d.ParentBackdropImageTags = [tag(s.background)];
    d.ParentThumbItemId = series.uuid;
    d.ParentThumbImageTag = tag(s.background);
  }
  if (s.logo) {
    d.ParentLogoItemId = series.uuid;
    d.ParentLogoImageTag = tag(s.logo);
  }
}

function viewItem(uuid, view, imageUrl) {
  const d = base(uuid, 'CollectionFolder', view.name);
  d.IsFolder = true;
  d.MediaType = 'Unknown';
  // Collections : un type que les apps parcourent comme des dossiers (pas "folders"/"boxsets",
  // que le client web exclut des rangees "ajouts recents").
  d.CollectionType = { movie: 'movies', series: 'tvshows', collection: 'boxsets', nuviocol: 'musicvideos' }[view.type] || 'movies';
  d.SortName = view.name;
  d.ChildCount = 100;
  if (imageUrl) d.ImageTags.Primary = tag(imageUrl);
  d.PrimaryImageAspectRatio = 16 / 9;
  d.UserData = userData(uuid);
  return d;
}

/** Saga (collection TMDB) : un dossier "BoxSet" qui contient les films dans l'ordre. */
function boxSetItem(uuid, m, udRow, childCount) {
  const d = base(uuid, 'BoxSet', m.name);
  d.IsFolder = true;
  d.MediaType = 'Unknown';
  d.SortName = m.name;
  d.Overview = m.description;
  d.ChildCount = childCount;
  if (m.poster) d.ImageTags.Primary = tag(m.poster);
  if (m.background) {
    d.BackdropImageTags = [tag(m.background)];
    d.ImageTags.Thumb = tag(m.background);
  }
  d.PrimaryImageAspectRatio = 2 / 3;
  d.UserData = userData(uuid, udRow);
  return d;
}

/** Dossier a vignette large : plateforme ou rayon d'une plateforme. */
function folderItem(uuid, m, udRow, childCount) {
  const d = base(uuid, 'Folder', m.name);
  d.IsFolder = true;
  d.MediaType = 'Unknown';
  d.SortName = m.name;
  d.ChildCount = childCount;
  // Icone : le GIF anime pour les apps Jellyfin, l'image fixe pour Emby (qui ne lit pas les GIF).
  // L'etiquette indique laquelle servir (les apps redemandent l'image sans dire qui elles sont).
  const icon = m.gif && !clientContext.isEmbyClient() ? m.gif : m.poster;
  if (icon) {
    d.ImageTags.Primary = tag(icon);
    d.ImageTags.Thumb = tag(icon);
  }
  if (m.background) d.BackdropImageTags = [tag(m.background)];
  if (m.logo) d.ImageTags.Logo = tag(m.logo);
  // Forme des vignettes choisie dans la collection (affiche, paysage, carre).
  d.PrimaryImageAspectRatio = { POSTER: 2 / 3, SQUARE: 1 }[m.shape] || 16 / 9;
  d.UserData = userData(uuid, udRow);
  return d;
}

function genreItem(name, parentUuid) {
  const uuid = ids.register(`genre|${name}`, 'genre', { name });
  const d = base(uuid, 'Genre', name);
  d.IsFolder = true;
  d.MediaType = 'Unknown';
  d.ParentId = parentUuid;
  d.UserData = userData(uuid);
  return d;
}

function personItem(uuid, data) {
  const d = base(uuid, 'Person', data.name);
  d.IsFolder = false;
  d.MediaType = 'Unknown';
  if (data.photo) d.ImageTags.Primary = tag(data.photo);
  d.UserData = userData(uuid);
  return d;
}

// ---- Utilisateur / session --------------------------------------------------

function userDto(profile, { autoLogin = false } = {}) {
  // Accueil : ordre des bibliotheques et celles sans rangee "ajouts recents" (reglees dans l'admin).
  const views = require('../catalog').views(profile);
  const excluded = new Set(profile.latestExcludes || []);
  const now = new Date().toISOString();
  return {
    Name: profile.name,
    ServerId: serverId(),
    ServerName: config.get().settings.serverName,
    Id: profile.id,
    PrimaryImageTag: avatars.tag(profile),
    HasPassword: true,
    HasConfiguredPassword: true,
    HasConfiguredEasyPassword: false,
    // Apps Emby : sans ca, elles ignorent la session enregistree au demarrage.
    EnableAutoLogin: autoLogin,
    LastLoginDate: now,
    LastActivityDate: now,
    Configuration: {
      AudioLanguagePreference: (profile.preferredLanguages || [])[0] || '',
      PlayDefaultAudioTrack: true,
      SubtitleLanguagePreference: '',
      DisplayMissingEpisodes: false,
      GroupedFolders: [],
      SubtitleMode: 'Default',
      DisplayCollectionsView: false,
      EnableLocalPassword: false,
      OrderedViews: views.map((v) => v.uuid),
      LatestItemsExcludes: views.filter((v) => excluded.has(v.key)).map((v) => v.uuid),
      MyMediaExcludes: [],
      HidePlayedInLatest: false,
      RememberAudioSelections: true,
      RememberSubtitleSelections: true,
      EnableNextEpisodeAutoPlay: true,
      CastReceiverId: ''
    },
    Policy: {
      IsAdministrator: false,
      IsHidden: !profile.showOnLogin,
      EnableCollectionManagement: false,
      EnableSubtitleManagement: false,
      EnableLyricManagement: false,
      IsDisabled: !!profile.disabled,
      BlockedTags: [],
      AllowedTags: [],
      EnableUserPreferenceAccess: true,
      AccessSchedules: [],
      BlockUnratedItems: [],
      EnableRemoteControlOfOtherUsers: false,
      EnableSharedDeviceControl: false,
      EnableRemoteAccess: true,
      EnableLiveTvManagement: false,
      EnableLiveTvAccess: false,
      EnableMediaPlayback: true,
      EnableAudioPlaybackTranscoding: false,
      EnableVideoPlaybackTranscoding: false,
      EnablePlaybackRemuxing: false,
      ForceRemoteSourceTranscoding: false,
      EnableContentDeletion: false,
      EnableContentDeletionFromFolders: [],
      EnableContentDownloading: false,
      EnableSyncTranscoding: false,
      EnableMediaConversion: false,
      EnabledDevices: [],
      EnableAllDevices: true,
      EnabledChannels: [],
      EnableAllChannels: true,
      EnabledFolders: [],
      EnableAllFolders: true,
      InvalidLoginAttemptCount: 0,
      LoginAttemptsBeforeLockout: -1,
      MaxActiveSessions: 0,
      EnablePublicSharing: false,
      BlockedMediaFolders: [],
      BlockedChannels: [],
      RemoteClientBitrateLimit: 0,
      AuthenticationProviderId: 'Jellyfin.Server.Implementations.Users.DefaultAuthenticationProvider',
      PasswordResetProviderId: 'Jellyfin.Server.Implementations.Users.DefaultPasswordResetProvider',
      SyncPlayAccess: 'None'
    }
  };
}

function sessionDto(tok, profile, remote) {
  const now = new Date().toISOString();
  return {
    PlayState: { CanSeek: false, IsPaused: false, IsMuted: false, RepeatMode: 'RepeatNone', PlaybackOrder: 'Default' },
    AdditionalUsers: [],
    Capabilities: {
      PlayableMediaTypes: [],
      SupportedCommands: [],
      SupportsMediaControl: false,
      SupportsPersistentIdentifier: true
    },
    RemoteEndPoint: remote || '',
    PlayableMediaTypes: [],
    Id: tag(tok.token + 'session'),
    UserId: profile.id,
    UserName: profile.name,
    Client: tok.client || '',
    LastActivityDate: now,
    LastPlaybackCheckIn: now,
    DeviceName: tok.device || '',
    DeviceId: tok.device_id || '',
    ApplicationVersion: tok.version || '',
    IsActive: true,
    SupportsMediaControl: false,
    SupportsRemoteControl: false,
    NowPlayingQueue: [],
    NowPlayingQueueFullItems: [],
    HasCustomDeviceName: false,
    ServerId: serverId(),
    SupportedCommands: []
  };
}

function queryResult(items, total, start = 0) {
  return { Items: items, TotalRecordCount: total ?? items.length, StartIndex: start };
}

module.exports = {
  TICKS,
  VERSION,
  tag,
  iso,
  preview,
  runtimeTicks,
  userData,
  mediaItem,
  seasonItem,
  episodeItem,
  viewItem,
  boxSetItem,
  folderItem,
  genreItem,
  personItem,
  userDto,
  sessionDto,
  queryResult
};
