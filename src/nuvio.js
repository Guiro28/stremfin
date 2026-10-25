// Lien avec le compte Nuvio d'un profil, en lecture seule : appairage par code (comme une TV),
// puis lecture des profils du compte et de leur historique. Rien n'est jamais ecrit chez Nuvio.
// Seul le jeton de renouvellement est garde (config.json) ; le jeton d'acces reste en memoire.
const crypto = require('crypto');
const config = require('./config');

const BACKEND = process.env.NUVIO_API_URL || 'https://api.nuvio.tv';
// Cle publique "anon" livree par le site Nuvio a tous les visiteurs (pas un identifiant de
// compte) : elle n'ouvre que ce que les regles d'acces de Nuvio autorisent.
const ANON_KEY =
  process.env.NUVIO_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiIsImlzcyI6InN1cGFiYXNlIiwiaWF0IjoxNzgxNTIxMzQ2LCJleHAiOjE5MzkyMDEzNDZ9.tmQaj682pwzehpqlgCDMnySOqiUvpgRbrE43T4VJpDI';
const LOGIN_URL = 'https://nuvio.tv/tv-login';

function log(...args) {
  console.log(new Date().toISOString(), '[nuvio]', ...args);
}

async function call(route, body, token, method = 'POST') {
  let r;
  try {
    r = await fetch(BACKEND + route, {
      method,
      redirect: 'error',
      signal: AbortSignal.timeout(25000),
      headers: { apikey: ANON_KEY, Authorization: `Bearer ${token || ANON_KEY}`, 'Content-Type': 'application/json' },
      ...(method === 'GET' ? {} : { body: JSON.stringify(body || {}) })
    });
  } catch (e) {
    throw new Error(`Nuvio injoignable : ${e.message}`);
  }
  const text = await r.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    throw new Error('Réponse de Nuvio illisible');
  }
  if (!r.ok) {
    const e = new Error(data?.message || data?.error_description || data?.error || `Nuvio : erreur ${r.status}`);
    e.status = r.status;
    throw e;
  }
  return data;
}

const rpc = (name, body, token) => call('/rest/v1/rpc/' + name, body, token);

// ---- Comptes associes ------------------------------------------------------------------------
// Compte propre a chaque profil (historique). Un "compte" sait lire, enregistrer et retirer son
// lien { userId, email, refreshToken, linkedAt }.

function forProfile(profile) {
  return { get: () => profile.nuvio || null, set: (l) => (profile.nuvio = l), clear: () => delete profile.nuvio };
}

function status(acc) {
  const l = acc.get();
  return l ? { linked: true, email: l.email || '', linkedAt: l.linkedAt } : { linked: false };
}

// Jetons d'acces en memoire, par lien : { token, expires, refreshing }.
const access = new WeakMap();

function saveTokens(l, t) {
  const a = access.get(l) || {};
  Object.assign(a, { token: t.access_token, expires: Date.now() + (Number(t.expires_in) || 3600) * 1000 });
  access.set(l, a);
  // Nuvio remplace le jeton de renouvellement a chaque utilisation : on garde le nouveau.
  if (t.refresh_token) {
    l.refreshToken = t.refresh_token;
    config.save();
  }
}

/** Jeton d'acces valide (renouvele au besoin, une seule fois a la fois). */
async function accessToken(acc) {
  const l = acc.get();
  if (!l) throw new Error("Aucun compte Nuvio n'est associé");
  const a = access.get(l) || {};
  access.set(l, a);
  if (a.token && a.expires > Date.now() + 60e3) return a.token;
  if (!a.refreshing) {
    a.refreshing = (async () => {
      try {
        saveTokens(l, await call('/auth/v1/token?grant_type=refresh_token', { refresh_token: l.refreshToken }));
        return a.token;
      } catch (e) {
        if (e.status === 400 || e.status === 401) throw new Error('Le lien avec Nuvio a expiré : associe à nouveau le compte');
        throw e;
      }
    })().finally(() => {
      a.refreshing = null;
    });
  }
  return a.refreshing;
}

function unlink(acc) {
  acc.clear();
  config.save();
  log('compte dissocie');
}

// ---- Appairage par code ---------------------------------------------------------------------

