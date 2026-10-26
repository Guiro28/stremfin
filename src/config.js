const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { hashPassword, verifyPassword, passwordProblem } = require('./security');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'config.json');

const CINEMETA = 'https://v3-cinemeta.strem.io/manifest.json';

// 32 caracteres sans ambiguite (pas de I, O, 0, 1) : 256 % 32 === 0, donc aucun biais.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function hex(bytes = 16) {
  return crypto.randomBytes(bytes).toString('hex');
}

/** Code de profil facon "K7F2M-9QX3T" : sert de mot de passe dans les apps Jellyfin. */
function newCode() {
  const b = crypto.randomBytes(10);
  let s = '';
  for (let i = 0; i < 10; i++) {
    s += CODE_ALPHABET[b[i] % CODE_ALPHABET.length];
    if (i === 4) s += '-';
  }
  return s;
}

function defaultSettings() {
  return {
    serverName: process.env.SERVER_NAME || 'Stremfin',
    // URL publique (ex: https://jelly.mondomaine.com). Vide = deduite de la requete.
    publicUrl: '',
    // Langue des libelles generes par le serveur (Saison, Films, Series...).
    language: 'fr',
    // Mode de connexion propose pour un addon ajoute a un profil (comme Nuvio Manager) :
    // none = l'app lit la video a la source, direct = via le serveur (son IP),
    // warp = via le serveur et le proxy externe ci-dessous.
    // Par defaut : via le proxy externe s'il est fourni au premier lancement (Docker + WARP).
    addonMode: ['socks', 'http'].includes(process.env.UPSTREAM_MODE) && process.env.UPSTREAM_URL ? 'warp' : 'direct',
    // Proxy externe (direct | socks | http), ex. WARP : addons en mode "warp", catalogues et manifests.
    upstream: {
      mode: ['direct', 'socks', 'http'].includes(process.env.UPSTREAM_MODE) ? process.env.UPSTREAM_MODE : 'direct',
      url: process.env.UPSTREAM_URL || ''
    },
    // Serveur de streaming Stremio (ex: http://stremio-server:11470) pour lire les torrents.
    torrentServer: process.env.TORRENT_SERVER || '',
    // Masque les episodes pas encore sortis.
    hideUnreleased: true,
    // Clip "aucune source disponible" lance quand aucun addon ne fournit la video.
    noSourceVideo: true,
    // Delai max d'attente des addons de sources (ms).
    streamTimeout: 15000,
    // Cle API TMDB (v3) : fiches traduites, catalogues Stremfin (tendances, sagas, collections).
    tmdbApiKey: process.env.TMDB_API_KEY || '',
    // Applications Trakt (client id + secret) et Simkl (client id) : suivi des profils et
    // listes Trakt des collections. Creees par l'admin sur trakt.tv / simkl.com.
    traktClientId: '',
    traktClientSecret: '',
    simklClientId: '',
    // Serveur Scrob (auto-heberge) : chaque profil y associe son compte par code.
    scrobUrl: '',
    // Langue et pays des fiches TMDB (le pays sert aux sorties et classifications).
    metadataLanguage: 'fr-FR',
    // Boutons "Passer l'intro / le generique" (timestamps de TheIntroDB).
    introSkip: true,
    // Theme du client web Jellyfin servi par Stremfin : "abyss" ou "none" (Jellyfin d'origine).
    webTheme: 'abyss',
    // Banniere Spotlight du theme Abyss sur l'accueil du client web.
    webSpotlight: true,
    // Contenu de Spotlight : "trending" (films tendance TMDB) ou "resume" (reprises).
    webSpotlightSource: 'trending',
    // Tri par defaut des bibliotheques dans les apps Emby (qui demandent toujours "par nom") :
    // "catalog" = ordre du catalogue (populaires, tendances...), "name" = par nom.
    embySort: 'catalog',
    // Sauvegarde automatique quotidienne (data/backups) : heure (0-23) et retention en jours.
    backupEnabled: true,
    backupHour: 4,
    backupRetention: 7
  };
}

