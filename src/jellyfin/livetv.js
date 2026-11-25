// TV en direct (IPTV) dans l'API Jellyfin, sur le modele de Polyfin (internal/jellyfin/livetv.go) :
// vue "TV en direct" (CollectionType livetv) quand le profil a des chaines, chaines (TvChannel),
// routes /LiveTv/*, et lecture d'une chaine :
//   - app qui lit le flux tel quel (apps TV, sans profil de lecture) : flux de la chaine, relaye
//     par le serveur (modes direct et warp) ou lu a la source (mode none, redirection) ;
//   - client web (qui ne lit pas le MPEG-TS), ou app qui ne lit pas les codecs : HLS fabrique par
//     FFmpeg (video copiee quand l'app la lit, son converti en AAC), ou la liste HLS du
//     fournisseur relayee quand l'app en lit les codecs.
// Le guide des programmes, le replay et les enregistrements viennent ensuite (phases 2 a 5) :
// leurs routes repondent deja des listes vides, pour que les apps affichent la TV en direct.
const ids = require('../ids');
const config = require('../config');
const cache = require('../cache');
const dto = require('./dto');
const store = require('../iptv/store');
const relay = require('../iptv/relay');
const sources = require('../iptvSources');
const transcode = require('../transcode/decide');
const hls = require('../transcode/hls');
const ffmpeg = require('../transcode/ffmpeg');
const epg = require('../iptv/epg');
const replay = require('../iptv/replay');
const dvr = require('../iptv/dvr');
const crypto = require('crypto');
const { execFile } = require('child_process');

const PORT = Number(process.env.PORT) || 8096;

function log(...args) {
  console.log(new Date().toISOString(), '[live]', ...args);
}

const LABEL = { fr: 'TV en direct', en: 'Live TV', es: 'TV en directo', de: 'Live-TV', it: 'TV in diretta' };

function lq(req) {
  const out = {};
  for (const [k, v] of Object.entries(req.query || {})) out[k.toLowerCase()] = Array.isArray(v) ? v.join(',') : v;
  return out;
}

function int(v, def) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : def;
}

function bool(v) {
  if (v === undefined || v === null || v === '') return undefined;
  return String(v).toLowerCase() === 'true';
}

// ---- Vue et chaines ---------------------------------------------------------------------

// A-t-il des chaines ? (garde 30 s : chaque ouverture de l'accueil le demande)
const hasMemo = new Map();
function hasChannels(profile) {
  if (!profile) return false;
  const hit = hasMemo.get(profile.id);
  if (hit && Date.now() - hit.at < 30e3) return hit.v;
  const list = sources.liveSourcesFor(profile);
  const v = list.length > 0 && store.visible(list, { limit: 1 }).total > 0;
  hasMemo.set(profile.id, { v, at: Date.now() });
  return v;
}
function forget(profileId) {
  if (profileId) hasMemo.delete(profileId);
  else hasMemo.clear();
  replayMemo.clear();
}

function viewUuid(profile) {
  const name = LABEL[config.get().settings.language] || LABEL.fr;
  return ids.register(`view|${profile.id}|livetv`, 'livetv', { profileId: profile.id, name });
}

/** Vue "TV en direct" du profil (UserView livetv), ou null s'il n'a pas de chaine. */
function viewDto(profile) {
  if (!hasChannels(profile)) return null;
  const uuid = viewUuid(profile);
  const d = dto.base(uuid, 'UserView', LABEL[config.get().settings.language] || LABEL.fr);
  d.IsFolder = true;
  d.CollectionType = 'livetv';
  d.MediaType = 'Unknown';
  d.ChildCount = 0;
  d.SortName = d.Name;
  d.UserData = dto.userData(uuid);
  return d;
}

/** Fiche Jellyfin d'une chaine (TvChannel). number : numero affiche si la chaine n'en a pas. */
function channelDto(profile, r, number, { current = false } = {}) {
  if (!r) return null;
  const uuid = ids.register(`chan|${r.source}|${r.key}`, 'channel', { src: r.source, key: r.key, name: r.name, logo: r.logo || undefined });
  const d = dto.base(uuid, 'TvChannel', r.name);
  d.LocationType = 'Remote';
  d.MediaType = 'Video';
  d.IsFolder = false;
  d.ChannelType = 'TV';
  d.Number = r.number || (number ? String(number) : undefined);
  d.ChannelNumber = d.Number;
  d.SortName = r.name;
  d.Genres = r.group_name ? [r.group_name] : [];
  d.Tags = d.Genres;
  if (r.logo) {
    d.ImageTags.Primary = dto.tag(r.logo);
    d.PrimaryImageAspectRatio = 1;
  }
  d.ParentId = viewUuid(profile);
  const { st } = require('../db');
  d.UserData = dto.userData(uuid, st.udGet.get(profile.id, uuid));
  // Programme en cours (guide), comme Jellyfin sur chaque chaine.
  if (current) {
    const p = epg.airing(r);
    if (p) d.CurrentProgram = programDto(profile, r, p, d.Number);
  }
  return d;
}

/** Fiche d'une chaine d'apres son entree (ids), si elle est toujours visible pour le profil. */
function channelFromEntry(profile, entry, opts = { current: true }) {
  const r = store.channel(entry.uuid);
  if (!r || !sources.liveSourcesFor(profile).includes(r.source)) return null;
  return channelDto(profile, r, undefined, opts);
}

// ---- Programmes (guide) -------------------------------------------------------------------

// Programmes servis : id Jellyfin -> chaine et debut (pour la fiche d'un programme, son image,
// la programmation d'un enregistrement). Gardes en memoire : une app redemande un id qu'elle a vu.
const served = new Map();
function remember(uuid, v) {
  if (served.has(uuid)) served.delete(uuid);
  served.set(uuid, v);
  if (served.size > 200000) served.delete(served.keys().next().value);
}
function programUuid(chanUuid, start) {
  return crypto.createHash('sha1').update(`prog|${chanUuid}|${start}`).digest('hex').slice(0, 32);
}

