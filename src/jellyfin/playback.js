// Lecture : sources Stremio -> MediaSources Jellyfin, flux video, sous-titres, progression.
const crypto = require('crypto');
const ids = require('../ids');
const cache = require('../cache');
const config = require('../config');
const stremio = require('../stremio');
const tmdb = require('../tmdb');
const introdb = require('../introdb');
const { request, readAll } = require('../http');
const { st } = require('../db');
const dto = require('./dto');
const languages = require('../languages');
const noSourceClip = require('../noSource');

const SRC_TTL = 24 * 3600e3;

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function hash(s) {
  return crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 32);
}

const LANG = {
  fr: /\b(french|truefrench|vff|vfq|vfi|vf2|vf|multi)\b|🇫🇷/i,
  en: /\b(english|eng)\b|🇬🇧|🇺🇸/i,
  es: /\b(spanish|castellano|latino|esp)\b|🇪🇸|🇲🇽/i,
  de: /\b(german|deutsch|ger)\b|🇩🇪/i,
  it: /\b(italian|ita)\b|🇮🇹/i
};
// Codes ISO 639-2 utilises par les addons de sous-titres.
const SUB_LANG = { fr: ['fre', 'fra', 'fr'], en: ['eng', 'en'], es: ['spa', 'es'], de: ['ger', 'deu', 'de'], it: ['ita', 'it'] };

/**
 * Ce que l'app doit lire pour un element : type Stremio + ids equivalents, par preference
 * (tt d'abord : c'est l'id que comprennent presque tous les addons de sources).
 */
async function target(entry) {
  if (!entry) return null;
  if (entry.kind === 'movie') {
    let d = entry.data;
    if (!d.imdb && tmdb.enabled()) {
      // Film venu d'un catalogue TMDB, jamais ouvert : on recupere son id IMDb.
      const m = await tmdb.previewMeta('movie', d.sid).catch(() => null);
      if (m?.imdb_id) d = ids.get(ids.register(entry.key, entry.kind, { imdb: m.imdb_id, tmdb: m.moviedb_id })).data;
    }
    return { type: d.type || 'movie', ids: [d.imdb, d.tmdb && `tmdb:${d.tmdb}`, d.sid] };
  }
  if (entry.kind === 'episode') return { type: entry.data.type || 'series', ids: [entry.data.vid, entry.data.tmdbVid] };
  return null;
}

function runtimeOf(entry) {
  if (!entry) return undefined;
  if (entry.kind === 'episode') return dto.runtimeTicks(entry.data.runtime || ids.get(entry.data.seriesUuid)?.data.runtime);
  return dto.runtimeTicks(entry.data.runtime);
}

function playable(s) {
  const settings = config.get().settings;
  if (s.url && /^https?:\/\//i.test(s.url)) {
    return { url: s.url, headers: s.behaviorHints?.proxyHeaders?.request || null };
  }
  // Torrents : lisibles seulement via un serveur de streaming Stremio.
  if (s.infoHash && settings.torrentServer) {
    // Serveur de streaming souvent interne (reseau Docker) : toujours relaye par ce serveur.
    return { url: `${settings.torrentServer}/${String(s.infoHash).toLowerCase()}/${s.fileIdx ?? 0}`, headers: null, relay: true };
  }
  return null;
}

function textOf(s) {
  return [s.name, s.title, s.description, s.behaviorHints?.filename].filter(Boolean).join(' ');
}

function sizeOf(s) {
  if (Number(s.behaviorHints?.videoSize) > 0) return Number(s.behaviorHints.videoSize);
  // "12.5 GB" ou, chez les addons francais, "59,0 Go".
  const m = textOf(s).match(/(\d+(?:[.,]\d+)?)\s*(TB|GB|MB|To|Go|Mo)\b/i);
  if (!m) return undefined;
  const n = parseFloat(m[1].replace(',', '.'));
  const unit = m[2].toUpperCase().replace('O', 'B');
  return Math.round(n * { TB: 1e12, GB: 1e9, MB: 1e6 }[unit]);
}