// Preferences de lecture d'un profil : langue audio (vide = langues prioritaires du profil),
// langue des sous-titres (vide = premiere langue prioritaire), et quand les afficher :
// Default (pistes marquees "par defaut" / "forcees"), Always, OnlyForced, Smart (si l'audio
// n'est pas dans la langue des sous-titres), None.
const SUBTITLE_MODES = ['Default', 'Always', 'OnlyForced', 'Smart', 'None'];
const PLAYBACK = { audioLanguage: '', subtitleLanguage: '', subtitleMode: 'Default', playDefaultAudioTrack: false, rememberAudio: true, rememberSubtitles: true };

function newProfile(name) {
  return {
    id: hex(16),
    name: name || 'Profil',
    code: newCode(),
    createdAt: Date.now(),
    // Cinemeta : fiches de secours ; ses catalogues (en anglais) ne remplissent pas "Mes medias".
    addons: [{ url: CINEMETA, manifest: null, catalogsHidden: true }],
    // Reglages par catalogue : { "<cle>": { enabled, name } } + ordre d'affichage.
    catalogs: {},
    catalogOrder: [],
    // Collections de la bibliotheque attribuees a ce profil (ids) : chacune devient une bibliotheque.
    collections: [],
    // Langues audio a faire remonter en premier dans la liste des sources.
    preferredLanguages: ['fr'],
    // Pistes au lancement (reglables aussi depuis les apps Jellyfin / Emby) : voir PLAYBACK.
    playback: { ...PLAYBACK },
    // Retire des catalogues les films deja vus.
    hideWatched: false,
    // Qualite lancee par defaut (2160, 1080, 720) ; a defaut, la plus proche disponible.
    defaultQuality: '1080',
    // Versions proposees sur une fiche : "quality" (4K, 1080p, 720p) ou "releases" (5 par qualite).
    versionMode: 'quality',
    // CSS applique au client web Jellyfin (navigateur, Jellyfin Media Player) pour ce profil.
    customCss: '',
    // Masque films/series pas encore sortis en VOD, DVD ou a la TV (necessite TMDB).
    onlyReleased: false,
    // Mot de passe du profil (hache scrypt), defini par l'admin ou par l'utilisateur.
    passwordHash: null,
    // Page d'accueil des apps : ordre des sections (homesection0..9 de Jellyfin), null = defaut de l'app.
    homeSections: null,
    // Bibliotheques sans rangee "ajouts recents" sur l'accueil (cles de catalogue).
    latestExcludes: [],
    // Affiche le profil sur l'ecran "Qui regarde ?" de tous les appareils.
    showOnLogin: false,
    // Profil desactive : plus aucune connexion possible.
    disabled: false,
    // Avatar : nom du fichier dans data/avatars + date de mise a jour (sert d'etiquette d'image).
    avatar: null,
    avatarAt: null
  };
}

let state = null;

function load() {
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    raw = {};
  }
  state = {
    serverId: raw.serverId || hex(16),
    // Compte de l'interface d'administration : { username, passwordHash }.
    admin: raw.admin || null,
    settings: { ...defaultSettings(), ...(raw.settings || {}) },
    profiles: Array.isArray(raw.profiles) ? raw.profiles.map((p) => ({ ...newProfile(p.name), ...p })) : [],
    // Bibliotheque d'addons du serveur : [{ id, url, name, manifest }], attribues ensuite aux profils.
    addons: Array.isArray(raw.addons) ? raw.addons : [],
    // Bibliotheque de collections (fichiers .json + addons), attribuees ensuite aux profils.
    collections: Array.isArray(raw.collections) ? raw.collections : []
  };
  state.settings.upstream = { ...defaultSettings().upstream, ...(state.settings.upstream || {}) };
  migratePlatforms();
  migrateStreamMode();
  // Theme GlassFin retire : ElegantFin, dont il derive, prend sa place.
  if (state.settings.webTheme === 'glassfin') state.settings.webTheme = 'elegantfin';
  // Premier lancement en Docker : compte admin cree depuis AUTH_USER / AUTH_PASS.
  if (!state.admin && process.env.AUTH_USER && process.env.AUTH_PASS) {
    state.admin = { username: process.env.AUTH_USER.trim(), passwordHash: hashPassword(process.env.AUTH_PASS) };
    console.log(`[config] Compte admin "${state.admin.username}" cree depuis AUTH_USER/AUTH_PASS`);
  }
  if (!state.profiles.length) {
    const p = newProfile('Moi');
    state.profiles.push(p);
    console.log(`[config] Profil cree : "${p.name}" - code ${p.code}`);
  }
  save();
  return state;
}