// Categories du guide -> types de Jellyfin (film, serie, info, jeunesse, sport), en plusieurs langues.
const FLAGS = {
  IsMovie: /^(movies?|films?|cin[eé]ma|t[eé]l[eé]film|pel[ií]cula|spielfilm)/i,
  IsSeries: /^(series?|s[eé]rie|show|feuilleton|sitcom|soap|serien)/i,
  IsNews: /^(news|info|information|journal|actualit|noticias|nachrichten|notiziari)/i,
  IsKids: /^(kids?|children|enfants?|jeunesse|dessins? anim|animation|infantil|kinder|bambini|family)/i,
  IsSports: /^(sports?|football|rugby|tennis|deportes|fu[sß]ball)/i
};
function flagsOf(p) {
  const out = {};
  for (const [k, re] of Object.entries(FLAGS)) if (p.categories.some((c) => re.test(String(c).trim()))) out[k] = true;
  if (!out.IsMovie && !out.IsSeries && (p.season || p.episode || p.subtitle)) out.IsSeries = true;
  return out;
}

/** Fiche Jellyfin d'un programme (Program) d'une chaine. */
function programDto(profile, r, p, number, { images = true } = {}) {
  const chanUuid = r.uuid;
  const uuid = programUuid(chanUuid, p.start);
  remember(uuid, { chan: chanUuid, start: p.start });
  const d = dto.base(uuid, 'Program', p.title);
  d.LocationType = 'Remote';
  d.MediaType = 'Video';
  d.IsFolder = false;
  d.ChannelId = chanUuid;
  d.ChannelName = r.name;
  d.ChannelNumber = r.number || number || undefined;
  if (r.logo) d.ChannelPrimaryImageTag = dto.tag(r.logo);
  d.StartDate = new Date(p.start).toISOString();
  d.EndDate = new Date(p.stop).toISOString();
  d.RunTimeTicks = (p.stop - p.start) * 1e4;
  d.Overview = p.descr || undefined;
  d.EpisodeTitle = p.subtitle || undefined;
  if (p.episode) d.IndexNumber = p.episode;
  if (p.season) d.ParentIndexNumber = p.season;
  d.Genres = p.categories;
  d.Tags = p.categories;
  Object.assign(d, flagsOf(p));
  if (p.rerun) d.IsRepeat = true;
  const now = Date.now();
  if (p.start <= now && p.stop > now) d.IsLive = false;
  if (images && p.icon) {
    d.ImageTags.Primary = dto.tag(p.icon);
    d.PrimaryImageAspectRatio = 16 / 9;
  }
  d.UserData = dto.userData(uuid);
  // Enregistrement programme (point rouge dans le guide des apps).
  const tm = profile && dvr.timersOf(profile).find((x) => x.chan === chanUuid && x.program_start === p.start && ['scheduled', 'recording'].includes(x.status));
  if (tm) {
    d.TimerId = tm.id;
    if (tm.series_timer) d.SeriesTimerId = tm.series_timer;
  }
  return d;
}

/** Programme d'apres son id Jellyfin : { r (chaine), p (programme) } ou null. */
function programByUuid(uuid) {
  const hit = served.get(ids.norm(uuid));
  if (!hit) return null;
  const r = store.channel(hit.chan);
  if (!r?.epg_guide) return null;
  const p = epg.programAt(r.epg_guide, r.epg_channel, hit.start);
  return p ? { r, p } : null;
}

/** Fiche d'un programme (route /Items/:id), si sa chaine est visible pour le profil. */
function itemFor(profile, id) {
  const x = programByUuid(id);
  if (!x || !sources.liveSourcesFor(profile).includes(x.r.source)) return null;
  const d = programDto(profile, x.r, x.p);
  d.Channel = undefined;
  return d;
}

/** Image d'un programme (son affiche du guide), ou null. */
function programImage(id) {
  return programByUuid(id)?.p.icon || null;
}

/** Corps de requete et query reunis, cles en minuscules (le client web poste GetProgramsDto). */
function programQuery(req) {
  const out = {};
  for (const src of [req.query || {}, req.method === 'POST' && req.body && typeof req.body === 'object' ? req.body : {}]) {
    for (const [k, v] of Object.entries(src)) out[k.toLowerCase()] = Array.isArray(v) ? v.join(',') : v;
  }
  return out;
}

function dateOf(v) {
  const t = v ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? t : undefined;
}

/**
 * Programmes du guide (/LiveTv/Programs) : chaines demandees (sinon toutes celles du profil),
 * bornes MinStartDate / MaxStartDate / MinEndDate / MaxEndDate, HasAired, IsAiring, types
 * (IsMovie, IsSeries, IsNews, IsKids, IsSports), Genres, tri par debut, pages.
 */
