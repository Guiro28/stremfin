// Suivi par profil : Trakt, Simkl et Scrob (associes par code, dans les deux sens) et historique Nuvio
// (compte Nuvio propre au profil, associe par code ; lecture seule). L'import marque les titres vus et reprend les lectures en cours de Nuvio, sans
// ecraser une progression plus recente ; il ne renvoie rien vers Trakt / Simkl (pas de boucle).
// L'envoi : lectures en direct vers Trakt et Scrob (scrobble), titres vus / pas vus vers Trakt, Simkl
// et Scrob.
const crypto = require('crypto');
const config = require('./config');
const ids = require('./ids');
const nuvio = require('./nuvio');
const tmdb = require('./tmdb');
const { st, db, transaction } = require('./db');
const pkg = require('../package.json');

const TRAKT = 'https://api.trakt.tv';
const SIMKL = 'https://api.simkl.com';
// Simkl AUTH V2 : chaque serveur utilise sa propre application Simkl (type "TV, devices & command
// line" : code appareil, sans secret), dont l'administrateur renseigne le Client ID.
const SIMKL_SCOPE = 'media:read media:write';
// Jeton valable 7 jours : renouvele quand il en reste moins de 2.
const SIMKL_REFRESH_BEFORE = 2 * 24 * 3600e3;
const OOB = 'urn:ietf:wg:oauth:2.0:oob';
const IMPORT_EVERY = 6 * 3600e3;
// Un meme titre vu a moins de 4 h d'ecart par deux sources : un seul visionnage.
const PLAY_NEAR = 4 * 3600e3;
const SERVICES = ['trakt', 'simkl', 'scrob', 'nuvio'];

function log(...args) {
  console.log(new Date().toISOString(), '[suivi]', ...args);
}

async function request(url, { method = 'GET', headers = {}, body, form } = {}) {
  let r;
  try {
    r = await fetch(url, {
      method,
      redirect: 'error',
      signal: AbortSignal.timeout(20000),
      headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
      // form : corps application/x-www-form-urlencoded (OAuth 2.0 de Simkl).
      body: form ? new URLSearchParams(form) : body ? JSON.stringify(body) : undefined
    });
  } catch (e) {
    throw new Error(`Service injoignable : ${e.message}`);
  }
  const text = await r.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {}
  return { status: r.status, ok: r.ok, data, headers: r.headers };
}

const settings = () => config.get().settings;

/** Application Trakt / Simkl renseignee dans les reglages ? */
function ready(service) {
  const s = settings();
  // Nuvio : rien a configurer, chaque profil associe son propre compte.
  if (service === 'trakt') return !!(s.traktClientId && s.traktClientSecret);
  if (service === 'simkl') return !!simklClientId();
  if (service === 'scrob') return !!s.scrobUrl;
  return true;
}

const traktHeaders = (token) => ({ Authorization: `Bearer ${token}`, 'trakt-api-key': settings().traktClientId, 'trakt-api-version': '2' });
/** Client ID de l'application Simkl renseignee dans les reglages. */
function simklClientId() {
  return settings().simklClientId;
}

// Un compte associe garde le Client ID qui a delivre son jeton (le jeton n'est valable qu'avec lui).
const simklIdOf = (link) => link?.clientId || simklClientId();
const simklHeaders = (token, clientId) => ({ Authorization: `Bearer ${token}`, 'simkl-api-key': clientId });

function simklUrl(path, params, clientId) {
  const u = new URL(SIMKL + path);
  for (const [k, v] of Object.entries({ client_id: clientId, 'app-name': 'stremfin', 'app-version': pkg.version, ...params })) u.searchParams.set(k, v);
  return u;
}

const simklForm = (form) => ({ method: 'POST', headers: { 'User-Agent': `stremfin/${pkg.version}` }, form });

function simklTokens(d) {
  return { accessToken: d.access_token, refreshToken: d.refresh_token, expiresAt: Date.now() + (Number(d.expires_in) || 7 * 24 * 3600) * 1000, scope: d.scope || SIMKL_SCOPE };
}

// Scrob (github.com/ellite/scrob, auto-heberge) : association par code appareil, comme son extension
// Kodi ; jeton valable 24 h, renouvele quand il reste moins d'une heure, refresh token change a
// chaque renouvellement. L'interface web de Scrob relaie l'API sous /api/proxy mais, hors session,
// ne laisse passer que les routes de l'extension Kodi... ou une requete portant un en-tete
// X-Api-Key, quel qu'il soit : c'est ensuite le serveur Scrob qui verifie, et il accepte le jeton
// d'appareil. L'en-tete ouvre donc l'historique date et les "vu" / "pas vu" ; si une version de
// Scrob le refusait un jour, l'import le signalerait (les lectures en direct, routes Kodi, resteraient).
// L'adresse est lue a chaque appel : la changer dans les reglages suffit.
const SCROB_REFRESH_BEFORE = 3600e3;
const scrobApi = (path) => `${String(settings().scrobUrl).replace(/\/+$/, '')}/api/proxy${path}`;
const scrobHeaders = (token) => ({ Authorization: `Bearer ${token}`, 'X-Api-Key': 'stremfin' });

function scrobTokens(d) {
  return { accessToken: d.access_token, refreshToken: d.refresh_token, expiresAt: Date.now() + (Number(d.expires_in) || 24 * 3600) * 1000 };
}

// ---- Association (code a valider sur trakt.tv / simkl.com / le serveur Scrob) -----------------

const pairings = new Map(); // id -> { service, profileId, userCode, deviceCode, expiresAt }