/** Taille lisible a la francaise : "10,2 Go", "850 Mo". */
function sizeLabel(bytes) {
  if (!bytes) return '';
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1).replace('.', ',')} Go`;
  return `${Math.round(bytes / 1e6)} Mo`;
}

/**
 * Nom de la release : le nom du fichier donne par l'addon (sans extension), sinon une ligne
 * de la description qui ressemble a un nom de release (mots separes par des points).
 */
function releaseName(s) {
  const file = String(s.behaviorHints?.filename || '').trim();
  if (file) return file.replace(/\.(mkv|mp4|m4v|avi|ts|webm|mov)$/i, '');
  const lines = [s.title, s.description].filter(Boolean).join('\n').split('\n').map((l) => l.trim());
  return lines.find((l) => /^[\w-]+(\.[\w-]+){3,}$/.test(l)) || null;
}

/** Libelle d'une version : qualite · addon · taille · nom de la release (ou description de l'addon). */
function versionLabel(quality, src) {
  // Sans nom de release, le nom affiche est souvent celui de l'addon : pas deux fois.
  const release = src.release || (src.name !== src.addon ? src.name : null);
  return [quality, src.addon, sizeLabel(src.size), release].filter(Boolean).join(' · ');
}

function containerOf(s, url) {
  const name = s.behaviorHints?.filename || '';
  let path = '';
  try { path = new URL(url).pathname; } catch {}
  const ext = (name.match(/\.(\w{2,4})$/) || path.match(/\.(\w{2,4})$/) || [])[1]?.toLowerCase();
  if (ext === 'mp4' || ext === 'm4v' || ext === 'mov') return 'mp4';
  if (ext === 'webm') return 'webm';
  if (ext === 'avi') return 'avi';
  if (ext === 'ts') return 'ts';
  return 'mkv';
}

/** Deduit qualite / codecs du nom de la source (les addons ne donnent rien de plus). */
function guessStreams(text) {
  const t = text.toLowerCase();
  const height = /2160p|\b4k\b|\buhd\b/.test(t) ? 2160 : /1440p/.test(t) ? 1440 : /1080p/.test(t) ? 1080 : /720p/.test(t) ? 720 : /480p/.test(t) ? 480 : undefined;
  const vcodec = /\b(hevc|x265|h\.?265)\b/.test(t) ? 'hevc' : /\bav1\b/.test(t) ? 'av1' : 'h264';
  const range = /\b(dv|dovi)\b|dolby ?vision/.test(t) ? 'DOVI' : /hdr10\+|hdr10plus/.test(t) ? 'HDR10Plus' : /\bhdr(10)?\b/.test(t) ? 'HDR10' : 'SDR';
  const acodec = /truehd|atmos/.test(t) ? 'truehd' : /\bddp|\be-?ac-?3|dd\+/.test(t) ? 'eac3' : /\bdts/.test(t) ? 'dts' : /\bac-?3|\bdd5|\bdd\b/.test(t) ? 'ac3' : 'aac';
  const channels = /7\.1/.test(t) ? 8 : /5\.1/.test(t) ? 6 : 2;
  const video = {
    Codec: vcodec,
    Type: 'Video',
    Index: 0,
    IsDefault: true,
    IsForced: false,
    IsHearingImpaired: false,
    IsInterlaced: false,
    IsExternal: false,
    IsTextSubtitleStream: false,
    SupportsExternalStream: false,
    IsAVC: vcodec === 'h264',
    VideoRange: range === 'SDR' ? 'SDR' : 'HDR',
    VideoRangeType: range,
    Level: 0,
    DisplayTitle: [height ? (height === 2160 ? '4K' : `${height}p`) : null, vcodec.toUpperCase(), range !== 'SDR' ? range : null].filter(Boolean).join(' ')
  };
  if (height) {
    video.Height = height;
    video.Width = Math.round((height * 16) / 9);
  }
  const audio = {
    Codec: acodec,
    Type: 'Audio',
    Index: 1,
    Channels: channels,
    ChannelLayout: channels === 8 ? '7.1' : channels === 6 ? '5.1' : 'stereo',
    IsDefault: true,
    IsForced: false,
    IsHearingImpaired: false,
    IsInterlaced: false,
    IsExternal: false,
    IsTextSubtitleStream: false,
    SupportsExternalStream: false,
    Level: 0,
    DisplayTitle: `${acodec.toUpperCase()} ${channels === 8 ? '7.1' : channels === 6 ? '5.1' : '2.0'}`
  };
  return [video, audio];
}

function displayName(addon, s) {
  const first = (x) => String(x || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const name = first(s.name).join(' ') || addon;
  const detail = first(s.title || s.description).join(' · ');
  const out = detail ? `${name} · ${detail}` : name;
  return out.length > 140 ? out.slice(0, 137) + '…' : out;
}

// Recherches de sources en cours ou recentes, par profil, element et addons actifs : la fiche,
// son prechargement et la lecture partagent une seule recherche aupres des addons. Activer,
// couper ou changer un addon change la cle : la recherche suivante repart de zero.
const SOURCES_MEMO = 2 * 60e3;
// Aucune source : resultat garde peu de temps (addon lent ou en panne a ce moment-la).
const EMPTY_MEMO = 20e3;
const searches = new Map();

function searchKey(profile, uuid) {
  const addons = stremio.enabledAddons(profile).map((a) => `${a.lib || a.url}:${a.mode || ''}`).join(',');
  return `${profile.id}|${uuid}|${hash(addons)}`;
}
const fresh = (r) => r.pending || Date.now() - r.at < (r.count ? SOURCES_MEMO : EMPTY_MEMO);

/**
 * Sources lisibles pour un film/episode, triees (langues preferees d'abord).
 * Chaque source recoit un id stable, memorise pour la route /stream.
 */
function sourcesFor(profile, uuid) {
  const key = searchKey(profile, uuid);
  const known = searches.get(key);
  if (known && fresh(known)) return known.promise;
  const rec = { pending: true, at: 0, count: null, promise: findSources(profile, uuid) };
  searches.set(key, rec);
  rec.promise.then(
    (list) => Object.assign(rec, { pending: false, at: Date.now(), count: list.length }),
    () => searches.delete(key)
  );
  for (const [k, r] of searches) if (!fresh(r)) searches.delete(k);
  return rec.promise;
}

/** Une recherche recente (avec les addons actuels) n'a trouve aucune source pour cet element ? */
function knownEmpty(profile, uuid) {
  const r = searches.get(searchKey(profile, uuid));
  return !!r && !r.pending && r.count === 0 && fresh(r);
}

async function findSources(profile, uuid) {
  const entry = ids.get(uuid);
  const tg = await target(entry);
  if (!tg) return [];
  const raw = await stremio.streams(profile, tg.type, tg.ids);
  const langs = (profile.preferredLanguages || []).map((l) => LANG[l]).filter(Boolean);
  const score = (text) => {
    const i = langs.findIndex((re) => re.test(text));
    return i === -1 ? langs.length : i;
  };
  const list = [];
  const seen = new Set();
  raw.forEach(({ addon, addonLogo, mode, stream }, order) => {
    const p = playable(stream);
    if (!p || seen.has(p.url)) return;
    seen.add(p.url);
    const id = hash(`${uuid}|${p.url}`);
    const text = textOf(stream);
    const src = {
      id,
      uuid: entry.uuid,
      url: p.url,
      headers: p.headers,
      name: displayName(addon, stream),
      // Addon d'origine (panneau "Lecture en cours").
      addon,
      addonLogo,
      // Mode de connexion de l'addon sur ce profil (lecture a la source, IP du serveur ou proxy externe).
      mode,
      relay: !!p.relay,
      container: containerOf(stream, p.url),
      size: sizeOf(stream),
      release: releaseName(stream),
      text,
      order,
      score: score(text),
      bucket: bucketOf(text)
    };
    cache.put('src|' + id, src, SRC_TTL);
    list.push(src);
  });
  return list.sort((a, b) => a.score - b.score || a.order - b.order);
}

async function subtitlesFor(profile, uuid) {
  const tg = await target(ids.get(uuid));
  if (!tg) return [];
  // Langues prioritaires, anglais, et la langue de sous-titres choisie (reglages de l'app).
  const chosen = profile.playback?.subtitleLanguage;
  const wanted = new Set((profile.preferredLanguages || []).concat('en', chosen ? [chosen] : []).flatMap((l) => languages.variants(l)));
  const subs = await stremio.subtitles(profile, tg.type, tg.ids);
  // Langues du profil d'abord, dans son ordre de preference.
  const rank = (lang) => {
    const i = (profile.preferredLanguages || []).findIndex((l) => (SUB_LANG[l] || [l]).includes(String(lang || '').toLowerCase()));
    return i === -1 ? 99 : i;
  };
  return subs
    .filter(({ sub }) => sub?.url && (!sub.lang || wanted.has(String(sub.lang).toLowerCase())))
    .sort((a, b) => rank(a.sub.lang) - rank(b.sub.lang))
    .slice(0, 30);
}

// ---- Qualites -----------------------------------------------------------------
// Mode "qualites" : l'app propose 3 "versions" (4K, 1080p, 720p), chacune lance la meilleure
// source de cette qualite, ou a defaut la plus proche disponible.
// Mode "releases" : jusqu'a 5 releases par qualite, chacune etant une "version" a part.

const QUALITIES = [
  { key: '2160', name: '4K' },
  { key: '1080', name: '1080p' },
  { key: '720', name: '720p' }
];
const QUALITY_NAME = { 2160: '4K', 1080: '1080p', 720: '720p', 480: 'SD', unknown: '?' };
const FALLBACK = {
  2160: ['2160', '1080', '720', '480', 'unknown'],
  1080: ['1080', '720', '2160', '480', 'unknown'],
  720: ['720', '1080', '480', '2160', 'unknown']
};

function bucketOf(text) {
  const h = guessStreams(text)[0].Height;
  if (!h) return 'unknown';
  if (h >= 1440) return '2160';
  if (h >= 1080) return '1080';
  if (h >= 720) return '720';
  return '480';
}

/**
 * Id d'une "version". Il est enregistre comme un element a part entiere : le client web
 * demande /Items/{id de la version} avant de lancer la lecture.
 */
function qualityId(itemUuid, q) {
  return ids.register(`quality|${itemUuid}|${q}`, 'quality', { itemUuid, q });
}

/** Id d'une release precise (mode "releases") : meme principe, avec la source visee. */
function releaseId(itemUuid, q, src) {
  return ids.register(`quality|${itemUuid}|${q}|${src.id}`, 'quality', { itemUuid, q, src: src.id });
}

/** Source visee par une "version" de type release, ou null. */
function releaseOf(itemUuid, mediaSourceId) {
  const e = ids.get(mediaSourceId);
  return e?.kind === 'quality' && e.data.itemUuid === itemUuid ? e.data.src || null : null;
}

/** Qualite demandee par l'app via l'id de "version", ou null. */
function qualityOf(itemUuid, mediaSourceId) {
  const e = ids.get(mediaSourceId);
  return e?.kind === 'quality' && e.data.itemUuid === itemUuid ? e.data.q : null;
}

/** Une "version" designe son film/episode : on remonte a celui-ci. */
function unwrap(id) {
  const e = ids.get(id);
  return e?.kind === 'quality' ? { entry: ids.get(e.data.itemUuid), q: e.data.q } : { entry: e, q: null };
}

/**
 * Meilleure source pour une qualite. Les langues preferees passent avant la qualite :
 * une VF en 1080p est preferee a une VO en 4K.
 */
function pickSource(sources, q) {
  if (!sources.length) return null;
  const best = Math.min(...sources.map((s) => s.score));
  const pool = sources.filter((s) => s.score === best);
  for (const b of FALLBACK[q] || FALLBACK[1080]) {
    const hit = pool.find((s) => s.bucket === b);
    if (hit) return hit;
  }
  return pool[0];
}

function defaultQuality(profile) {
  return FALLBACK[profile.defaultQuality] ? profile.defaultQuality : '1080';
}

const RELEASES_PER_QUALITY = 5;
// Une fiche n'attend pas les addons plus longtemps : au-dela, elle affiche les 3 qualites
// (la recherche continue et sert a la prochaine ouverture, les reponses etant en cache).
const RELEASES_WAIT = 8000;

/** Qualites dans l'ordre d'affichage (qualite par defaut du profil en premier). */
function orderedQualities(profile) {
  const def = defaultQuality(profile);
  return [...QUALITIES].sort((a, b) => (a.key === def ? -1 : b.key === def ? 1 : 0));
}

// Une fiche en mode "3 qualites" attend les addons au plus 4 s pour savoir s'il y a des sources.
const QUALITY_WAIT = 4000;

// Selecteur de version quand aucun addon ne fournit la video (langue des libelles du serveur).
// Deux lignes : les apps n'affichent le selecteur qu'a partir de deux versions.
const NO_SOURCE = {
  fr: ['😕 Aucune source disponible', '🔄 Réessaie un peu plus tard'],
  en: ['😕 No source available', '🔄 Try again a bit later'],
  es: ['😕 Ninguna fuente disponible', '🔄 Vuelve a intentarlo más tarde'],
  de: ['😕 Keine Quelle verfügbar', '🔄 Versuche es etwas später erneut'],
  it: ['😕 Nessuna fonte disponibile', '🔄 Riprova un po’ più tardi']
};
function noSource(itemUuid, profile) {
  const lines = NO_SOURCE[config.get().settings.language] || NO_SOURCE.fr;
  // Ids de l'element : si des sources apparaissent entre-temps, la lecture les trouve.
  return lines.map((name, i) => ({ ...placeholderSource(itemUuid), Id: i ? qualityId(itemUuid, defaultQuality(profile)) : itemUuid, Name: name }));
}

/** Les 3 versions affichees sur la fiche (qualite par defaut du profil en premier). */
function qualitySources(profile, itemUuid) {
  if (knownEmpty(profile, itemUuid)) return noSource(itemUuid, profile);
  return orderedQualities(profile).map((q) => ({ ...placeholderSource(itemUuid), Id: qualityId(itemUuid, q.key), Name: q.name }));
}

/**
 * Les 5 meilleures releases de chaque qualite (langues preferees, puis ordre des addons).
 * Un meme fichier propose par plusieurs addons n'apparait qu'une fois.
 */
function topReleases(profile, sources) {
  const seen = new Set();
  const unique = sources.filter((s) => {
    if (!s.release) return true;
    const key = `${s.release.toLowerCase()}|${sizeLabel(s.size)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return orderedQualities(profile).flatMap((q) =>
    unique.filter((s) => s.bucket === q.key).slice(0, RELEASES_PER_QUALITY).map((src) => ({ q: q.key, src }))
  );
}