function programsList(profile, q, { recommended = false } = {}) {
  const live = sources.liveSourcesFor(profile);
  const now = Date.now();
  let rows;
  const wanted = String(q.channelids || '').split(',').map((x) => ids.norm(x)).filter((x) => x.length === 32);
  if (wanted.length) rows = wanted.map((u) => store.channel(u)).filter((r) => r && live.includes(r.source) && r.enabled && r.group_enabled);
  else rows = store.visible(live, { limit: 5000 }).items;
  rows = rows.filter((r) => r.epg_guide);
  const minStart = dateOf(q.minstartdate);
  const maxStart = dateOf(q.maxstartdate);
  const minEnd = dateOf(q.minenddate);
  const maxEnd = dateOf(q.maxenddate);
  const hasAired = q.hasaired === undefined || q.hasaired === '' ? undefined : String(q.hasaired) === 'true';
  let isAiring = q.isairing === undefined || q.isairing === '' ? undefined : String(q.isairing) === 'true';
  // "Recommandes" sans precision : ce qui passe maintenant (accueil "En ce moment").
  if (recommended && isAiring === undefined && hasAired === undefined) isAiring = true;
  // Fenetre lue en base : bornes demandees, sinon de maintenant a la fin du guide.
  let from = minEnd ?? minStart ?? (hasAired === true ? now - 7 * 864e5 : now);
  let to = maxStart ?? maxEnd ?? now + 8 * 864e5;
  if (isAiring) {
    from = now;
    to = now + 1;
  }
  const want = {};
  for (const k of ['ismovie', 'isseries', 'isnews', 'iskids', 'issports']) if (q[k] !== undefined && q[k] !== '') want[k] = String(q[k]) === 'true';
  const genres = String(q.genres || '').split(/[|,]/).map((x) => x.trim().toLowerCase()).filter(Boolean);
  const out = [];
  rows.forEach((r) => {
    for (const p of epg.programs(r, from, to)) {
      if (minStart !== undefined && p.start < minStart) continue;
      if (maxStart !== undefined && p.start > maxStart) continue;
      if (minEnd !== undefined && p.stop < minEnd) continue;
      if (maxEnd !== undefined && p.stop > maxEnd) continue;
      if (hasAired === true && p.stop > now) continue;
      if (hasAired === false && p.stop <= now) continue;
      if (isAiring === true && !(p.start <= now && p.stop > now)) continue;
      if (isAiring === false && p.start <= now && p.stop > now) continue;
      const f = flagsOf(p);
      let ok = true;
      for (const [k, v] of Object.entries(want)) {
        const key = 'Is' + k.slice(2, 3).toUpperCase() + k.slice(3);
        if (!!f[key] !== v) ok = false;
      }
      if (!ok) continue;
      if (genres.length && !p.categories.some((c) => genres.includes(String(c).toLowerCase()))) continue;
      out.push({ r, p });
    }
  });
  out.sort((a, b) => a.p.start - b.p.start || String(a.r.name).localeCompare(b.r.name));
  const start = int(q.startindex, 0);
  const limit = int(q.limit, 0);
  const page = limit ? out.slice(start, start + limit) : out.slice(start);
  const images = String(q.enableimages) !== 'false';
  return { items: page.map(({ r, p }) => programDto(profile, r, p, undefined, { images })), total: out.length, start };
}

/** Chaines du profil, filtres de l'app (favoris, groupes), avec numero par defaut = position. */
function channelsOf(profile, { start = 0, limit = 0, favorites, groups, search, current = true } = {}) {
  const list = sources.liveSourcesFor(profile);
  let uuids;
  if (favorites !== undefined) {
    const { db } = require('../db');
    const fav = db.prepare('SELECT uuid FROM userdata WHERE profile = ? AND favorite = 1').all(profile.id).map((r) => r.uuid);
    if (favorites) uuids = fav;
    else {
      // "Pas favoris" : toutes moins les favoris.
      const all = store.visible(list, { groups, search }).items.filter((r) => !fav.includes(r.uuid));
      return { items: all.slice(start, limit ? start + limit : undefined).map((r, i) => channelDto(profile, r, start + i + 1, { current })), total: all.length };
    }
  }
  const { items, total } = store.visible(list, { start, limit, uuids, groups, search });
  return { items: items.map((r, i) => channelDto(profile, r, start + i + 1, { current })), total };
}

// ---- Replay (archive des programmes passes) ---------------------------------------------------

const REPLAY_LABEL = { fr: 'Replay', en: 'Replay', es: 'Repetición', de: 'Replay', it: 'Replay' };

/** Chaines du profil qui ont une archive et un guide (garde 30 s). */
const replayMemo = new Map();
function replayChannels(profile) {
  const hit = replayMemo.get(profile.id);
  if (hit && Date.now() - hit.at < 30e3) return hit.v;
  const v = store.visible(sources.liveSourcesFor(profile), { limit: 20000 }).items.filter((r) => r.epg_guide && replay.daysOf(r));
  replayMemo.set(profile.id, { v, at: Date.now() });
  return v;
}

function replayViewUuid(profile) {
  return ids.register(`view|${profile.id}|replay`, 'replay', { profileId: profile.id, name: REPLAY_LABEL[config.get().settings.language] || 'Replay' });
}

/** Vue "Replay" du profil (un dossier par chaine a archive), ou null. */
function replayViewDto(profile) {
  if (!hasChannels(profile) || !replayChannels(profile).length) return null;
  const uuid = replayViewUuid(profile);
  const d = dto.base(uuid, 'UserView', REPLAY_LABEL[config.get().settings.language] || 'Replay');
  d.IsFolder = true;
  d.CollectionType = 'folders';
  d.MediaType = 'Unknown';
  d.ChildCount = replayChannels(profile).length;
  d.SortName = d.Name;
  d.UserData = dto.userData(uuid);
  return d;
}

function replayFolderDto(profile, r) {
  const uuid = ids.register(`replaychan|${r.uuid}`, 'replaychan', { chan: r.uuid, name: r.name, logo: r.logo || undefined, profileId: profile.id });
  const d = dto.base(uuid, 'Folder', r.name);
  d.IsFolder = true;
  d.MediaType = 'Unknown';
  d.SortName = r.name;
  if (r.logo) {
    d.ImageTags.Primary = dto.tag(r.logo);
    d.PrimaryImageAspectRatio = 1;
  }
  d.ParentId = replayViewUuid(profile);
  d.UserData = dto.userData(uuid);
  return d;
}

/** Fiche d'un programme passe (Video lisible, avec reprise et "vu"). */
function replayProgDto(profile, r, p) {
  const name = p.subtitle ? `${p.title} · ${p.subtitle}` : p.title;
  const uuid = ids.register(`replayprog|${r.uuid}|${p.start}`, 'replayprog', {
    chan: r.uuid,
    start: p.start,
    stop: p.stop,
    name,
    title: p.title,
    descr: p.descr || undefined,
    icon: p.icon || undefined,
    logo: r.logo || undefined,
    channelName: r.name,
    runtime: String(Math.max(1, Math.round((p.stop - p.start) / 60e3)))
  });
  return replayEntryDto(profile, ids.get(uuid));
}