async function pairStart(profile, service) {
  if (service === 'trakt' && !ready('trakt')) throw new Error("Renseigne d'abord l'application Trakt (Réglages → Suivi)");
  if (service === 'simkl' && !ready('simkl')) throw new Error("Renseigne d'abord l'application Simkl (Réglages → Suivi)");
  if (service === 'scrob' && !ready('scrob')) throw new Error("Renseigne d'abord l'adresse du serveur Scrob (Réglages → Suivi)");
  const s = settings();
  let p;
  if (service === 'trakt') {
    const r = await request(`${TRAKT}/oauth/device/code`, { method: 'POST', body: { client_id: s.traktClientId } });
    if (!r.ok || !r.data?.device_code) throw new Error('Impossible de créer le code Trakt');
    p = { deviceCode: r.data.device_code, userCode: r.data.user_code, url: r.data.verification_url || 'https://trakt.tv/activate', expiresIn: r.data.expires_in };
  } else if (service === 'scrob') {
    const r = await request(scrobApi('/auth/device/code'), { method: 'POST', body: { client_name: `Stremfin · ${profile.name}`, scope: 'write' } }).catch(() => null);
    if (!r?.ok || !r.data?.device_code) throw new Error('Serveur Scrob injoignable : vérifie son adresse (Réglages → Suivi)');
    // Scrob construit ce lien avec son SERVER_URL (http://localhost:7330 s'il n'est pas regle) : on
    // garde son chemin (/link?code=...) sur l'adresse saisie, celle qu'on ouvre dans le navigateur.
    const link = new URL(r.data.verification_uri_complete || r.data.verification_uri || '/link', 'http://x');
    const url = `${String(s.scrobUrl).replace(/\/+$/, '')}${link.pathname}${link.search}`;
    p = { deviceCode: r.data.device_code, userCode: r.data.user_code, url, expiresIn: r.data.expires_in };
  } else {
    // AUTH V2 (OAuth 2.0, code appareil).
    const clientId = simklClientId();
    const r = await request(`${SIMKL}/oauth2/device`, simklForm({ client_id: clientId, scope: SIMKL_SCOPE }));
    if (r.status === 401 && r.data?.error === 'invalid_client') throw new Error("Ce Client ID n'est pas une application Simkl AUTH V2 (Réglages → Suivi)");
    if (!r.ok || !r.data?.device_code) throw new Error('Impossible de créer le code Simkl');
    p = { clientId, deviceCode: r.data.device_code, userCode: r.data.user_code, url: r.data.verification_uri_complete || r.data.verification_uri || 'https://simkl.com/pin', expiresIn: r.data.expires_in };
  }
  for (const [k, x] of pairings) if (x.expiresAt < Date.now()) pairings.delete(k);
  const id = crypto.randomUUID();
  const expiresAt = Date.now() + (Number(p.expiresIn) || 600) * 1000;
  pairings.set(id, { ...p, service, profileId: profile.id, expiresAt });
  return { id, userCode: p.userCode, url: p.url, expiresAt };
}

function traktTokens(d) {
  const created = (Number(d.created_at) || Math.floor(Date.now() / 1000)) * 1000;
  return { accessToken: d.access_token, refreshToken: d.refresh_token, expiresAt: created + (Number(d.expires_in) || 604800) * 1000 };
}

/** Le code a-t-il ete valide ? Si oui, le compte est associe au profil. */
async function pairPoll(profile, id) {
  const p = pairings.get(id);
  if (!p || p.profileId !== profile.id || p.expiresAt < Date.now()) throw new Error('Code expiré, recommence');
  const s = settings();
  let link;
  if (p.service === 'trakt') {
    const r = await request(`${TRAKT}/oauth/device/token`, { method: 'POST', body: { code: p.deviceCode, client_id: s.traktClientId, client_secret: s.traktClientSecret } });
    if (r.status === 400 || r.status === 429) return { status: 'pending' };
    if (r.status === 418) throw new Error('Autorisation Trakt refusée');
    if (r.status === 404 || r.status === 410) throw new Error('Code expiré, recommence');
    if (!r.ok || !r.data?.access_token) throw new Error('Connexion Trakt impossible');
    link = traktTokens(r.data);
    const me = await request(`${TRAKT}/users/settings`, { headers: traktHeaders(link.accessToken) }).catch(() => null);
    link.user = me?.data?.user?.username || me?.data?.user?.name || '';
  } else if (p.service === 'scrob') {
    const r = await request(scrobApi('/auth/device/token'), { method: 'POST', form: { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: p.deviceCode } });
    const error = r.data?.error;
    if (error === 'authorization_pending' || error === 'slow_down') return { status: 'pending' };
    if (error === 'access_denied') throw new Error('Autorisation Scrob refusée');
    if (error === 'expired_token') throw new Error('Code expiré, recommence');
    if (!r.ok || !r.data?.access_token) throw new Error('Connexion Scrob impossible');
    // Le jeton d'appareil ne donne pas acces au compte : on affiche le serveur a la place du nom.
    link = { ...scrobTokens(r.data), user: new URL(s.scrobUrl).host };
  } else {
    const r = await request(`${SIMKL}/oauth2/token`, simklForm({ grant_type: 'urn:ietf:params:oauth:grant-type:device_code', client_id: p.clientId, device_code: p.deviceCode }));
    const error = r.data?.error;
    if (error === 'authorization_pending' || error === 'slow_down') return { status: 'pending' };
    if (error === 'access_denied') throw new Error('Autorisation Simkl refusée');
    if (error === 'expired_token') throw new Error('Code expiré, recommence');
    if (!r.ok || !r.data?.access_token) throw new Error('Connexion Simkl impossible');
    link = { ...simklTokens(r.data), clientId: p.clientId };
    const me = await request(simklUrl('/users/settings', {}, p.clientId), { method: 'POST', headers: simklHeaders(link.accessToken, p.clientId) }).catch(() => null);
    link.user = me?.data?.user?.name || me?.data?.account?.name || '';
  }
  pairings.delete(id);
  const prev = profile[p.service] || {};
  profile[p.service] = { import: prev.import !== false, export: prev.export !== false, ...link, connectedAt: Date.now() };
  config.save();
  log(`${profile.name} : ${p.service} associe (${link.user || '?'})`);
  return { status: 'connected', user: link.user };
}

function unlink(profile, service) {
  const link = profile[service];
  delete profile[service];
  config.save();
  // Simkl : l'autorisation est aussi revoquee chez Simkl (au mieux, sans attendre).
  if (service === 'simkl' && link?.refreshToken) {
    request(`${SIMKL}/oauth2/revoke`, simklForm({ client_id: simklIdOf(link), token: link.refreshToken })).catch(() => {});
  }
}