const pairings = new Map(); // id -> { code, nonce, expiresAt, owner }

/** owner : id du profil qui associe son compte. */
async function pairStart(owner) {
  const nonce = crypto.randomBytes(24).toString('hex');
  const r = (await rpc('start_tv_login_session', { p_device_nonce: nonce, p_redirect_base_url: LOGIN_URL, p_device_name: 'Stremfin' }))?.[0];
  if (!r?.code) throw new Error("Nuvio n'a pas renvoyé de code");
  const id = crypto.randomUUID();
  const expiresAt = Date.parse(r.expires_at) || Date.now() + 10 * 60e3;
  pairings.set(id, { code: r.code, nonce, expiresAt, owner });
  for (const [k, p] of pairings) if (p.expiresAt < Date.now()) pairings.delete(k);
  let webUrl = null;
  try {
    const u = new URL(r.web_url);
    if (['http:', 'https:'].includes(u.protocol)) webUrl = u.href;
  } catch {}
  return { id, code: r.code, webUrl: webUrl || LOGIN_URL, expiresAt };
}

/** Verifie si le code a ete valide sur le site Nuvio ; si oui, associe le compte a `acc`. */
async function pairPoll(id, acc, owner) {
  const p = pairings.get(id);
  if (!p || p.owner !== owner || p.expiresAt < Date.now()) throw new Error('Code expiré, recommence');
  if (p.busy) return { status: 'pending' };
  p.busy = true;
  try {
    const r = (await rpc('poll_tv_login_session', { p_code: p.code, p_device_nonce: p.nonce }))?.[0];
    if (r?.status !== 'approved') return { status: r?.status || 'pending' };
    const t = await call('/functions/v1/tv-logins-exchange', { code: p.code, device_nonce: p.nonce });
    const user = await call('/auth/v1/user', null, t.access_token, 'GET');
    const l = { userId: user?.id || '', email: user?.email || '', refreshToken: t.refresh_token, linkedAt: Date.now() };
    acc.set(l);
    saveTokens(l, t);
    pairings.delete(id);
    log(`compte associe (${user?.email || user?.id})`);
    return { status: 'connected', email: user?.email || '' };
  } finally {
    p.busy = false;
  }
}

// ---- Lectures ---------------------------------------------------------------------------------

/** Profils du compte : [{ index, name, avatar }]. */
async function profiles(acc) {
  const token = await accessToken(acc);
  const [rows, avatars] = await Promise.all([
    rpc('sync_pull_profiles', {}, token),
    rpc('get_avatar_catalog', {}, token).catch(() => [])
  ]);
  const urls = new Map(
    (Array.isArray(avatars) ? avatars : []).map((a) => {
      const p = String(a.storage_path || '').replace(/^\/+/, '');
      return [String(a.id), /^https?:\/\//.test(p) ? p : p ? `${BACKEND}/storage/v1/object/public/avatars/${p.split('/').map(encodeURIComponent).join('/')}` : null];
    })
  );
  return (Array.isArray(rows) ? rows : [])
    .map((r) => ({ index: Number(r.profile_index), name: String(r.name || `Profil ${r.profile_index}`), avatar: r.avatar_url || urls.get(String(r.avatar_id)) || null }))
    .filter((p) => Number.isInteger(p.index))
    .sort((a, b) => a.index - b.index);
}

/** Elements vus d'un profil Nuvio : [{ content_id, content_type, title, season, episode, watched_at }]. */
async function watched(profileIndex, acc) {
  const rows = await rpc('sync_pull_watched_items', { p_profile_id: Number(profileIndex), p_page: 1, p_page_size: 5000 }, await accessToken(acc));
  return Array.isArray(rows) ? rows : [];
}

/** Lectures en cours d'un profil Nuvio : [{ content_id, content_type, season, episode, position, duration, last_watched }]. */
async function progress(profileIndex, acc) {
  const rows = await rpc('sync_pull_watch_progress', { p_profile_id: Number(profileIndex), p_since_last_watched: null, p_limit: 5000 }, await accessToken(acc));
  return Array.isArray(rows) ? rows : [];
}

module.exports = { forProfile, status, pairStart, pairPoll, unlink, profiles, watched, progress };