function replayEntryDto(profile, entry) {
  const x = entry.data;
  const { st } = require('../db');
  const d = dto.base(entry.uuid, 'Video', x.name);
  d.MediaType = 'Video';
  d.IsFolder = false;
  d.RunTimeTicks = (x.stop - x.start) * 1e4;
  d.Overview = [x.descr, `${x.channelName} · ${new Date(x.start).toLocaleString(config.get().settings.language || 'fr', { dateStyle: 'medium', timeStyle: 'short' })}`].filter(Boolean).join('\n\n');
  d.PremiereDate = new Date(x.start).toISOString();
  d.DateCreated = d.PremiereDate;
  d.ProductionYear = new Date(x.start).getFullYear();
  d.SortName = x.name;
  const img = x.icon || x.logo;
  if (img) {
    d.ImageTags.Primary = dto.tag(img);
    d.PrimaryImageAspectRatio = x.icon ? 16 / 9 : 1;
  }
  d.ParentId = ids.uuidOf(`replaychan|${x.chan}`);
  d.UserData = dto.userData(entry.uuid, st.udGet.get(profile.id, entry.uuid), d.RunTimeTicks);
  return d;
}

/** Contenu de la vue Replay (dossiers) ou d'un dossier (programmes passes, les plus recents d'abord). */
function replayChildren(profile, entry, { start = 0, limit = 0 } = {}) {
  const page = (list) => ({ items: limit ? list.slice(start, start + limit) : list.slice(start), total: list.length });
  if (entry.kind === 'replay') {
    const list = replayChannels(profile);
    const p = page(list);
    return { items: p.items.map((r) => replayFolderDto(profile, r)), total: p.total };
  }
  const r = store.channel(entry.data.chan);
  if (!r || !sources.liveSourcesFor(profile).includes(r.source)) return { items: [], total: 0 };
  const now = Date.now();
  const from = now - replay.daysOf(r) * 864e5;
  const progs = epg.programs(r, from, now).filter((p) => p.stop <= now && p.start >= from).sort((a, b) => b.start - a.start);
  const p = page(progs);
  return { items: p.items.map((x) => replayProgDto(profile, r, x)), total: p.total };
}

/** PlaybackInfo d'un programme passe : archive du fournisseur, toujours relayee (identifiants). */
async function replayPlaybackInfo(req, entry, request = {}) {
  const profile = req.profile;
  const x = entry.data;
  const r = store.channel(x.chan);
  const src = r && sources.byId(r.source);
  const res = { MediaSources: [], PlaySessionId: crypto.randomBytes(16).toString('hex') };
  if (!r || !src || !sources.liveSourcesFor(profile).includes(r.source) || x.start < Date.now() - replay.daysOf(r) * 864e5) {
    res.ErrorCode = 'NoCompatibleStream';
    return res;
  }
  const url = replay.urlFor(src, r, x.start, x.stop);
  if (!url) {
    res.ErrorCode = 'NoCompatibleStream';
    return res;
  }
  const key = `${src.id}|replay|${entry.uuid}`;
  try {
    relay.reserve(src, profile.id, key);
  } catch (e) {
    log(`${x.name} : ${e.message}`);
    res.ErrorCode = 'NoCompatibleStream';
    return res;
  }
  let mode = sources.modeFor(profile, r.source);
  if (mode === 'none') mode = 'direct';
  const headers = { 'user-agent': r.headers?.['user-agent'] || src.userAgent || require('../iptv/fetch').BROWSER_UA, ...(r.headers || {}) };
  const id = crypto.createHash('sha1').update(`${entry.uuid}|${url}`).digest('hex').slice(0, 32);
  const s = { id, uuid: entry.uuid, url, headers, name: `Replay · ${r.name}`, addon: src.name, mode, relay: true, container: 'ts', text: '', bucket: 'unknown', iptvKey: key, iptvProfile: profile.id };
  cache.put('src|' + id, s, 12 * 3600e3);
  const playback = require('./playback');
  res.MediaSources = [playback.mediaSource(entry.uuid, s, req.tok?.token || '', [], { profile, request, name: `Replay · ${r.name}` })];
  log(`${x.name} (${r.name}) : replay du ${new Date(x.start).toISOString().slice(0, 16)}`);
  return res;
}

// ---- Enregistrements (programmations, series, fichiers) ---------------------------------------

const TIMER_STATUS = { scheduled: 'New', recording: 'InProgress', done: 'Completed', failed: 'Error', cancelled: 'Cancelled' };

function timerDto(profile, t) {
  const ch = store.channel(t.chan);
  const progId = t.program_start ? programUuid(t.chan, t.program_start) : undefined;
  if (progId) remember(progId, { chan: t.chan, start: t.program_start });
  return {
    Id: t.id,
    Type: 'Timer',
    ServerId: config.get().serverId,
    ExternalId: t.id,
    ChannelId: t.chan,
    ExternalChannelId: t.chan,
    ChannelName: ch?.name || '',
    ChannelPrimaryImageTag: ch?.logo ? dto.tag(ch.logo) : undefined,
    ProgramId: progId,
    ExternalProgramId: progId,
    Name: t.name,
    Overview: t.overview || undefined,
    StartDate: new Date(t.start).toISOString(),
    EndDate: new Date(t.stop).toISOString(),
    ServiceName: 'Stremfin',
    Priority: 0,
    PrePaddingSeconds: Math.round(t.pre / 1000),
    PostPaddingSeconds: Math.round(t.post / 1000),
    IsPrePaddingRequired: false,
    IsPostPaddingRequired: false,
    KeepUntil: 'UntilDeleted',
    Status: TIMER_STATUS[t.status] || 'New',
    SeriesTimerId: t.series_timer || undefined
  };
}

function seriesTimerDto(profile, st) {
  const ch = store.channel(st.chan);
  const pad = dvr.padding();
  return {
    Id: st.id,
    Type: 'SeriesTimer',
    ServerId: config.get().serverId,
    ExternalId: st.id,
    ChannelId: st.chan,
    ChannelName: ch?.name || '',
    Name: st.title,
    ServiceName: 'Stremfin',
    Priority: 0,
    PrePaddingSeconds: Math.round((st.pre ?? pad.pre) / 1000),
    PostPaddingSeconds: Math.round((st.post ?? pad.post) / 1000),
    IsPrePaddingRequired: false,
    IsPostPaddingRequired: false,
    KeepUntil: 'UntilDeleted',
    KeepUpTo: 0,
    RecordAnyChannel: !!st.any_channel,
    RecordAnyTime: true,
    RecordNewOnly: false,
    SkipEpisodesInLibrary: false,
    Days: [],
    DayPattern: 'Daily',
    ImageTags: {},
    StartDate: new Date(st.created).toISOString(),
    EndDate: new Date(st.created).toISOString()
  };
}