const refreshing = new Map(); // "service|profil" -> renouvellement en cours (un seul a la fois)

/** Un seul renouvellement a la fois par service et profil : les demandes simultanees l'attendent. */
function once(key, job) {
  if (!refreshing.has(key)) refreshing.set(key, job().finally(() => refreshing.delete(key)));
  return refreshing.get(key);
}

/**
 * Jeton Simkl valable, renouvele 2 jours avant expiration. Un renouvellement invalide le jeton
 * precedent : deux demandes simultanees attendent donc le meme.
 */
async function simklToken(profile) {
  const t = profile.simkl;
  if (!t?.refreshToken) throw new Error("Simkl n'est pas associé");
  if ((t.expiresAt || 0) - Date.now() > SIMKL_REFRESH_BEFORE) return t.accessToken;
  return once(`simkl|${profile.id}`, async () => {
    const r = await request(`${SIMKL}/oauth2/token`, simklForm({ grant_type: 'refresh_token', client_id: simklIdOf(t), refresh_token: t.refreshToken }));
    if (r.ok && r.data?.access_token) {
      // Simkl renvoie le meme refresh token (il ne change pas) ; on garde l'ancien s'il manque.
      Object.assign(t, simklTokens({ refresh_token: t.refreshToken, ...r.data }));
      config.save();
      return t.accessToken;
    }
    if (r.status === 400 || r.status === 401) throw new Error('Le lien avec Simkl a expiré : associe à nouveau le compte');
    // Panne passagere : le jeton actuel sert encore tant qu'il n'a pas expire.
    if ((t.expiresAt || 0) > Date.now()) return t.accessToken;
    throw new Error(`Simkl : erreur ${r.status}`);
  });
}

/**
 * Jeton Scrob valable. Le refresh token change a chaque renouvellement et Scrob coupe l'acces si
 * l'ancien resservait : il est enregistre aussitot, et jamais deux renouvellements a la fois.
 */
async function scrobToken(profile) {
  const t = profile.scrob;
  if (!t?.refreshToken) throw new Error("Scrob n'est pas associé");
  if ((t.expiresAt || 0) - Date.now() > SCROB_REFRESH_BEFORE) return t.accessToken;
  return once(`scrob|${profile.id}`, async () => {
    const r = await request(scrobApi('/auth/device/token'), { method: 'POST', form: { grant_type: 'refresh_token', refresh_token: t.refreshToken } });
    if (r.ok && r.data?.access_token) {
      Object.assign(t, scrobTokens(r.data));
      config.save();
      return t.accessToken;
    }
    if (r.status === 400 || r.status === 401) throw new Error('Le lien avec Scrob a expiré : associe à nouveau le compte');
    if ((t.expiresAt || 0) > Date.now()) return t.accessToken;
    throw new Error(`Scrob : erreur ${r.status}`);
  });
}

/** Jeton Trakt valide (renouvele un jour avant expiration). */
async function traktToken(profile) {
  const t = profile.trakt;
  if (!t?.accessToken) throw new Error("Trakt n'est pas associé");
  if (t.expiresAt > Date.now() + 24 * 3600e3) return t.accessToken;
  const s = settings();
  const r = await request(`${TRAKT}/oauth/token`, {
    method: 'POST',
    body: { refresh_token: t.refreshToken, client_id: s.traktClientId, client_secret: s.traktClientSecret, redirect_uri: OOB, grant_type: 'refresh_token' }
  });
  if (!r.ok || !r.data?.access_token) throw new Error('Le lien avec Trakt a expiré : associe à nouveau le compte');
  Object.assign(t, traktTokens(r.data));
  config.save();
  return t.accessToken;
}

// ---- Historiques distants -> evenements { kind, imdb, tmdb, title, season, episode, at, minutes } ---

const minutesOf = (v) => {
  const n = Number(String(v ?? '').match(/\d+/)?.[0]);
  return n > 0 && n < 24 * 60 ? n : 0;
};

/** Historique Trakt depuis le dernier import (tout, la premiere fois). */
async function traktEvents(profile) {
  const t = profile.trakt;
  const token = await traktToken(profile);
  const events = [];
  let newest = t.lastAt || 0;
  for (let page = 1; page <= 200; page++) {
    const u = new URL(`${TRAKT}/sync/history`);
    u.searchParams.set('page', page);
    u.searchParams.set('limit', '100');
    u.searchParams.set('extended', 'full');
    if (t.lastAt) u.searchParams.set('start_at', new Date(t.lastAt + 1000).toISOString());
    const r = await request(u, { headers: traktHeaders(token) });
    if (r.status === 401) throw new Error('Le lien avec Trakt a expiré : associe à nouveau le compte');
    if (!r.ok || !Array.isArray(r.data)) throw new Error('Historique Trakt indisponible');
    for (const item of r.data) {
      const at = Date.parse(item.watched_at) || 0;
      newest = Math.max(newest, at);
      if (item.type === 'movie' && item.movie) {
        events.push({ kind: 'movie', imdb: item.movie.ids?.imdb, tmdb: item.movie.ids?.tmdb, title: item.movie.title, at, minutes: minutesOf(item.movie.runtime) });
      } else if (item.type === 'episode' && item.show && item.episode) {
        events.push({ kind: 'episode', imdb: item.show.ids?.imdb, tmdb: item.show.ids?.tmdb, title: item.show.title, season: item.episode.season, episode: item.episode.number, at, minutes: minutesOf(item.episode.runtime) });
      }
    }
    const pages = Number(r.headers.get('x-pagination-page-count') || 0);
    if (!r.data.length || (pages && page >= pages)) break;
  }
  return { events, commit: () => (t.lastAt = newest) };
}