// Ancienne bibliotheque "Plateformes" (remplacee par les collections) : reglages retires.
const PLATFORM_KEY = /\|(platforms\|tmdb-platforms|(movie|series)\|tmdb-provider-\d+)$/;
function migratePlatforms() {
  if (!state.settings.providers) return;
  delete state.settings.providers;
  for (const p of state.profiles) {
    p.catalogs = Object.fromEntries(Object.entries(p.catalogs || {}).filter(([k]) => !PLATFORM_KEY.test(k)));
    p.catalogOrder = (p.catalogOrder || []).filter((k) => !PLATFORM_KEY.test(k));
    p.latestExcludes = (p.latestExcludes || []).filter((k) => !PLATFORM_KEY.test(k));
  }
  // Cartes larges generees pour les plateformes.
  fs.rmSync(path.join(DATA_DIR, 'images'), { recursive: true, force: true });
  console.log('[config] Plateformes retirées (remplacées par les collections)');
}

// Ancien reglage global "Lecture des videos" : devient le mode de chaque addon des profils.
function migrateStreamMode() {
  const s = state.settings;
  if (s.streamMode === undefined) return;
  const external = s.upstream.mode !== 'direct' && !!s.upstream.url;
  s.addonMode = s.streamMode === 'redirect' ? 'none' : external ? 'warp' : 'direct';
  delete s.streamMode;
  for (const p of state.profiles) for (const a of p.addons) if (!a.mode) a.mode = s.addonMode;
  console.log(`[config] Mode des addons : ${s.addonMode} (ancien reglage "Lecture des videos")`);
}

const MODES = ['none', 'direct', 'warp'];

/**
 * Chaque addon d'un profil renvoie a la bibliotheque (lib = id) : addons des profils sans
 * correspondance ajoutes a la bibliotheque (meme URL = meme addon), puis URL, nom et manifest
 * recopies depuis la bibliotheque.
 */
function linkAddons() {
  const lib = state.addons;
  for (const p of state.profiles) {
    for (const a of p.addons) {
      let l = lib.find((x) => x.id === a.lib) || lib.find((x) => x.url === a.url);
      if (!l) {
        l = { id: hex(8), url: a.url, name: '', manifest: a.manifest || null, addedAt: Date.now() };
        lib.push(l);
      }
      if (!l.manifest && a.manifest) l.manifest = a.manifest;
      a.lib = l.id;
      a.url = l.url;
      a.name = l.name || '';
      a.manifest = l.manifest;
      if (!MODES.includes(a.mode)) a.mode = state.settings.addonMode;
    }
    // Un meme addon une seule fois par profil.
    const seen = new Set();
    p.addons = p.addons.filter((a) => !seen.has(a.lib) && seen.add(a.lib));
  }
}

function save() {
  linkAddons();
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, FILE);
}

function get() {
  return state;
}

function updateSettings(patch) {
  const s = state.settings;
  for (const k of Object.keys(defaultSettings())) {
    if (patch[k] === undefined) continue;
    if (['traktClientId', 'traktClientSecret', 'simklClientId'].includes(k)) {
      s[k] = String(patch[k] || '').trim().slice(0, 200);
    } else if (k === 'upstream') {
      s.upstream = {
        mode: ['direct', 'socks', 'http'].includes(patch.upstream?.mode) ? patch.upstream.mode : 'direct',
        url: String(patch.upstream?.url || '').trim()
      };
    } else if (k === 'backupHour') {
      // Minuit (0) est une heure valable.
      const n = Number(patch[k]);
      if (Number.isInteger(n) && n >= 0 && n <= 23) s[k] = n;
    } else if (typeof s[k] === 'boolean') {
      s[k] = !!patch[k];
    } else if (typeof s[k] === 'number') {
      const n = Number(patch[k]);
      if (Number.isFinite(n) && n > 0) s[k] = n;
    } else {
      s[k] = String(patch[k]).trim();
    }
  }
  s.publicUrl = s.publicUrl.replace(/\/+$/, '');
  if (!['abyss', 'elegantfin', 'none'].includes(s.webTheme)) s.webTheme = 'abyss';
  if (!['trending', 'resume'].includes(s.webSpotlightSource)) s.webSpotlightSource = 'trending';
  if (!['catalog', 'name'].includes(s.embySort)) s.embySort = 'catalog';
  if (!['fr', 'en', 'es', 'de', 'it'].includes(s.language)) s.language = 'fr';
  s.backupHour = Math.min(23, Math.max(0, Math.round(Number(s.backupHour)) || 0));
  s.backupRetention = Math.min(365, Math.max(1, Math.round(Number(s.backupRetention)) || 7));
  s.torrentServer = s.torrentServer.replace(/\/+$/, '');
  s.scrobUrl = s.scrobUrl.replace(/\/+$/, '');
  if (!MODES.includes(s.addonMode)) s.addonMode = 'direct';
  save();
  return s;
}