function recordingDto(profile, t) {
  const minutes = String(Math.max(1, Math.round((t.stop - t.start) / 60e3)));
  const uuid = ids.register(`rec|${t.id}`, 'recording', { timer: t.id, profileId: t.profile, runtime: minutes });
  const ch = store.channel(t.chan);
  const d = dto.base(uuid, 'Video', t.episode ? `${t.name} · ${t.episode}` : t.name);
  d.MediaType = 'Video';
  d.IsFolder = false;
  d.CanDelete = true;
  d.RunTimeTicks = (t.stop - t.start) * 1e4;
  d.Overview = t.overview || undefined;
  d.ChannelId = t.chan;
  d.ChannelName = ch?.name || undefined;
  d.StartDate = new Date(t.start).toISOString();
  d.EndDate = new Date(t.stop).toISOString();
  d.PremiereDate = d.StartDate;
  d.DateCreated = new Date(t.created).toISOString();
  d.Status = TIMER_STATUS[t.status] || 'Completed';
  d.TimerId = t.id;
  if (t.series_timer) d.SeriesTimerId = t.series_timer;
  if (t.image) {
    d.ImageTags.Primary = dto.tag(t.image);
    d.PrimaryImageAspectRatio = 16 / 9;
  }
  const { st } = require('../db');
  d.UserData = dto.userData(uuid, st.udGet.get(profile.id, uuid), d.RunTimeTicks);
  return d;
}

function recordingFromEntry(profile, entry) {
  const t = dvr.timer(entry.data.timer);
  return t && t.profile === profile.id && t.file ? recordingDto(profile, t) : null;
}

/** PlaybackInfo d'un enregistrement : son fichier, lu comme une video (conversion si besoin). */
function recordingPlaybackInfo(req, entry, request = {}) {
  const t = dvr.timer(entry.data.timer);
  const res = { MediaSources: [], PlaySessionId: crypto.randomBytes(16).toString('hex') };
  const fs = require('fs');
  if (!t || t.profile !== req.profile.id || !t.file || !fs.existsSync(t.file)) {
    res.ErrorCode = 'NoCompatibleStream';
    return res;
  }
  const id = crypto.createHash('sha1').update(`${entry.uuid}|${t.file}`).digest('hex').slice(0, 32);
  const s = { id, uuid: entry.uuid, file: t.file, url: 'file', name: t.name, addon: 'Stremfin', relay: true, container: 'ts', text: '', bucket: 'unknown', size: fs.statSync(t.file).size };
  cache.put('src|' + id, s, 12 * 3600e3);
  res.MediaSources = [require('./playback').mediaSource(entry.uuid, s, req.tok?.token || '', [], { profile: req.profile, request, name: t.name })];
  return res;
}

/** Programme d'apres un id de programme (ou chaine + debut) pour une programmation. */
function programFor(profile, body) {
  const x = programByUuid(body.ProgramId || body.programId || '');
  if (!x || !sources.liveSourcesFor(profile).includes(x.r.source)) throw new Error('Programme introuvable');
  return x;
}