/** Historique Simkl : tout la premiere fois, ensuite ce qui a change depuis le dernier import. */
async function simklEvents(profile) {
  const t = profile.simkl;
  const token = await simklToken(profile);
  const startedAt = Date.now();
  const events = [];
  for (const type of ['movies', 'shows', 'anime']) {
    const params = { extended: 'full', episode_watched_at: 'yes' };
    if (t.lastSync) params.date_from = new Date(t.lastSync - 60e3).toISOString();
    const r = await request(simklUrl(`/sync/all-items/${type}`, params, simklIdOf(t)), { headers: simklHeaders(token, simklIdOf(t)) });
    if (r.status === 401) throw new Error('Le lien avec Simkl a expiré : associe à nouveau le compte');
    if (!r.ok) throw new Error('Historique Simkl indisponible');
    const rows = Array.isArray(r.data) ? r.data : r.data?.[type] || [];
    for (const item of rows) {
      if (type === 'movies') {
        const m = item.movie || {};
        const at = Date.parse(item.last_watched_at || item.last_watched) || 0;
        if (item.status === 'completed' && at) events.push({ kind: 'movie', imdb: m.ids?.imdb, tmdb: m.ids?.tmdb, title: m.title, at, minutes: minutesOf(m.runtime) });
        continue;
      }
      const show = item.show || item.anime || {};
      for (const season of item.seasons || []) {
        for (const ep of season.episodes || []) {
          const at = Date.parse(ep.watched_at || ep.last_watched_at) || 0;
          if (at) events.push({ kind: 'episode', imdb: show.ids?.imdb, tmdb: show.ids?.tmdb, title: show.title, season: season.number, episode: ep.number, at, minutes: minutesOf(show.runtime) });
        }
      }
    }
  }
  return { events, commit: () => (t.lastSync = startedAt) };
}

/**
 * Historique Scrob, du plus recent au plus ancien, jusqu'au dernier import (tout la premiere fois).
 * Scrob garde chaque visionnage avec sa date : un film vu deux fois compte deux fois. Ce que
 * Stremfin y a envoye lui-meme (source "stremfin") n'est pas repris.
 */
async function scrobEvents(profile) {
  const t = profile.scrob;
  const token = await scrobToken(profile);
  const events = [];
  let newest = t.lastAt || 0;
  for (let page = 1; page <= 1000; page++) {
    const r = await request(scrobApi(`/history?page=${page}&page_size=100`), { headers: scrobHeaders(token) }).catch(() => null);
    // 302 (redirection vers /login) : cette version de Scrob ne laisse plus passer l'en-tete.
    if (!r || r.status === 302) throw new Error("Scrob ne donne pas accès à l'historique avec le code appareil");
    if (r.status === 401) throw new Error('Le lien avec Scrob a expiré : associe à nouveau le compte');
    if (!r.ok || !Array.isArray(r.data?.results)) throw new Error('Historique Scrob indisponible');
    let done = false;
    for (const ev of r.data.results) {
      // Scrob donne l'heure UTC sans fuseau ("2026-10-23T21:19:22") : sans "Z", elle serait lue
      // comme une heure locale.
      const iso = String(ev.watched_at || '');
      const at = Date.parse(/T.*(Z|[+-]\d\d:?\d\d)$/i.test(iso) || !iso ? iso : `${iso}Z`) || 0;
      if (t.lastAt && at <= t.lastAt) {
        done = true;
        break;
      }
      newest = Math.max(newest, at);
      if (ev.source === 'stremfin') continue;
      const m = ev.media || {};
      // Plusieurs visionnages groupes dans un evenement (ex. compteur Kodi) : une ligne chacun.
      const times = Math.min(20, Math.max(1, Number(ev.play_count) || 1));
      for (let i = 0; i < times; i++) {
        const when = at ? at - i * 1000 : 0;
        if (m.type === 'movie' && (m.imdb_id || m.tmdb_id)) {
          events.push({ kind: 'movie', imdb: m.imdb_id || undefined, tmdb: m.tmdb_id || undefined, title: m.title, at: when, minutes: minutesOf(m.runtime) });
        } else if (m.type === 'episode' && m.show_tmdb_id && m.season_number != null && m.episode_number != null) {
          events.push({ kind: 'episode', tmdb: m.show_tmdb_id, title: m.show_title, season: m.season_number, episode: m.episode_number, at: when, minutes: minutesOf(m.runtime) });
        }
      }
    }
    if (done || page >= (Number(r.data.total_pages) || 1)) break;
  }
  return { events, commit: () => (t.lastAt = newest) };
}

/** Vus et lectures en cours du profil Nuvio choisi (lecture seule). */
async function nuvioEvents(profile) {
  const index = profile.nuvioHistory.profile;
  const acc = nuvio.forProfile(profile);
  const [watched, progress] = await Promise.all([nuvio.watched(index, acc), nuvio.progress(index, acc)]);
  const idOf = (row) => {
    const c = String(row.content_id || '');
    return { imdb: /^tt\d+$/.test(c) ? c : undefined, tmdb: Number(c.match(/^tmdb:(\d+)$/)?.[1]) || undefined };
  };
  const time = (v) => Number(v) || Date.parse(v) || 0;
  const events = [];
  for (const row of watched) {
    const movie = row.content_type === 'movie';
    if (!movie && (row.season == null || row.episode == null)) continue;
    events.push({ kind: movie ? 'movie' : 'episode', ...idOf(row), title: row.title, season: row.season, episode: row.episode, at: time(row.watched_at) });
  }
  // Lectures en cours (positions en ms) : seulement entre 5 et 90 %, comme Jellyfin.
  for (const row of progress) {
    const pos = Number(row.position) || 0;
    const dur = Number(row.duration) || 0;
    const movie = row.content_type === 'movie';
    if (!dur || pos < dur * 0.05 || pos > dur * 0.9 || (!movie && (row.season == null || row.episode == null))) continue;
    events.push({ kind: movie ? 'movie' : 'episode', ...idOf(row), season: row.season, episode: row.episode, at: time(row.last_watched), position: pos, duration: dur });
  }
  return { events, commit: () => {} };
}

// ---- Application aux "vus" de Stremfin ---------------------------------------------------------

function current(profile, uuid) {
  return st.udGet.get(profile.id, uuid) || { position: 0, played: 0, favorite: 0, likes: null, play_count: 0, last_played: null };
}