// ---- Profils ----------------------------------------------------------------

// Sections de l'accueil des apps Jellyfin (valeurs de homesectionN).
const HOME_SECTIONS = ['smalllibrarytiles', 'librarybuttons', 'resume', 'nextup', 'latestmedia', 'resumeaudio', 'resumebook', 'livetv', 'activerecordings', 'none'];

function getProfile(id) {
  const n = String(id || '').toLowerCase().replace(/-/g, '');
  return state.profiles.find((p) => p.id === n);
}

/** Profil par nom d'utilisateur (insensible a la casse et aux espaces autour). */
function findProfileByName(name) {
  const n = String(name || '').trim().toLowerCase();
  if (!n) return null;
  return state.profiles.find((p) => p.name.trim().toLowerCase() === n) || null;
}

function cleanName(name) {
  const n = String(name || '').trim().replace(/\s+/g, ' ');
  if (!n) throw new Error("Le nom d'utilisateur est obligatoire");
  if (n.length > 40) throw new Error("Nom d'utilisateur trop long (40 caractères max.)");
  return n;
}

function assertUniqueName(name, exceptId) {
  const other = findProfileByName(name);
  if (other && other.id !== exceptId) throw new Error(`Le nom « ${name} » est déjà utilisé`);
}

function requirePassword(password) {
  const problem = passwordProblem(password);
  if (problem) throw new Error(problem);
  return hashPassword(password);
}

function addProfile(name, password) {
  const n = cleanName(name);
  assertUniqueName(n);
  const p = newProfile(n);
  p.passwordHash = requirePassword(password);
  state.profiles.push(p);
  save();
  return p;
}

/** Copie d'un profil : memes addons, bibliotheques et preferences, nouveau nom et nouveau code. */
function duplicateProfile(id, name, password) {
  const src = getProfile(id);
  if (!src) return null;
  const n = cleanName(name);
  assertUniqueName(n);
  const p = newProfile(n);
  p.passwordHash = requirePassword(password);
  for (const k of ['addons', 'catalogs', 'catalogOrder', 'collections', 'preferredLanguages', 'playback', 'hideWatched', 'defaultQuality', 'versionMode', 'customCss', 'onlyReleased', 'homeSections', 'latestExcludes']) {
    if (src[k] !== undefined) p[k] = JSON.parse(JSON.stringify(src[k]));
  }
  state.profiles.push(p);
  save();
  return p;
}

