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
    // proxy = la video passe par le serveur (IP serveur/WARP) ; redirect = l'app lit la source directement.
    streamMode: 'proxy',
    // Sortie reseau pour les addons et les videos (direct | socks | http), comme stremio-proxy.
    upstream: {
      mode: ['direct', 'socks', 'http'].includes(process.env.UPSTREAM_MODE) ? process.env.UPSTREAM_MODE : 'direct',
      url: process.env.UPSTREAM_URL || ''
    },
    // Serveur de streaming Stremio (ex: http://stremio-server:11470) pour lire les torrents.
    torrentServer: process.env.TORRENT_SERVER || '',
    // Masque les episodes pas encore sortis.
    hideUnreleased: true,
    // Delai max d'attente des addons de sources (ms).
    streamTimeout: 15000,
    // Cle API TMDB (v3) : fiches traduites, catalogues Stremfin (tendances, plateformes, sagas).
    tmdbApiKey: process.env.TMDB_API_KEY || '',
    // Langue et pays des fiches TMDB (le pays sert aux plateformes et classifications).
    metadataLanguage: 'fr-FR',
    // Boutons "Passer l'intro / le generique" (timestamps de TheIntroDB).
    introSkip: true,
    // Theme du client web Jellyfin servi par Stremfin : "abyss" ou "none" (Jellyfin d'origine).
    webTheme: 'abyss',
    // Banniere Spotlight du theme Abyss sur l'accueil du client web.
    webSpotlight: true,
    // Contenu de Spotlight : "trending" (films tendance TMDB) ou "resume" (reprises).
    webSpotlightSource: 'trending',
    // Plateformes proposees comme bibliotheques (fournisseurs TMDB de la region choisie).
    providers: [
      { id: 8, name: 'Netflix' },
      { id: 119, name: 'Prime Video' },
      { id: 337, name: 'Disney+' },
      { id: 350, name: 'Apple TV+' },
      { id: 381, name: 'Canal+' },
      { id: 1899, name: 'HBO Max' },
      { id: 531, name: 'Paramount+' },
      { id: 283, name: 'Crunchyroll' },
      { id: 415, name: 'ADN' },
      { id: 234, name: 'Arte' },
      { id: 147, name: 'M6+' },
      { id: 1754, name: 'TF1+' },
      { id: 11, name: 'MUBI' },
      { id: 223, name: 'Hayu' }
    ]
  };
}

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
    // Langues audio a faire remonter en premier dans la liste des sources.
    preferredLanguages: ['fr'],
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
    profiles: Array.isArray(raw.profiles) ? raw.profiles.map((p) => ({ ...newProfile(p.name), ...p })) : []
  };
  state.settings.upstream = { ...defaultSettings().upstream, ...(state.settings.upstream || {}) };
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

function save() {
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
    if (k === 'providers') {
      if (!Array.isArray(patch.providers)) continue;
      s.providers = patch.providers
        .map((p) => {
          const out = { id: Number(p?.id), name: String(p?.name || '').trim().slice(0, 40) };
          // Couleur de fond de la carte (#rrggbb) et image de carte personnalisee (URL), facultatives.
          if (/^#[0-9a-f]{6}$/i.test(p?.color || '')) out.color = p.color.toLowerCase();
          if (/^https?:\/\/\S+$/i.test(p?.card || '')) out.card = p.card;
          return out;
        })
        .filter((p) => Number.isInteger(p.id) && p.id > 0 && p.name)
        .slice(0, 60);
    } else if (k === 'upstream') {
      s.upstream = {
        mode: ['direct', 'socks', 'http'].includes(patch.upstream?.mode) ? patch.upstream.mode : 'direct',
        url: String(patch.upstream?.url || '').trim()
      };
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
  if (!['abyss', 'none'].includes(s.webTheme)) s.webTheme = 'abyss';
  if (!['trending', 'resume'].includes(s.webSpotlightSource)) s.webSpotlightSource = 'trending';
  s.torrentServer = s.torrentServer.replace(/\/+$/, '');
  if (!['proxy', 'redirect'].includes(s.streamMode)) s.streamMode = 'proxy';
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
  for (const k of ['addons', 'catalogs', 'catalogOrder', 'preferredLanguages', 'hideWatched', 'defaultQuality', 'versionMode', 'customCss', 'onlyReleased', 'homeSections', 'latestExcludes']) {
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
  HOME_SECTIONS,
  hasAdmin,
  checkAdmin,
  setAdmin,
  renameAdmin
};