function save(profile, uuid, row) {
  st.udPut.run(profile.id, uuid, Math.max(0, Math.round(row.position || 0)), row.played ? 1 : 0, row.favorite ? 1 : 0, row.likes ?? null, row.play_count || 0, row.last_played || null);
  // Titres importes (Trakt, Simkl, Nuvio) : les apps connectees sont prevenues.
  require('./jellyfin/playback').notifyUserData(profile, uuid);
}

/** Vu a la date `at`, sauf si une lecture plus recente est en cours ici. */
function markWatched(profile, uuid, at) {
  const row = { ...current(profile, uuid) };
  if (row.played || (row.position > 0 && (row.last_played || 0) > at)) return false;
  row.played = 1;
  row.position = 0;
  row.play_count = (row.play_count || 0) + 1;
  row.last_played = Math.max(row.last_played || 0, at);
  save(profile, uuid, row);
  return true;
}

/** Reprise a `positionMs`, si c'est plus recent que ce que Stremfin connait. */
function markProgress(profile, uuid, at, positionMs) {
  const row = { ...current(profile, uuid) };
  if ((row.last_played || 0) >= at) return false;
  row.played = 0;
  row.position = positionMs * 10000;
  row.last_played = at;
  save(profile, uuid, row);
  return true;
}

/**
 * Identifiants Stremfin d'un titre : la version IMDb (tt...) et la version TMDB (tmdb:...)
 * sont deux elements differents selon le catalogue d'ou vient le titre ; on marque les deux.
 * L'id manquant est retrouve sur TMDB : un titre a ainsi la meme identite quelle que soit la
 * source (Scrob ne donne que l'id TMDB d'une serie, Simkl et Trakt aussi l'IMDb), et un meme
 * visionnage importe de deux sources n'est compte qu'une fois.
 */
async function sidsOf(kind, imdb, tmdbId) {
  const type = kind === 'movie' ? 'movie' : 'series';
  let t = Number(tmdbId) || null;
  if (!t && imdb && tmdb.enabled()) t = (await tmdb.resolve(type, imdb).catch(() => null))?.id || null;
  if (!imdb && t && tmdb.enabled()) imdb = (await tmdb.imdbIdOf(type, t).catch(() => null)) || undefined;
  const out = [];
  if (imdb) out.push(imdb);
  if (t) out.push(`tmdb:${t}`);
  return { sids: out, tmdbId: t, imdb };
}

/** Applique des evenements a un profil. Renvoie { watched, progress }. */
async function apply(profile, events, source) {
  const library = require('./jellyfin/library');
  const titles = new Map();
  for (const ev of events) {
    if (!ev.imdb && !ev.tmdb) continue;
    const k = `${ev.kind}|${ev.imdb || ''}|${ev.tmdb || ''}`;
    if (!titles.has(k)) titles.set(k, { kind: ev.kind, imdb: ev.imdb, tmdb: ev.tmdb, title: ev.title, events: [] });
    titles.get(k).events.push(ev);
  }
  const list = [...titles.values()];
  // Correspondance IMDb -> TMDB : 8 titres a la fois (reponses TMDB en cache 30 jours).
  for (let i = 0; i < list.length; i += 8) {
    await Promise.all(list.slice(i, i + 8).map(async (x) => Object.assign(x, await sidsOf(x.kind, x.imdb, x.tmdb))));
  }
  let watched = 0;
  let progress = 0;
  for (const x of list) {
    if (!x.sids.length) continue;
    const type = x.kind === 'movie' ? 'movie' : 'series';
    library.registerMetas(x.sids.map((sid) => ({ id: sid, type, name: x.title || undefined })));
    // Film en deux versions : chacune connait l'autre (une seule ligne dans "Reprendre").
    if (x.kind === 'movie' && x.sids.length === 2) {
      const [a, b] = x.sids.map((sid) => ids.uuidOf(`item|movie|${sid}`));
      ids.register(`item|movie|${x.sids[0]}`, 'movie', { twin: b });
      ids.register(`item|movie|${x.sids[1]}`, 'movie', { twin: a });
    }
    for (const ev of x.events) {
      let uuids;
      if (x.kind === 'movie') {
        uuids = x.sids.map((sid) => ids.uuidOf(`item|movie|${sid}`));
      } else {
        const s = Number(ev.season);
        const e = Number(ev.episode);
        const vid = x.imdb ? `${x.imdb}:${s}:${e}` : `tmdb:${x.tmdbId}:${s}:${e}`;
        uuids = ids.registerMany(
          x.sids.map((sid) => ({
            key: `ep|${sid}|${vid}`,
            kind: 'episode',
            data: { seriesUuid: ids.uuidOf(`item|series|${sid}`), seasonUuid: ids.uuidOf(`season|${sid}|${s}`), type: 'series', seriesSid: sid, vid, tmdbVid: x.tmdbId ? `tmdb:${x.tmdbId}:${s}:${e}` : undefined, season: s, episode: e }
          }))
        );
      }
      if (ev.position) {
        // Duree connue de Nuvio : sert au pourcentage de reprise tant que la fiche n'est pas chargee.
        for (const u of uuids) {
          const e = ids.get(u);
          if (e && !e.data.runtime && ev.duration) ids.register(e.key, e.kind, { runtime: `${Math.round(ev.duration / 60e3)} min` });
        }
        if (uuids.map((u) => markProgress(profile, u, ev.at, ev.position)).some(Boolean)) progress++;
        continue;
      }
      if (uuids.map((u) => markWatched(profile, u, ev.at)).some(Boolean)) watched++;
      // Historique (statistiques) : une ligne par visionnage date, sans doublon.
      if (!ev.at) continue;
      const label = x.kind === 'movie' ? x.title : `${x.title || ''} S${String(ev.season).padStart(2, '0')}E${String(ev.episode).padStart(2, '0')}`;
      const ms = (ev.minutes || 0) * 60e3;
      // Deja la (lecture faite ici puis envoyee a Trakt, ou vue via Nuvio et Trakt) : pas de doublon.
      if (st.playNear.get(profile.id, uuids[0], uuids[1] || uuids[0], ev.at - PLAY_NEAR, ev.at + PLAY_NEAR, source)) continue;
      st.playImport.run(profile.id, uuids[0], x.kind, label || null, x.kind === 'movie' ? null : x.title || null, ev.at, ev.at, ms, ms, source);
    }
  }
  return { watched, progress };
}