function timerRoutes(router) {
  const live = (req) => sources.liveSourcesFor(req.profile);
  const own = (req, t) => t && t.profile === req.profile.id;
  router.get('/LiveTv/Timers/Defaults', (req, res) => {
    const q = lq(req);
    const pad = dvr.padding();
    const x = programByUuid(q.programid || '');
    const base = { Type: 'SeriesTimer', ServerId: config.get().serverId, PrePaddingSeconds: Math.round(pad.pre / 1000), PostPaddingSeconds: Math.round(pad.post / 1000), IsPrePaddingRequired: false, IsPostPaddingRequired: false, RecordAnyChannel: false, RecordAnyTime: true, RecordNewOnly: false, SkipEpisodesInLibrary: false, Days: [], KeepUpTo: 0, KeepUntil: 'UntilDeleted', Priority: 0, ImageTags: {} };
    if (x && live(req).includes(x.r.source)) {
      Object.assign(base, { ProgramId: q.programid, ChannelId: x.r.uuid, ChannelName: x.r.name, Name: x.p.title, Overview: x.p.descr || undefined, StartDate: new Date(x.p.start).toISOString(), EndDate: new Date(x.p.stop).toISOString() });
    }
    res.json(base);
  });
  router.get('/LiveTv/Timers', (req, res) => {
    const q = lq(req);
    let list = dvr.timersOf(req.profile).filter((t) => ['scheduled', 'recording'].includes(t.status));
    if (q.channelid) list = list.filter((t) => t.chan === ids.norm(q.channelid));
    if (q.seriestimerid) list = list.filter((t) => t.series_timer === ids.norm(q.seriestimerid));
    if (q.isactive === 'true') list = list.filter((t) => t.status === 'recording');
    if (q.isscheduled === 'true') list = list.filter((t) => t.status === 'scheduled');
    res.json(dto.queryResult(list.map((t) => timerDto(req.profile, t))));
  });
  router.get('/LiveTv/Timers/:id', (req, res) => {
    const t = dvr.timer(req.params.id);
    own(req, t) ? res.json(timerDto(req.profile, t)) : res.status(404).end();
  });
  router.post('/LiveTv/Timers', (req, res) => {
    try {
      const b = req.body || {};
      const x = programFor(req.profile, b);
      dvr.schedule(req.profile, x.r, x.p, { pre: b.PrePaddingSeconds !== undefined ? Number(b.PrePaddingSeconds) * 1000 : undefined, post: b.PostPaddingSeconds !== undefined ? Number(b.PostPaddingSeconds) * 1000 : undefined });
      res.status(204).end();
    } catch (e) {
      res.status(400).send(e.message);
    }
  });
  router.post('/LiveTv/Timers/:id', (req, res) => {
    const t = dvr.timer(req.params.id);
    if (!own(req, t)) return res.status(404).end();
    const b = req.body || {};
    dvr.setPadding(t.id, b.PrePaddingSeconds !== undefined ? Number(b.PrePaddingSeconds) * 1000 : undefined, b.PostPaddingSeconds !== undefined ? Number(b.PostPaddingSeconds) * 1000 : undefined);
    res.status(204).end();
  });
  router.delete('/LiveTv/Timers/:id', (req, res) => {
    const t = dvr.timer(req.params.id);
    if (!own(req, t)) return res.status(404).end();
    dvr.cancel(t.id);
    res.status(204).end();
  });
  router.get('/LiveTv/SeriesTimers', (req, res) => res.json(dto.queryResult(dvr.seriesOf(req.profile).map((x) => seriesTimerDto(req.profile, x)))));
  router.get('/LiveTv/SeriesTimers/:id', (req, res) => {
    const x = dvr.oneSeries(req.params.id);
    x && x.profile === req.profile.id ? res.json(seriesTimerDto(req.profile, x)) : res.status(404).end();
  });
  router.post('/LiveTv/SeriesTimers', (req, res) => {
    try {
      const b = req.body || {};
      const x = programFor(req.profile, b);
      dvr.addSeries(req.profile, x.r, x.p, { anyChannel: !!b.RecordAnyChannel, pre: b.PrePaddingSeconds !== undefined ? Number(b.PrePaddingSeconds) * 1000 : undefined, post: b.PostPaddingSeconds !== undefined ? Number(b.PostPaddingSeconds) * 1000 : undefined });
      res.status(204).end();
    } catch (e) {
      res.status(400).send(e.message);
    }
  });
  router.post('/LiveTv/SeriesTimers/:id', (req, res) => res.status(204).end());
  router.delete('/LiveTv/SeriesTimers/:id', (req, res) => {
    const x = dvr.oneSeries(req.params.id);
    if (!x || x.profile !== req.profile.id) return res.status(404).end();
    dvr.removeSeries(x.id);
    res.status(204).end();
  });
  // Enregistrements faits ou en cours.
  router.get('/LiveTv/Recordings', (req, res) => {
    const q = lq(req);
    let list = dvr.timersOf(req.profile).filter((t) => t.file && ['recording', 'done'].includes(t.status)).sort((a, b) => b.start - a.start);
    if (q.isinprogress === 'true') list = list.filter((t) => t.status === 'recording');
    if (q.isinprogress === 'false') list = list.filter((t) => t.status !== 'recording');
    if (q.channelid) list = list.filter((t) => t.chan === ids.norm(q.channelid));
    const start = int(q.startindex, 0);
    const limit = int(q.limit, 0);
    const page = limit ? list.slice(start, start + limit) : list.slice(start);
    res.json(dto.queryResult(page.map((t) => recordingDto(req.profile, t)), list.length, start));
  });
  router.get(['/LiveTv/Recordings/Folders', '/LiveTv/Recordings/Series', '/LiveTv/Recordings/Groups'], (req, res) => res.json(dto.queryResult([], 0, 0)));
  router.get('/LiveTv/Recordings/:id', (req, res) => {
    const e = ids.get(req.params.id);
    const d = e?.kind === 'recording' && recordingFromEntry(req.profile, e);
    d ? res.json(d) : res.status(404).end();
  });
  router.delete(['/LiveTv/Recordings/:id', '/Items/:id'], (req, res) => {
    const e = ids.get(req.params.id);
    const t = e?.kind === 'recording' && dvr.timer(e.data.timer);
    if (!own(req, t)) return res.status(404).end();
    dvr.removeRecording(t.id);
    res.status(204).end();
  });
}

// ---- Analyse d'un flux (ffprobe), gardee une semaine --------------------------------------

function run(file, args, timeout) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => resolve(error ? null : String(stdout || '')));
  });
}

function streamsOf(probe) {
  const out = [];
  for (const s of probe?.streams || []) {
    if (s.codec_type === 'video' && !/png|mjpeg|bmp/.test(s.codec_name || '')) {
      const [num, den] = String(s.avg_frame_rate || '0/1').split('/').map(Number);
      out.push({
        Type: 'Video',
        Codec: s.codec_name,
        Index: s.index,
        Width: s.width,
        Height: s.height,
        IsInterlaced: !!s.field_order && !/progressive|unknown/.test(s.field_order),
        AverageFrameRate: den ? Math.round((num / den) * 100) / 100 : undefined,
        Profile: s.profile,
        Level: s.level,
        BitDepth: s.bits_per_raw_sample ? Number(s.bits_per_raw_sample) : undefined,
        VideoRange: 'SDR',
        VideoRangeType: 'SDR',
        IsAVC: s.codec_name === 'h264',
        IsDefault: true,
        IsForced: false,
        IsExternal: false,
        IsTextSubtitleStream: false,
        SupportsExternalStream: false
      });
    } else if (s.codec_type === 'audio') {
      const ch = s.channels || 2;
      const layout = ch >= 8 ? '7.1' : ch >= 6 ? '5.1' : ch === 1 ? 'mono' : 'stereo';
      out.push({
        Type: 'Audio',
        Codec: s.codec_name,
        Index: s.index,
        Channels: ch,
        ChannelLayout: layout,
        SampleRate: Number(s.sample_rate) || undefined,
        Language: s.tags?.language && s.tags.language !== 'und' ? s.tags.language : undefined,
        DisplayTitle: `${String(s.codec_name || '').toUpperCase()} ${layout}`,
        IsDefault: !out.some((x) => x.Type === 'Audio'),
        IsForced: false,
        IsExternal: false,
        IsInterlaced: false,
        IsTextSubtitleStream: false,
        SupportsExternalStream: false
      });
    }
  }
  return out.map((x) => Object.fromEntries(Object.entries(x).filter(([, v]) => v !== undefined)));
}

// Pistes supposees quand l'analyse echoue : la plupart des chaines sont en H.264 + AAC ou MP2.
const GUESS = [
  { Type: 'Video', Codec: 'h264', Index: 0, IsInterlaced: false, IsDefault: true, VideoRange: 'SDR', VideoRangeType: 'SDR' },
  { Type: 'Audio', Codec: 'mp2', Index: 1, Channels: 2, ChannelLayout: 'stereo', IsDefault: true, DisplayTitle: 'Audio' }
];