/**
 * Versions d'une fiche selon le profil : 3 qualites, ou les releases trouvees par les
 * addons (mode "releases"). Sans release a temps, on revient aux 3 qualites.
 */
async function versionSources(profile, itemUuid) {
  const releases = profile.versionMode === 'releases';
  // null = addons trop lents (la recherche continue en arriere-plan).
  const timeout = new Promise((r) => setTimeout(() => r(null), releases ? RELEASES_WAIT : QUALITY_WAIT));
  const sources = await Promise.race([sourcesFor(profile, itemUuid).catch(() => null), timeout]);
  if (sources && !sources.length) return noSource(itemUuid, profile);
  if (!releases) return qualitySources(profile, itemUuid);
  const top = sources ? topReleases(profile, sources) : [];
  if (!top.length) return qualitySources(profile, itemUuid);
  return top.map(({ q, src }) => ({
    ...placeholderSource(itemUuid),
    Id: releaseId(itemUuid, q, src),
    Name: versionLabel(QUALITY_NAME[q], src),
    Container: src.container,
    Size: src.size
  }));
}

// ---- Pistes reelles du fichier -------------------------------------------------
// Les apps ne proposent que les pistes annoncees par le serveur : on lit l'en-tete du fichier
// (Matroska) pour annoncer toutes ses pistes audio et ses sous-titres integres.