// ---- Import --------------------------------------------------------------------------------------

const FETCH = { trakt: traktEvents, simkl: simklEvents, scrob: scrobEvents, nuvio: nuvioEvents };
const running = new Map();

/** Etat d'un service pour un profil : { linked, active } (active = import a faire). */
function serviceState(profile, service) {
  if (service === 'nuvio') {
    const n = profile.nuvioHistory;
    const linked = !!profile.nuvio?.refreshToken;
    return { linked, active: linked && n?.profile != null && n.import !== false };
  }
  const linked = !!profile[service]?.[{ trakt: 'accessToken', simkl: 'refreshToken', scrob: 'refreshToken' }[service]] && ready(service);
  return { linked, active: linked && profile[service].import !== false };
}

/** Importe l'historique d'un profil depuis ses services associes. */
function importProfile(profile) {
  if (running.has(profile.id)) return running.get(profile.id);
  const job = (async () => {
    const results = {};
    for (const service of SERVICES) {
      if (!serviceState(profile, service).active) continue;
      const holder = service === 'nuvio' ? profile.nuvioHistory : profile[service];
      try {
        const { events, commit } = await FETCH[service](profile);
        const r = await apply(profile, events, service);
        commit();
        Object.assign(holder, { lastSync: Date.now(), lastError: null, lastResult: { ...r, events: events.length } });
        results[service] = r;
        log(`${profile.name} : ${service} -> ${events.length} evenement(s), ${r.watched} vu(s), ${r.progress} reprise(s)`);
      } catch (e) {
        holder.lastError = e.message;
        results[service] = { error: e.message };
        log(`${profile.name} : import ${service} KO : ${e.message}`);
      }
    }
    config.save();
    return results;
  })().finally(() => running.delete(profile.id));
  running.set(profile.id, job);
  return job;
}

async function importAll() {
  for (const p of config.get().profiles.filter((x) => !x.disabled)) {
    await importProfile(p);
    // Simkl sans import : le jeton est quand meme renouvele (un refresh token inutilise 180 jours expire).
    if (serviceState(p, 'simkl').linked) await simklToken(p).catch((e) => log(`${p.name} : renouvellement Simkl KO : ${e.message}`));
    if (serviceState(p, 'scrob').linked) await scrobToken(p).catch((e) => log(`${p.name} : renouvellement Scrob KO : ${e.message}`));  }
}

let timer = null;

/**
 * Doublons deja dans les statistiques : un meme visionnage importe de deux sources (ou lu ici puis
 * importe), a moins de 4 h d'ecart, avant que les titres soient reconnus quelle que soit leur
 * version. Chaque titre est ramene a son id TMDB ; on garde la lecture faite ici, sinon la premiere
 * enregistree. Renvoie le nombre de lignes retirees.
 */
async function dedupePlays() {
  const rows = db.prepare('SELECT id, profile, uuid, source, started FROM plays ORDER BY profile, started, id').all();
  const resolved = new Map(); // "type|tt..." -> "tmdb:N" (ou l'id d'origine)
  const norm = async (type, sid) => {
    if (!/^tt\d+$/.test(sid || '') || !tmdb.enabled()) return sid;
    const k = `${type}|${sid}`;
    if (!resolved.has(k)) resolved.set(k, (await tmdb.resolve(type, sid).catch(() => null))?.id);
    return resolved.get(k) ? `tmdb:${resolved.get(k)}` : sid;
  };
  const keyOf = new Map(); // uuid -> identite du titre
  for (const r of rows) {
    if (keyOf.has(r.uuid)) continue;
    const e = ids.get(r.uuid);
    const movie = e?.key.match(/^item\|movie\|(.+)$/);
    let key = null;
    if (movie) key = `movie|${await norm('movie', movie[1])}`;
    else if (e?.kind === 'episode') key = `ep|${await norm('series', e.data.seriesSid || e.key.split('|')[1])}|${e.data.season}|${e.data.episode}`;
    keyOf.set(r.uuid, key);
  }
  const groups = new Map(); // "profil|titre" -> visionnages gardes
  const drop = [];
  for (const r of rows) {
    const key = keyOf.get(r.uuid);
    if (!key) continue;
    const g = groups.get(`${r.profile}|${key}`) || [];
    groups.set(`${r.profile}|${key}`, g);
    // Visionnage garde, proche, d'une autre source qui n'y a pas deja ete rattachee.
    const k = g.find((x) => !x.sources.has(r.source) && Math.abs(x.started - r.started) <= PLAY_NEAR);
    if (!k) {
      g.push({ id: r.id, source: r.source, started: r.started, sources: new Set([r.source]) });
    } else if (r.source === 'local' && k.source !== 'local') {
      drop.push(k.id);
      Object.assign(k, { id: r.id, source: 'local', started: r.started });
      k.sources.add('local');
    } else {
      drop.push(r.id);
      k.sources.add(r.source);
    }
  }
  const del = db.prepare('DELETE FROM plays WHERE id = ?');
  transaction(() => drop.forEach((id) => del.run(id)));
  return drop.length;
}

/**
 * Une fois : lignes Scrob importees quand ses heures (UTC, sans fuseau) etaient lues comme des heures
 * locales de ce serveur. Les profils encore associes refont leur import (heures justes, titres
 * reconnus quelle que soit leur version) ; les autres gardent leurs lignes, remises a l'heure UTC.
 */
function migrateScrobTimes() {
  const c = config.get();
  if (c.migrations.includes('scrob-utc')) return;
  const linked = new Set(c.profiles.filter((p) => p.scrob?.refreshToken).map((p) => p.id));
  const rows = db.prepare("SELECT id, profile, started FROM plays WHERE source = 'scrob'").all();
  const del = db.prepare('DELETE FROM plays WHERE id = ?');
  const fix = db.prepare('UPDATE OR IGNORE plays SET started = ?, ended = ? WHERE id = ?');
  transaction(() => {
    for (const r of rows) {
      if (linked.has(r.profile)) del.run(r.id);
      else {
        const at = r.started - new Date(r.started).getTimezoneOffset() * 60e3;
        fix.run(at, at, r.id);
      }
    }
  });
  for (const p of c.profiles) if (linked.has(p.id)) Object.assign(p.scrob, { lastAt: 0, lastSync: null, lastResult: null });
  c.migrations.push('scrob-utc');
  config.save();
  if (rows.length) log(`${rows.length} lecture(s) Scrob remise(s) a l'heure UTC ou reimportee(s)`);
}