async function probe(r, sessId, isHls) {
  const key = `liveprobe|${r.uuid}|${r.url.length}`;
  const hit = cache.peek(key);
  if (hit) return hit.v;
  const st = ffmpeg.status();
  if (!st.probe) return { streams: GUESS, guessed: true };
  const input = `http://127.0.0.1:${PORT}/Videos/${r.uuid}/live/${isHls ? 'index.m3u8' : 'stream.ts'}?ls=${sessId}&relay=1`;
  const t0 = Date.now();
  const out = await run(st.probe, ['-v', 'error', '-analyzeduration', '3000000', '-probesize', '3000000', '-show_streams', '-show_format', '-of', 'json', input], 20000);
  let parsed = null;
  try {
    parsed = out && JSON.parse(out);
  } catch {}
  const streams = streamsOf(parsed);
  if (!streams.length) {
    log(`${r.name} : analyse impossible (${Date.now() - t0} ms), pistes supposées`);
    cache.put(key, { streams: GUESS, guessed: true }, 5 * 60e3);
    return { streams: GUESS, guessed: true };
  }
  const v = { streams, bitrate: Number(parsed.format?.bit_rate) || 0 };
  log(`${r.name} : ${streams.map((s) => `${s.Type === 'Video' ? `${s.Codec} ${s.Width}x${s.Height}${s.IsInterlaced ? 'i' : ''}` : `${s.Codec} ${s.Channels}ch`}`).join(', ')} (${Date.now() - t0} ms)`);
  cache.put(key, v, 7 * 864e5);
  return v;
}

// ---- Lecture -----------------------------------------------------------------------------

function isWeb(req) {
  const c = String(req.tok?.client || req.authInfo?.client || '').toLowerCase();
  return c.includes('web') || c.includes('media player');
}

/** PlaybackInfo d'une chaine : une source (flux relaye, redirige ou converti en HLS). */
async function playbackInfo(req, entry, request = {}) {
  const profile = req.profile;
  const r = store.channel(entry.uuid);
  const src = r && sources.byId(r.source);
  const res = { MediaSources: [], PlaySessionId: '' };
  if (!r || !src || !sources.liveSourcesFor(profile).includes(r.source)) {
    res.ErrorCode = 'NoCompatibleStream';
    return res;
  }
  const mode = sources.modeFor(profile, r.source);
  const isHls = /\.m3u8(\?|$)/i.test(r.url);
  const sessId = relay.newSession({ channel: r.uuid, source: r.source, profileId: profile.id, mode, name: r.name });
  res.PlaySessionId = sessId;
  let info;
  try {
    info = await probe(r, sessId, isHls);
  } catch (e) {
    if (e instanceof relay.LimitError) {
      log(`${r.name} : ${e.message}`);
      res.ErrorCode = 'NoCompatibleStream';
      return res;
    }
    info = { streams: GUESS, guessed: true };
  }
  const streams = info.streams;
  const video = streams.find((s) => s.Type === 'Video');
  const audio = streams.find((s) => s.Type === 'Audio');
  const container = 'ts';
  const token = req.tok?.token || '';
  const direct = `/Videos/${r.uuid}/live/${isHls ? 'index.m3u8' : 'stream.ts'}?ls=${sessId}`;
  const source = {
    Protocol: 'Http',
    Id: sessId,
    Type: 'Default',
    Container: isHls ? 'hls' : container,
    Name: r.name,
    IsRemote: true,
    ETag: r.uuid,
    ReadAtNativeFramerate: false,
    IgnoreDts: true,
    IgnoreIndex: false,
    GenPtsInput: false,
    SupportsTranscoding: false,
    SupportsDirectStream: true,
    SupportsDirectPlay: true,
    IsInfiniteStream: true,
    UseMostCompatibleTranscodingProfile: false,
    RequiresOpening: false,
    RequiresClosing: false,
    RequiresLooping: false,
    SupportsProbing: false,
    VideoType: 'VideoFile',
    MediaStreams: streams,
    MediaAttachments: [],
    Formats: [],
    RequiredHttpHeaders: {},
    TranscodingSubProtocol: 'http',
    DefaultAudioStreamIndex: audio ? audio.Index : undefined,
    Path: direct,
    DirectStreamUrl: direct
  };
  if (info.bitrate) source.Bitrate = info.bitrate;
  // Decision : ce que l'app lit telle quelle (profil de lecture). Le client web ne lit jamais le
  // MPEG-TS d'une chaine : toujours du HLS.
  let d = transcode.decide({ streams, container, audioIndex: audio?.Index, request });
  if (d.directPlay && isWeb(req) && request.DeviceProfile) {
    d = transcode.decide({ streams, container: 'flv', audioIndex: audio?.Index, request });
  }
  // Image entrelacee (1080i, 576i) pour le client web : desentrelacee (les navigateurs ne le font pas).
  if (!d.directPlay && d.transcoding && isWeb(req) && video?.IsInterlaced && config.get().settings.transcodeMode === 'full') d.copyVideo = false;
  if (!d.directPlay && d.transcoding) {
    if (isHls && d.copyVideo && d.copyAudio) {
      // La liste HLS du fournisseur, relayee : rien a convertir.
      Object.assign(source, { SupportsDirectPlay: false, SupportsDirectStream: false, SupportsTranscoding: true, TranscodingUrl: direct, TranscodingSubProtocol: 'hls', TranscodingContainer: 'ts' });
    } else if (hls.available()) {
      const input = `http://127.0.0.1:${PORT}/Videos/${r.uuid}/live/${isHls ? 'index.m3u8' : 'stream.ts'}?ls=${sessId}&relay=1`;
      const url = hls.prepare({ itemUuid: r.uuid, msid: sessId, token, container, live: true, input, runtime: 0, decision: d, audio, video, bitrate: info.bitrate, profileId: profile.id, name: r.name });
      Object.assign(source, {
        SupportsDirectPlay: false,
        SupportsDirectStream: false,
        SupportsTranscoding: true,
        TranscodingUrl: `${url}?api_key=${token}&TranscodeReasons=${d.reasons.join(',')}`,
        TranscodingSubProtocol: 'hls',
        TranscodingContainer: d.transcoding.container
      });
    } else {
      log(`${r.name} : conversion indisponible (FFmpeg absent ou trop de conversions), flux servi tel quel`);
    }
  }
  log(`${r.name} : ${source.TranscodingUrl ? (source.TranscodingUrl === direct ? 'HLS du fournisseur relayé' : `HLS par FFmpeg (${d.copyVideo ? 'image copiée' : 'image convertie'}, ${d.copyAudio ? 'son copié' : 'son converti'})`) : mode === 'none' && !isWeb(req) ? 'lu à la source' : 'flux relayé'}`);
  res.MediaSources = [source];
  return res;
}