function updateProfile(id, patch) {
  const p = getProfile(id);
  if (!p) return null;
  if (typeof patch.name === 'string') {
    const n = cleanName(patch.name);
    assertUniqueName(n, p.id);
    p.name = n;
  }
  if (typeof patch.password === 'string' && patch.password) p.passwordHash = requirePassword(patch.password);
  if (typeof patch.showOnLogin === 'boolean') p.showOnLogin = patch.showOnLogin;
  if (typeof patch.disabled === 'boolean') p.disabled = patch.disabled;
  if (patch.homeSections === null) p.homeSections = null;
  else if (Array.isArray(patch.homeSections)) {
    p.homeSections = patch.homeSections.map(String).filter((x) => HOME_SECTIONS.includes(x)).slice(0, 10);
  }
  if (Array.isArray(patch.latestExcludes)) p.latestExcludes = patch.latestExcludes.map(String);
  if (Array.isArray(patch.preferredLanguages)) {
    p.preferredLanguages = patch.preferredLanguages.map((l) => String(l).toLowerCase().trim()).filter(Boolean);
  }
  if (patch.playback && typeof patch.playback === 'object') {
    const { to2 } = require('./languages');
    const pb = { ...PLAYBACK, ...(p.playback || {}) };
    const x = patch.playback;
    if (typeof x.audioLanguage === 'string') pb.audioLanguage = to2(x.audioLanguage).slice(0, 8);
    if (typeof x.subtitleLanguage === 'string') pb.subtitleLanguage = to2(x.subtitleLanguage).slice(0, 8);
    if (SUBTITLE_MODES.includes(x.subtitleMode)) pb.subtitleMode = x.subtitleMode;
    for (const k of ['playDefaultAudioTrack', 'rememberAudio', 'rememberSubtitles']) if (typeof x[k] === 'boolean') pb[k] = x[k];
    p.playback = pb;
  }
  if (typeof patch.hideWatched === 'boolean') p.hideWatched = patch.hideWatched;
  if (typeof patch.onlyReleased === 'boolean') p.onlyReleased = patch.onlyReleased;
  if (['2160', '1080', '720'].includes(String(patch.defaultQuality))) p.defaultQuality = String(patch.defaultQuality);
  if (['quality', 'releases'].includes(patch.versionMode)) p.versionMode = patch.versionMode;
  if (typeof patch.customCss === 'string') {
    if (patch.customCss.length > 100000) throw new Error('CSS trop long (100 Ko max.)');
    p.customCss = patch.customCss;
  }
  if (patch.catalogs && typeof patch.catalogs === 'object') {
    // Les images des tuiles "Mes medias" se reglent a part : on les garde.
    const before = p.catalogs || {};
    p.catalogs = Object.fromEntries(
      Object.entries(patch.catalogs).map(([k, v]) => [k, before[k]?.image ? { ...v, image: before[k].image } : v])
    );
  }
  if (Array.isArray(patch.catalogOrder)) p.catalogOrder = patch.catalogOrder.map(String);
  save();
  return p;
}

function removeProfile(id) {
  const before = state.profiles.length;
  state.profiles = state.profiles.filter((p) => p.id !== id);
  if (state.profiles.length !== before) save();
  return state.profiles.length !== before;
}

// ---- Compte admin -------------------------------------------------------------

function hasAdmin() {
  return !!state.admin?.passwordHash;
}

function checkAdmin(username, password) {
  if (!hasAdmin()) return false;
  const okUser = String(username || '').trim().toLowerCase() === state.admin.username.toLowerCase();
  // On verifie le mot de passe meme si le nom est faux (temps de reponse constant).
  const okPass = verifyPassword(password, state.admin.passwordHash);
  return okUser && okPass;
}

function setAdmin(username, password) {
  const u = String(username || '').trim();
  if (!u) throw new Error("Le nom d'utilisateur est obligatoire");
  const problem = passwordProblem(password);
  if (problem) throw new Error(problem);
  state.admin = { username: u, passwordHash: hashPassword(password) };
  save();
}

function renameAdmin(username) {
  const u = String(username || '').trim();
  if (!u) throw new Error("Le nom d'utilisateur est obligatoire");
  state.admin.username = u;
  save();
}

/** Normalise une URL d'addon : stremio:// -> https://, et toujours en /manifest.json. */
function normalizeManifestUrl(url) {
  let u = String(url || '').trim();
  if (u.startsWith('stremio://')) u = 'https://' + u.slice('stremio://'.length);
  if (!/^https?:\/\//i.test(u)) throw new Error('URL invalide');
  if (!/\/manifest\.json(\?.*)?$/.test(u)) u = u.replace(/\/+$/, '') + '/manifest.json';
  return u;
}

module.exports = {
  DATA_DIR,
  CINEMETA,
  load,
  save,
  get,
  updateSettings,
  getProfile,
  findProfileByName,
  addProfile,
  duplicateProfile,
  updateProfile,
  removeProfile,
  normalizeManifestUrl,
  MODES,
  PLAYBACK,
  SUBTITLE_MODES,
  HOME_SECTIONS,
  hasAdmin,
  checkAdmin,
  setAdmin,
  renameAdmin
};