// Codes de langue ISO 639-2 "bibliographiques" (Matroska) -> code a 2 lettres.
const LANG2 = { fre: 'fr', fra: 'fr', eng: 'en', spa: 'es', ger: 'de', deu: 'de', ita: 'it', por: 'pt', dut: 'nl', nld: 'nl', jpn: 'ja', chi: 'zh', zho: 'zh', kor: 'ko', rus: 'ru', ara: 'ar', pol: 'pl', swe: 'sv', dan: 'da', nor: 'no', fin: 'fi', tur: 'tr', gre: 'el', ell: 'el', heb: 'he', hin: 'hi', cze: 'cs', ces: 'cs', hun: 'hu', rum: 'ro', ron: 'ro', ukr: 'uk', tha: 'th', vie: 'vi', ind: 'id', may: 'ms', msa: 'ms', per: 'fa', fas: 'fa', cat: 'ca', bul: 'bg', hrv: 'hr', srp: 'sr', slo: 'sk', slk: 'sk', slv: 'sl', ice: 'is', isl: 'is', est: 'et', lav: 'lv', lit: 'lt', baq: 'eu', eus: 'eu', glg: 'gl', wel: 'cy', cym: 'cy' };
const CODEC = {
  'V_MPEGH/ISO/HEVC': 'hevc', 'V_MPEG4/ISO/AVC': 'h264', V_AV1: 'av1', V_VP9: 'vp9', V_VP8: 'vp8', 'V_MPEG2': 'mpeg2video',
  A_AAC: 'aac', A_AC3: 'ac3', A_EAC3: 'eac3', A_DTS: 'dts', A_TRUEHD: 'truehd', A_OPUS: 'opus', A_FLAC: 'flac', A_VORBIS: 'vorbis', 'A_MPEG/L3': 'mp3', 'A_PCM/INT/LIT': 'pcm_s16le',
  'S_TEXT/UTF8': 'subrip', 'S_TEXT/ASS': 'ass', 'S_TEXT/SSA': 'ssa', 'S_TEXT/WEBVTT': 'webvtt', 'S_HDMV/PGS': 'PGSSUB', S_VOBSUB: 'dvdsub', 'S_DVBSUB': 'dvbsub'
};
const TEXT_SUBS = new Set(['subrip', 'ass', 'ssa', 'webvtt']);

function codecOf(codecId) {
  const id = String(codecId || '');
  return CODEC[id] || CODEC[Object.keys(CODEC).find((k) => id.startsWith(k + '/'))] || id.replace(/^[VAS]_/, '').toLowerCase();
}

/** Nom de la langue dans la langue des libelles du serveur ("Français", "Anglais"...). */
function langName(code) {
  const c = String(code || '').toLowerCase();
  if (!c || c === 'und' || c === 'zxx') return null;
  const two = LANG2[c] || c.split('-')[0];
  try {
    const name = new Intl.DisplayNames([config.get().settings.language || 'fr'], { type: 'language' }).of(two);
    return name && name !== two ? name[0].toUpperCase() + name.slice(1) : c;
  } catch {
    return c;
  }
}