// ---- Flux (routes publiques : le jeton de session est impossible a deviner) ----------------

function sessionFor(req) {
  const q = lq(req);
  const sess = relay.session(q.ls);
  if (!sess || sess.channel !== ids.norm(req.params.id)) return null;
  const r = store.channel(sess.channel);
  const src = r && sources.byId(r.source);
  return r && src ? { sess, r, src, internal: q.relay === '1' && /^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/.test(req.socket.remoteAddress || '') } : null;
}

async function guard(res, fn) {
  try {
    await fn();
  } catch (e) {
    log(`flux : ${e.message}`);
    if (!res.headersSent) res.status(e instanceof relay.LimitError ? 503 : 502).send(e.message);
    else res.destroy();
  }
}

function publicRoutes(router) {
  router.get('/Videos/:id/live/stream.ts', (req, res) =>
    guard(res, async () => {
      const x = sessionFor(req);
      if (!x) return res.status(404).end();
      // Mode "none" : l'app lit la chaine a la source (ses identifiants passent par l'app).
      if (x.sess.mode === 'none' && !x.internal) return res.redirect(302, x.r.url);
      await relay.serveTs(req, res, x.sess, x.r, x.src);
    })
  );
  router.get('/Videos/:id/live/index.m3u8', (req, res) =>
    guard(res, async () => {
      const x = sessionFor(req);
      if (!x) return res.status(404).end();
      if (x.sess.mode === 'none' && !x.internal) return res.redirect(302, x.r.url);
      await relay.servePlaylist(req, res, x.sess, x.r, x.src, x.r.url, `/Videos/${x.r.uuid}/live`);
    })
  );
  router.get('/Videos/:id/live/p/:rid.m3u8', (req, res) =>
    guard(res, async () => {
      const x = sessionFor(req);
      if (!x) return res.status(404).end();
      await relay.servePlaylistById(req, res, x.sess, x.r, x.src, req.params.rid, `/Videos/${x.r.uuid}/live`);
    })
  );
  router.get('/Videos/:id/live/f/:rid.:ext', (req, res) =>
    guard(res, async () => {
      const x = sessionFor(req);
      if (!x) return res.status(404).end();
      await relay.serveHidden(req, res, x.sess, x.r, x.src, req.params.rid);
    })
  );
}

// ---- Routes /LiveTv (authentifiees) ---------------------------------------------------------

function routes(router) {
  router.get('/LiveTv/Info', (req, res) => {
    const on = hasChannels(req.profile);
    res.json({ Services: [{ Name: 'Stremfin', Status: 'Ok', HasUpdateAvailable: false, IsVisible: true, Tuners: [] }], IsEnabled: true, EnabledUsers: on ? [req.profile.id] : [] });
  });
  router.get('/LiveTv/GuideInfo', (req, res) => {
    const now = Date.now();
    res.json({ StartDate: new Date(now - 7 * 864e5).toISOString(), EndDate: new Date(now + 8 * 864e5).toISOString() });
  });
  router.get('/LiveTv/Channels', (req, res) => {
    const q = lq(req);
    const start = int(q.startindex, 0);
    const limit = int(q.limit, 0);
    const out = channelsOf(req.profile, { start, limit, favorites: bool(q.isfavorite), current: q.addcurrentprogram !== 'false' });
    res.json(dto.queryResult(out.items, out.total, start));
  });
  router.get('/LiveTv/Channels/:id', (req, res) => {
    const e = ids.get(req.params.id);
    const d = e?.kind === 'channel' && channelFromEntry(req.profile, e);
    d ? res.json(d) : res.status(404).end();
  });
  // Guide des programmes.
  const list = (recommended) => (req, res) => {
    const out = programsList(req.profile, programQuery(req), { recommended });
    res.json(dto.queryResult(out.items, out.total, out.start));
  };
  router.get('/LiveTv/Programs', list(false));
  router.post('/LiveTv/Programs', list(false));
  router.get('/LiveTv/Programs/Recommended', list(true));
  router.get('/LiveTv/Programs/:id', (req, res) => {
    const d = itemFor(req.profile, req.params.id);
    d ? res.json(d) : res.status(404).end();
  });
  // Enregistrements.
  timerRoutes(router);
  router.get('/LiveTv/ChannelMappingOptions', (req, res) => res.json({ TunerChannels: [], ProviderChannels: [], Mappings: [], ProviderName: '' }));
  router.get(['/LiveTv/ListingProviders', '/LiveTv/TunerHosts', '/LiveTv/TunerHosts/Types'], (req, res) => res.json([]));
}

/** Image d'un dossier ou programme du replay. */
function replayImage(entry) {
  if (entry.kind === 'replaychan') return store.channel(entry.data.chan)?.logo || entry.data.logo || null;
  return entry.data.icon || entry.data.logo || null;
}

/** Image d'une chaine (logo) : adresse du logo. */
function imageUrl(entry) {
  const r = store.channel(entry.uuid);
  return r?.logo || entry.data.logo || null;
}

module.exports = { streamsOf, run, recordingFromEntry, recordingPlaybackInfo, recordingDto, timerDto, replayViewDto, replayFolderDto, replayEntryDto, replayChildren, replayPlaybackInfo, replayImage, routes, publicRoutes, viewDto, channelDto, channelFromEntry, channelsOf, playbackInfo, hasChannels, forget, imageUrl, viewUuid, itemFor, programImage, programByUuid, programDto, programsList };