function start() {
  clearTimeout(timer);
  migrateScrobTimes();
  dedupePlays()
    .then((n) => n && log(`${n} visionnage(s) en double retire(s) des statistiques (meme lecture vue par plusieurs sources)`))
    .catch((e) => log(`nettoyage des doublons KO : ${e.message}`));
  const run = () => {
    importAll()
      .catch((e) => log(`import KO : ${e.message}`))
      .finally(() => {
        timer = setTimeout(run, IMPORT_EVERY);
        timer.unref();
      });
  };
  timer = setTimeout(run, 2 * 60e3);
  timer.unref();
}

// ---- Envoi vers Trakt, Simkl et Scrob ----------------------------------------------------------

function idsOf(d) {
  const out = {};
  const imdb = d?.imdb || (/^tt\d+$/.test(d?.sid) ? d.sid : null);
  const t = Number(d?.tmdb) || Number(String(d?.sid || '').match(/^tmdb:(\d+)$/)?.[1]) || null;
  if (imdb) out.imdb = imdb;
  if (t) out.tmdb = t;
  return Object.keys(out).length ? out : null;
}

/** Film ou episode au format Trakt / Simkl, ou null. */
function mediaOf(entry) {
  if (entry.kind === 'movie') {
    const i = idsOf(entry.data);
    return i && { movie: { ids: i } };
  }
  if (entry.kind === 'episode') {
    const i = idsOf(ids.get(entry.data.seriesUuid)?.data);
    return i && { show: { ids: i }, episode: { season: Number(entry.data.season), number: Number(entry.data.episode) } };
  }
  return null;
}

function failed(profile, service, e) {
  if (profile[service]) profile[service].lastError = e.message;
  config.save();
  log(`${profile.name} : envoi ${service} KO : ${e.message}`);
}

const exporting = (profile, service) => serviceState(profile, service).linked && profile[service].export !== false;

async function trakt(profile, path, body) {
  const r = await request(TRAKT + path, { method: 'POST', headers: traktHeaders(await traktToken(profile)), body });
  // 409 : deja envoye il y a moins d'une heure (scrobble), sans gravite.
  if (!r.ok && r.status !== 409) throw new Error(`Trakt : erreur ${r.status}`);
}

async function simkl(profile, path, body) {
  const id = simklIdOf(profile.simkl);
  const r = await request(simklUrl(path, {}, id), { method: 'POST', headers: simklHeaders(await simklToken(profile), id), body });
  if (!r.ok) throw new Error(`Simkl : erreur ${r.status}`);
}

async function scrob(profile, path, { method = 'POST', body } = {}) {
  const r = await request(scrobApi(path), { method, headers: scrobHeaders(await scrobToken(profile)), body });
  // 409 : deja note dans la fenetre anti-doublon de Scrob, sans gravite.
  if (!r.ok && r.status !== 409) throw new Error(`Scrob : erreur ${r.status}`);
}

/** Element au format de l'extension Kodi de Scrob (episode : identifiants de la serie). */
// Scrob reconnait un film par son id TMDB (sinon il le cherche par titre, et un titre traduit peut
// tomber sur un autre film) : l'id est retrouve avant l'envoi.
async function scrobItem(entry, media) {
  if (media.movie) {
    const tmdbId = await tmdbIdOf('movie', media.movie.ids);
    return { type: 'movie', title: entry.data.name || '', year: Number(String(entry.data.releaseInfo || '').match(/\d{4}/)?.[0]) || undefined, uniqueid: { ...media.movie.ids, tmdb: tmdbId || undefined } };
  }
  const show = ids.get(entry.data.seriesUuid)?.data || {};
  const tmdbId = await tmdbIdOf('series', media.show.ids);
  return { type: 'episode', title: entry.data.name || '', showtitle: show.name || '', season: media.episode.season, episode: media.episode.number, uniqueid: { ...media.show.ids, tmdb: tmdbId || undefined } };
}

const KODI_EVENT = { start: 'playback_started', resume: 'playback_resumed', pause: 'playback_paused', stop: 'playback_stopped' };
const scrobQueue = new Map(); // lecture -> envois en cours, faits dans l'ordre (debut avant arret)

function scrobLive(profile, key, entry, media, action, position, ticks) {
  const send = async () => {
    const body = { event: KODI_EVENT[action], source: 'stremfin', session_id: key, item: await scrobItem(entry, media), position_seconds: Math.round((position || 0) / 1e7), total_seconds: Math.round(ticks / 1e7) };
    await scrob(profile, '/webhooks/kodi', { body });
  };
  const next = (scrobQueue.get(key) || Promise.resolve()).then(send).catch((e) => failed(profile, 'scrob', e));
  scrobQueue.set(key, next);
  next.finally(() => scrobQueue.get(key) === next && scrobQueue.delete(key));
}

/** Identifiant TMDB d'un film ou d'une serie (Scrob en a besoin pour "vu" / "pas vu"). */
async function tmdbIdOf(kind, i) {
  if (i?.tmdb) return i.tmdb;
  if (!i?.imdb || !tmdb.enabled()) return null;
  return (await tmdb.resolve(kind, i.imdb).catch(() => null))?.id || null;
}

/** "Vu" / "pas vu" vers Scrob, titre par titre. Un episode "pas vu" n'y est pas retire. */
async function scrobPlayed(profile, entries, played) {
  for (const e of entries) {
    const m = mediaOf(e);
    if (!m) continue;
    if (m.movie) {
      const id = await tmdbIdOf('movie', m.movie.ids);
      if (!id) continue;
      if (played) await scrob(profile, '/history', { body: { media_type: 'movie', tmdb_id: id, source: 'stremfin' } });
      else await scrob(profile, `/history/item?tmdb_id=${id}&media_type=movie`, { method: 'DELETE' });
    } else if (played) {
      const id = await tmdbIdOf('series', m.show.ids);
      if (id) await scrob(profile, '/history', { body: { media_type: 'episode', series_tmdb_id: id, season_number: m.episode.season, episode_number: m.episode.number, source: 'stremfin' } });
    }
  }
}