/** Pistes du fichier d'une source (en cache 24 h), ou null si illisibles. */
async function tracksOf(src) {
  if (!['mkv', 'webm'].includes(src.container) || src.relay) return null;
  const key = 'probe|' + hash(src.url);
  const hit = cache.peek(key);
  if (hit) return hit.v.tracks;
  const settings = config.get().settings;
  const mode = src.mode || settings.addonMode;
  let tracks = null;
  const t0 = Date.now();
  const opts = { headers: src.headers || undefined, upstream: mode === 'warp' ? settings.upstream : undefined };
  // Un lien de debrideur peut repondre 404 / 5xx le temps de preparer le fichier : 2e essai 2 s apres.
  for (let attempt = 1; attempt <= 2 && !tracks; attempt++) {
    try {
      tracks = await require('../probe').mkvTracks(src.url, opts);
    } catch (e) {
      const retry = attempt === 1 && /reponse (404|5\d\d)/.test(e.message);
      log(`[probe] ${hostOf(src.url)} : ${e.message}${retry ? ', nouvel essai' : ''}`);
      if (!retry) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  if (tracks) log(`[probe] ${tracks.filter((t) => t.type === 'audio').length} audio, ${tracks.filter((t) => t.type === 'subtitle').length} sous-titre(s) en ${Date.now() - t0} ms`);
  else log(`[probe] ${hostOf(src.url)} : pistes non trouvees (${Date.now() - t0} ms)`);
  // Echec (lien pas encore pret...) : nouvel essai a la lecture suivante.
  cache.put(key, { tracks }, tracks ? 24 * 3600e3 : 60e3);
  return tracks;
}

/** Pistes du fichier au format Jellyfin (Index = ordre dans le fichier, comme ffprobe). */
function fileStreams(tracks, text) {
  const guess = guessStreams(text);
  return tracks.map((t, index) => {
    const codec = codecOf(t.codecId);
    const lang = t.language && t.language !== 'und' ? t.language : undefined;
    const name = langName(t.languageIetf || t.language);
    const common = {
      Codec: codec,
      Language: lang,
      Title: t.name || undefined,
      Index: index,
      IsDefault: !!t.default,
      IsForced: !!t.forced,
      IsHearingImpaired: !!t.hearingImpaired,
      IsInterlaced: false,
      IsExternal: false,
      Level: 0
    };
    if (t.type === 'video') {
      // Plage dynamique (HDR, Dolby Vision) : deduite du nom de la release.
      return { ...guess[0], ...common, Type: 'Video', Width: t.width || guess[0].Width, Height: t.height || guess[0].Height, IsAVC: codec === 'h264' };
    }
    if (t.type === 'audio') {
      const ch = t.channels || 2;
      const layout = ch >= 8 ? '7.1' : ch >= 6 ? '5.1' : ch === 1 ? 'mono' : 'stereo';
      const detail = t.name || `${codec.toUpperCase()} ${layout}`;
      return { ...common, Type: 'Audio', Channels: ch, ChannelLayout: layout, IsTextSubtitleStream: false, SupportsExternalStream: false, DisplayTitle: name ? `${name} · ${detail}` : detail };
    }
    const forced = t.forced ? ' (forcé)' : '';
    const detail = t.name || codec.toUpperCase();
    return {
      ...common,
      Type: 'Subtitle',
      IsTextSubtitleStream: TEXT_SUBS.has(codec),
      SupportsExternalStream: false,
      DeliveryMethod: 'Embed',
      DisplayTitle: `${name || '?'}${forced} · ${detail}`
    };
  });
}

const playbackPrefs = (profile) => ({ ...config.PLAYBACK, ...(profile?.playback || {}) });
const sameLang = (stream, code) => !!code && languages.variants(code).includes(String(stream.Language || '').toLowerCase());

/**
 * Piste audio par defaut : celle marquee "par defaut" dans le fichier si le profil le demande,
 * sinon la langue audio choisie (reglages de l'app ou de Stremfin), puis les langues prioritaires.
 */
function defaultAudio(streams, profile) {
  const audio = streams.filter((s) => s.Type === 'Audio');
  const pb = playbackPrefs(profile);
  if (pb.playDefaultAudioTrack) return audio.find((s) => s.IsDefault) || audio[0];
  for (const l of [pb.audioLanguage, ...(profile?.preferredLanguages || [])].filter(Boolean)) {
    const hit = audio.find((s) => sameLang(s, l));
    if (hit) return hit;
  }
  return audio.find((s) => s.IsDefault) || audio[0];
}

/**
 * Sous-titres actives au lancement, selon le mode choisi (memes regles que Jellyfin) :
 * Default = pistes "forcees" ou "par defaut" du fichier ; Always = toujours dans la langue choisie ;
 * OnlyForced = seulement les "forcees" ; Smart = si l'audio n'est pas dans la langue choisie ;
 * None = jamais. Langue des sous-titres : celle choisie, sinon la premiere langue prioritaire.
 */
function defaultSubtitle(streams, profile, audio) {
  const pb = playbackPrefs(profile);
  if (pb.subtitleMode === 'None') return null;
  const subs = streams.filter((s) => s.Type === 'Subtitle');
  const lang = pb.subtitleLanguage || (profile?.preferredLanguages || [])[0] || '';
  const inLang = subs.filter((s) => sameLang(s, lang));
  const full = inLang.find((s) => !s.IsForced) || inLang[0];
  const forced = subs.find((s) => s.IsForced && (sameLang(s, lang) || (audio?.Language && s.Language === audio.Language)));
  switch (pb.subtitleMode) {
    case 'Always':
      return full || null;
    case 'OnlyForced':
      return forced || null;
    case 'Smart':
      return audio?.Language && !sameLang(audio, lang) ? full || null : forced || null;
    default:
      return forced || subs.find((s) => s.IsDefault && !s.IsExternal && (!lang || sameLang(s, lang))) || null;
  }
}

function mediaSource(itemUuid, src, token, subs, opts = {}) {
  const ticks = runtimeOf(ids.get(itemUuid));
  const streams = opts.tracks?.length ? fileStreams(opts.tracks, src.text) : guessStreams(src.text);
  const msid = opts.id || src.id;
  const audio = defaultAudio(streams, opts.profile);
  const first = streams.length;
  subs.forEach(({ addon, sub }, i) => {
    const index = first + i;
    cache.put(`sub|${msid}|${index}`, { url: sub.url }, SRC_TTL);
    streams.push({
      Codec: 'srt',
      Language: sub.lang,
      DisplayTitle: `${langName(sub.lang) || '?'} · ${addon}`,
      Title: addon,
      Type: 'Subtitle',
      Index: index,
      IsDefault: false,
      IsForced: false,
      IsHearingImpaired: false,
      IsInterlaced: false,
      IsExternal: true,
      IsTextSubtitleStream: true,
      SupportsExternalStream: true,
      DeliveryMethod: 'External',
      DeliveryUrl: `/Videos/${itemUuid}/${msid}/Subtitles/${index}/0/Stream.srt?api_key=${token}`,
      Level: 0
    });
  });
  const subtitle = defaultSubtitle(streams, opts.profile, audio);
  return {
    Protocol: 'File',
    Id: msid,
    Path: `${msid}.${src.container}`,
    Type: 'Default',
    Container: src.container,
    Size: src.size,
    Name: opts.name || src.name,
    IsRemote: false,
    ETag: msid,
    RunTimeTicks: ticks,
    ReadAtNativeFramerate: false,
    IgnoreDts: false,
    IgnoreIndex: false,
    GenPtsInput: false,
    SupportsTranscoding: false,
    SupportsDirectStream: true,
    SupportsDirectPlay: true,
    IsInfiniteStream: false,
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
    DefaultAudioStreamIndex: audio ? audio.Index : 1,
    DefaultSubtitleStreamIndex: subtitle ? subtitle.Index : -1,
    // Indispensable pour que les apps demandent /MediaSegments (boutons "Passer l'intro").
    HasSegments: !!config.get().settings.introSkip,
    DirectStreamUrl: `/Videos/${itemUuid}/stream.${src.container}?static=true&mediaSourceId=${msid}&api_key=${token}`
  };
}

/** Source factice pour les listes (Fields=MediaSources) : les vraies arrivent via PlaybackInfo. */
function placeholderSource(itemUuid) {
  return {
    Protocol: 'File',
    Id: itemUuid,
    Type: 'Default',
    Container: 'mkv',
    Name: 'Auto',
    IsRemote: false,
    SupportsTranscoding: false,
    SupportsDirectStream: true,
    SupportsDirectPlay: true,
    IsInfiniteStream: false,
    RequiresOpening: false,
    RequiresClosing: false,
    RequiresLooping: false,
    SupportsProbing: false,
    ReadAtNativeFramerate: false,
    IgnoreDts: false,
    IgnoreIndex: false,
    GenPtsInput: false,
    UseMostCompatibleTranscodingProfile: false,
    MediaStreams: [],
    MediaAttachments: [],
    Formats: [],
    RequiredHttpHeaders: {},
    TranscodingSubProtocol: 'http',
    HasSegments: !!config.get().settings.introSkip
  };
}

async function playbackInfo(profile, token, itemId, mediaSourceId) {
  const { entry, q: fromItem } = unwrap(itemId);
  if (!entry) {
    log(`[play] PlaybackInfo pour un element inconnu : ${itemId}`);
    return { MediaSources: [], PlaySessionId: '', ErrorCode: 'NoCompatibleStream' };
  }
  if (fromItem && !mediaSourceId) mediaSourceId = qualityId(entry.uuid, fromItem);
  const t0 = Date.now();
  const [sources, subs] = await Promise.all([
    sourcesFor(profile, entry.uuid),
    subtitlesFor(profile, entry.uuid).catch(() => [])
  ]);
  const res = { MediaSources: [], PlaySessionId: crypto.randomBytes(16).toString('hex') };

  // Une source precise (deja connue) : on la rejoue telle quelle.
  const exact = sources.find((s) => s.id === ids.norm(mediaSourceId));
  // Une release choisie dans la liste (mode "releases"), si l'addon la propose toujours.
  const wanted = releaseOf(entry.uuid, mediaSourceId);
  const release = wanted && sources.find((s) => s.id === wanted);
  if (exact) {
    res.MediaSources = [mediaSource(entry.uuid, exact, token, subs, { profile, tracks: await tracksOf(exact) })];
  } else if (release) {
    const id = ids.norm(mediaSourceId);
    cache.put('src|' + id, release, SRC_TTL);
    res.MediaSources = [mediaSource(entry.uuid, release, token, subs, { id, name: versionLabel(QUALITY_NAME[release.bucket], release), profile, tracks: await tracksOf(release) })];
    log(`[play] ${entry.data.name || entry.data.vid} : release choisie ${QUALITY_NAME[release.bucket]} (${Date.now() - t0} ms)`);
  } else {
    // Sinon : la version choisie (4K/1080p/720p) ou la qualite par defaut du profil.
    const q = qualityOf(entry.uuid, mediaSourceId) || defaultQuality(profile);
    const src = pickSource(sources, q);
    if (src) {
      const id = qualityId(entry.uuid, q);
      cache.put('src|' + id, src, SRC_TTL);
      const label = src.bucket === q ? QUALITY_NAME[q] : `${QUALITY_NAME[q]} → ${QUALITY_NAME[src.bucket]}`;
      res.MediaSources = [mediaSource(entry.uuid, src, token, subs, { id, name: versionLabel(label, src), profile, tracks: await tracksOf(src) })];
      log(`[play] ${entry.data.name || entry.data.vid} : ${sources.length} source(s), qualite ${QUALITY_NAME[q]} -> ${QUALITY_NAME[src.bucket]} (${Date.now() - t0} ms)`);
    }
  }
  if (!res.MediaSources.length && noSourceClip.enabled()) {
    // Aucune source : le clip "aucune source disponible" (Reglages -> Lecture et reseau).
    const lines = NO_SOURCE[config.get().settings.language] || NO_SOURCE.fr;
    res.MediaSources = [noSourceClip.mediaSource(entry.uuid, token, lines[0])];
    clipSessions.set(res.PlaySessionId, Date.now());
    log(`[play] ${entry.data.name || entry.data.vid} : aucune source lisible, clip "aucune source" lance`);
  } else if (!res.MediaSources.length) {
    res.ErrorCode = 'NoCompatibleStream';
    log(`[play] ${entry.data.name || entry.data.vid} : aucune source lisible`);
  }
  return res;
}

// ---- Intro / generique -------------------------------------------------------------

/** Segments Jellyfin (MediaSegmentDto) d'un film ou episode, d'apres TheIntroDB. */
async function mediaSegments(itemId, types) {
  const { entry } = unwrap(itemId);
  if (!entry || !config.get().settings.introSkip) return [];
  let q;
  if (entry.kind === 'movie') {
    const d = entry.data;
    q = { tmdb: d.tmdb, imdb: d.imdb || (/^tt\d+$/.test(d.sid) ? d.sid : undefined) };
  } else if (entry.kind === 'episode') {
    const s = ids.get(entry.data.seriesUuid)?.data || {};
    q = { tmdb: s.tmdb, imdb: s.imdb || (/^tt\d+$/.test(s.sid) ? s.sid : undefined), season: entry.data.season, episode: entry.data.episode };
  } else {
    return [];
  }
  let segs = [];
  try {
    segs = await introdb.segments(q);
  } catch (e) {
    log(`[introdb] ${entry.data.name || entry.data.vid}: ${e.message}`);
  }
  const runtime = runtimeOf(entry);
  return segs
    .filter((s) => !types || types.includes(s.type))
    .map((s, i) => {
      const start = s.startMs * 1e4;
      // Generique "jusqu'a la fin" : on s'arrete a la duree connue (sinon +10 min).
      const end = s.endMs !== null ? s.endMs * 1e4 : runtime > start ? runtime : start + 600 * 1e7;
      return { Id: hash(`${entry.uuid}|seg|${s.type}|${i}`), ItemId: entry.uuid, Type: s.type, StartTicks: start, EndTicks: end };
    });
}

/**
 * Apps Emby : pas de media segments, mais des marqueurs dans les chapitres de l'element
 * (IntroStart / IntroEnd / CreditsStart). On ne fait pas attendre la fiche plus de 2 s.
 */
async function embyChapters(itemId, maxWait = 2000) {
  const timeout = new Promise((r) => setTimeout(() => r([]), maxWait));
  const segs = await Promise.race([mediaSegments(itemId).catch(() => []), timeout]);
  const marks = [];
  for (const s of segs) {
    if (s.Type === 'Intro') {
      marks.push({ StartPositionTicks: s.StartTicks, Name: 'Intro', MarkerType: 'IntroStart' });
      marks.push({ StartPositionTicks: s.EndTicks, Name: 'Fin de l\'intro', MarkerType: 'IntroEnd' });
    } else if (s.Type === 'Outro') {
      marks.push({ StartPositionTicks: s.StartTicks, Name: 'Générique de fin', MarkerType: 'CreditsStart' });
    }
  }
  if (!marks.length) return [];
  if (!marks.some((m) => m.StartPositionTicks === 0)) marks.push({ StartPositionTicks: 0, Name: 'Début', MarkerType: 'Chapter' });
  return marks.sort((a, b) => a.StartPositionTicks - b.StartPositionTicks).map((m, i) => ({ ...m, ChapterIndex: i }));
}

// ---- Flux video ---------------------------------------------------------------

// Lectures du clip "aucune source" (PlaySessionId) : jamais comptees (progression, stats, suivi).
const clipSessions = new Map();
const isClipReport = (body) => noSourceClip.isClip(body?.MediaSourceId) || clipSessions.has(body?.PlaySessionId);
setInterval(() => {
  for (const [k, at] of clipSessions) if (Date.now() - at > 6 * 3600e3) clipSessions.delete(k);
}, 3600e3).unref();

async function resolveSource(req, itemId, mediaSourceId) {
  if (noSourceClip.isClip(mediaSourceId)) return { clip: true, ...noSourceClip.clip() };
  const hit = mediaSourceId && cache.peek('src|' + ids.norm(mediaSourceId));
  if (hit) return hit.v;
  // Version demandee sans passer par PlaybackInfo (certaines apps) : on choisit ici.
  if (!req.profile) return null;
  const { entry } = unwrap(itemId);
  if (!entry) return null;
  const sources = await sourcesFor(req.profile, entry.uuid);
  const wanted = releaseOf(entry.uuid, mediaSourceId);
  const release = wanted && sources.find((s) => s.id === wanted);
  const src = release || pickSource(sources, qualityOf(entry.uuid, mediaSourceId) || defaultQuality(req.profile));
  // Aucune source (lecture demandee sans PlaybackInfo) : le clip, s'il est active.
  return src || (noSourceClip.enabled() ? { clip: true, ...noSourceClip.clip() } : null);
}

async function pipe(req, res, src) {
  // Clip "aucune source" : fichier local (requetes partielles gerees par sendFile).
  if (src.clip) {
    res.type(src.container === 'mp4' ? 'video/mp4' : src.container === 'webm' ? 'video/webm' : 'video/x-matroska');
    return res.sendFile(src.file, { headers: { 'Cache-Control': 'no-store' } });
  }
  const settings = config.get().settings;
  const mode = src.mode || settings.addonMode;
  if (mode === 'none' && !src.headers && !src.relay) {
    log(`[play] redirection -> ${hostOf(src.url)}`);
    return res.redirect(302, src.url);
  }
  const headers = { ...(src.headers || {}) };
  if (req.headers.range) headers.range = req.headers.range;
  if (!headers['user-agent']) headers['user-agent'] = req.headers['user-agent'] || 'Mozilla/5.0';
  if (!headers.accept) headers.accept = '*/*';

  const { res: origin } = await request(src.url, {
    upstream: mode === 'warp' ? settings.upstream : undefined,
    headers,
    method: req.method === 'HEAD' ? 'HEAD' : 'GET',
    timeout: 30000,
    keepAlive: true
  });
  log(`[play] ${req.method} ${hostOf(src.url)} range=${req.headers.range || '-'} -> ${origin.statusCode}`);

  res.status(origin.statusCode || 502);
  const pass = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag'];
  for (const h of pass) if (origin.headers[h]) res.setHeader(h, origin.headers[h]);
  if (!origin.headers['accept-ranges']) res.setHeader('Accept-Ranges', 'bytes');
  const ct = String(origin.headers['content-type'] || '');
  if (!ct || ct.startsWith('application/octet-stream') || ct.startsWith('binary/')) {
    res.setHeader('Content-Type', src.container === 'mp4' ? 'video/mp4' : src.container === 'webm' ? 'video/webm' : 'video/x-matroska');
  }
  origin.on('error', () => res.destroy());
  req.on('close', () => origin.destroy());
  // Debit et volume transferes, pour le panneau "Lecture en cours" des statistiques.
  const stats = require('../stats');
  origin.on('data', (chunk) => stats.addBytes(src.uuid, req.profile?.id, chunk.length));
  origin.pipe(res);
}

function hostOf(url) {
  try { return new URL(url).host; } catch { return '?'; }
}

async function subtitle(req, res) {
  const { msid, index, ext } = req.params;
  const hit = cache.peek(`sub|${ids.norm(msid)}|${index}`);
  if (!hit) return res.status(404).end();
  try {
    const { res: r } = await request(hit.v.url, { upstream: config.get().settings.upstream, timeout: 15000 });
    let text = (await readAll(r)).toString('utf8').replace(/^\uFEFF/, '');
    if (String(ext).toLowerCase() === 'vtt' && !text.startsWith('WEBVTT')) {
      text = 'WEBVTT\n\n' + text.replace(/\r/g, '').replace(/(\d\d:\d\d:\d\d),(\d\d\d)/g, '$1.$2');
      res.type('text/vtt');
    } else {
      res.type('text/plain');
    }
    res.send(text);
  } catch (e) {
    res.status(502).send(e.message);
  }
}

// ---- Progression ------------------------------------------------------------

function saveUd(profile, uuid, row) {
  st.udPut.run(profile.id, uuid, Math.max(0, Math.round(row.position || 0)), row.played ? 1 : 0, row.favorite ? 1 : 0,
    row.likes === undefined ? null : row.likes, row.play_count || 0, row.last_played || null);
  // Apps connectees prevenues : "Reprendre", vu / pas vu et favoris se mettent a jour tout de suite.
  notifyUserData(profile, uuid);
  // Meme progression et meme "vu" sur l'autre version du titre (tt... / tmdb:...).
  require('./versions').mirror(profile, uuid).catch(() => {});
}

/** Annonce aux apps du profil (WebSocket) les donnees de lecture d'un element. */
function notifyUserData(profile, uuid) {
  // Episodes vus du profil (coche et pastille des series) : a relire.
  require('./library').forgetPlayed(profile.id);
  const row = st.udGet.get(profile.id, uuid);
  if (row) require('./socket').userDataChanged(profile.id, uuid, dto.userData(uuid, row, runtimeOf(ids.get(uuid))));
}

function current(profile, uuid) {
  return st.udGet.get(profile.id, uuid) || { position: 0, played: 0, favorite: 0, likes: null, play_count: 0, last_played: null };
}

/** Rapport de lecture (debut / progression / arret) envoye par l'app (req : appareil, pour les statistiques). */
function report(profile, body, stage, req) {
  // Le clip "aucune source" ne compte pas : ni progression, ni statistiques, ni suivi.
  if (isClipReport(body)) return;
  const { entry } = unwrap(body?.ItemId);
  if (!entry || !['movie', 'episode'].includes(entry.kind)) return;
  const row = { ...current(profile, entry.uuid) };
  const wasPlayed = !!row.played;
  const wasStarted = row.position > 0;
  const pos = Number(body.PositionTicks);
  const ticks = runtimeOf(entry);
  if (Number.isFinite(pos)) row.position = pos;
  const position = row.position;
  row.last_played = Date.now();
  // Memes regles que Jellyfin : vu au-dela de 90 %, pas de reprise sous 5 %. Un titre deja vu que
  // l'on revoit reste vu : seule sa position de reprise est gardee (revisionnage arrete en cours).
  if (ticks && row.position > ticks * 0.9) {
    // Chaque visionnage complet compte, revisionnage compris (une seule fois par lecture).
    if (!row.played || wasStarted) row.play_count = (row.play_count || 0) + 1;
    row.played = 1;
    row.position = 0;
  } else if (stage === 'stopped' && ticks && row.position < ticks * 0.05) {
    row.position = 0;
  }
  saveUd(profile, entry.uuid, row);
  // Statistiques : lecture en cours et temps regarde, avec la release lue et l'appareil.
  const src = body.MediaSourceId ? cache.peek('src|' + ids.norm(body.MediaSourceId))?.v : null;
  const tok = req?.tok || {};
  require('../stats').onReport(profile, entry, stage, {
    position,
    ticks,
    paused: body.IsPaused === true,
    client: tok.client || req?.authInfo?.client,
    device: tok.device || req?.authInfo?.device,
    deviceId: tok.device_id || req?.authInfo?.deviceid,
    source: src ? { release: src.release || src.name, quality: QUALITY_NAME[src.bucket], size: src.size, addonName: src.addon || null, addonLogo: src.addonLogo || null } : null
  });
  // Trakt (lecture en direct) et Simkl (vu), si le profil les a associes.
  require('../tracking').onReport(profile, entry, stage, { position, ticks, paused: body.IsPaused === true, watched: !wasPlayed && !!row.played });
}

async function setPlayed(profile, id, played) {
  const entry = ids.get(id);
  if (!entry) return null;
  let targets = [entry];
  if (entry.kind === 'series' || entry.kind === 'season') {
    const library = require('./library');
    const series = entry.kind === 'series' ? entry : ids.get(entry.data.seriesUuid);
    const tree = await library.seriesTree(profile, series);
    targets = tree.seasons.filter((s) => entry.kind === 'series' || s.n === entry.data.season).flatMap((s) => s.episodes);
  }
  const now = Date.now();
  for (const e of targets) {
    const row = { ...current(profile, e.uuid) };
    if (played && !row.played) row.play_count = (row.play_count || 0) + 1;
    row.played = played ? 1 : 0;
    row.position = 0;
    row.last_played = played ? now : row.last_played;
    saveUd(profile, e.uuid, row);
  }
  require('../tracking').onPlayed(profile, targets, played);
  return dto.userData(entry.uuid, current(profile, entry.uuid), runtimeOf(entry));
}

function setFlag(profile, id, patch) {
  const entry = ids.get(id);
  if (!entry) return null;
  const row = { ...current(profile, entry.uuid), ...patch };
  saveUd(profile, entry.uuid, row);
  return dto.userData(entry.uuid, row, runtimeOf(entry));
}

/** POST UserData : l'app envoie un UserItemDataDto partiel. */
function updateUserData(profile, id, body) {
  const entry = ids.get(id);
  if (!entry) return null;
  const row = { ...current(profile, entry.uuid) };
  if (typeof body.IsFavorite === 'boolean') row.favorite = body.IsFavorite ? 1 : 0;
  if (typeof body.Played === 'boolean') row.played = body.Played ? 1 : 0;
  if (Number.isFinite(Number(body.PlaybackPositionTicks)) && body.PlaybackPositionTicks !== null) row.position = Number(body.PlaybackPositionTicks);
  if (typeof body.Likes === 'boolean') row.likes = body.Likes ? 1 : 0;
  if (body.LastPlayedDate) row.last_played = Date.parse(body.LastPlayedDate) || row.last_played;
  saveUd(profile, entry.uuid, row);
  return dto.userData(entry.uuid, row, runtimeOf(entry));
}

module.exports = {
  notifyUserData,
  sourcesFor,
  playbackInfo,
  placeholderSource,
  qualitySources,
  versionSources,
  mediaSegments,
  embyChapters,
  resolveSource,
  pipe,
  subtitle,
  report,
  setPlayed,
  setFlag,
  updateUserData
};