/** Corps "historique" (films + series regroupees par saison) pour /sync/history. */
function historyBody(entries, at) {
  const movies = [];
  const shows = new Map();
  for (const e of entries) {
    const m = mediaOf(e);
    if (!m) continue;
    const when = at ? { watched_at: new Date(at).toISOString() } : {};
    if (m.movie) movies.push({ ids: m.movie.ids, ...when });
    else {
      const k = JSON.stringify(m.show.ids);
      if (!shows.has(k)) shows.set(k, { ids: m.show.ids, seasons: new Map() });
      const seasons = shows.get(k).seasons;
      if (!seasons.has(m.episode.season)) seasons.set(m.episode.season, []);
      seasons.get(m.episode.season).push({ number: m.episode.number, ...when });
    }
  }
  return {
    movies,
    shows: [...shows.values()].map((s) => ({ ids: s.ids, seasons: [...s.seasons].map(([number, episodes]) => ({ number, episodes })) }))
  };
}

const live = new Map(); // "profil|uuid" -> { paused, at }

/**
 * Rapport de lecture d'une app : lecture en direct vers Trakt et Scrob (debut / pause / reprise /
 * arret ; Trakt marque vu au-dela de 80 %, Scrob a 90 %), et titre devenu vu vers Simkl.
 */
function onReport(profile, entry, stage, { position, ticks, paused, watched }) {
  const media = mediaOf(entry);
  if (!media) return;
  const toTrakt = exporting(profile, 'trakt');
  const toScrob = exporting(profile, 'scrob');
  if ((toTrakt || toScrob) && ticks) {
    for (const [k, v] of live) if (Date.now() - v.at > 6 * 3600e3) live.delete(k);
    const key = `${profile.id}|${entry.uuid}`;
    const prev = live.get(key);
    let action = null;
    if (stage === 'stopped') {
      action = 'stop';
      live.delete(key);
    } else if (!prev || stage === 'start') {
      action = paused ? 'pause' : 'start';
      live.set(key, { paused: !!paused, at: Date.now() });
    } else if (!!paused !== prev.paused) {
      action = paused ? 'pause' : 'resume';
      Object.assign(prev, { paused: !!paused, at: Date.now() });
    } else {
      prev.at = Date.now();
    }
    const progress = Math.round(Math.min(100, Math.max(0, (position / ticks) * 100)) * 100) / 100;
    if (action && toTrakt) trakt(profile, `/scrobble/${action === 'resume' ? 'start' : action}`, { ...media, progress, app_version: pkg.version }).catch((e) => failed(profile, 'trakt', e));
    if (action && toScrob) scrobLive(profile, key, entry, media, action, position, ticks);
  }
  if (watched && exporting(profile, 'simkl')) simkl(profile, '/sync/history', historyBody([entry], Date.now())).catch((e) => failed(profile, 'simkl', e));
}

/** "Vu" / "pas vu" choisi dans une app : envoye a Trakt, Simkl et Scrob. */
function onPlayed(profile, entries, played) {
  const at = played ? Date.now() : null;
  const body = historyBody(entries, at);
  if (!body.movies.length && !body.shows.length) return;
  const path = played ? '/sync/history' : '/sync/history/remove';
  if (exporting(profile, 'trakt')) trakt(profile, path, body).catch((e) => failed(profile, 'trakt', e));
  if (exporting(profile, 'simkl')) simkl(profile, path, body).catch((e) => failed(profile, 'simkl', e));
  if (exporting(profile, 'scrob')) scrobPlayed(profile, entries, played).catch((e) => failed(profile, 'scrob', e));
}

// ---- Pour l'interface ----------------------------------------------------------------------------

function describe(profile) {
  const view = (service) => {
    const h = service === 'nuvio' ? profile.nuvioHistory || {} : profile[service] || {};
    return {
      ready: ready(service),
      linked: serviceState(profile, service).linked,
      user: service === 'nuvio' ? profile.nuvio?.email || '' : h.user || '',
      import: h.import !== false,
      export: h.export !== false,
      lastSync: h.lastSync || null,
      lastError: h.lastError || null,
      lastResult: h.lastResult || null
    };
  };
  return { trakt: view('trakt'), simkl: view('simkl'), scrob: view('scrob'), nuvio: { ...view('nuvio'), profile: profile.nuvioHistory?.profile ?? null } };
}

/** Options : { trakt | simkl | scrob: { import, export }, nuvio: { profile, import } }. */
function update(profile, patch) {
  for (const service of ['trakt', 'simkl', 'scrob']) {
    const p = patch?.[service];
    if (!p || !profile[service]) continue;
    if (typeof p.import === 'boolean') profile[service].import = p.import;
    if (typeof p.export === 'boolean') profile[service].export = p.export;
  }
  // Profil Nuvio dont on recupere l'historique (compte Nuvio du profil).
  const n = patch?.nuvio;
  if (n) {
    profile.nuvioHistory = profile.nuvioHistory || {};
    if (n.profile === null || Number.isInteger(n.profile)) {
      if (n.profile !== profile.nuvioHistory.profile) Object.assign(profile.nuvioHistory, { lastSync: null, lastError: null, lastResult: null });
      profile.nuvioHistory.profile = n.profile;
    }
    if (typeof n.import === 'boolean') profile.nuvioHistory.import = n.import;
  }
  config.save();
}

/** Compte Nuvio du profil retire : plus d'historique Nuvio a importer. */
function unlinkNuvio(profile) {
  nuvio.unlink(nuvio.forProfile(profile));
  if (profile.nuvioHistory) Object.assign(profile.nuvioHistory, { profile: null, lastSync: null, lastError: null, lastResult: null });
  config.save();
}

module.exports = { pairStart, pairPoll, unlink, unlinkNuvio, importProfile, start, onReport, onPlayed, describe, update };
