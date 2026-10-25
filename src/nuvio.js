// Lien avec un compte Nuvio, en lecture seule : appairage par code (comme une TV), puis
// lecture des profils et des collections. Rien n'est jamais ecrit chez Nuvio.
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

// ---- Compte associe ------------------------------------------------------------------------

function link() {
  return config.get().nuvio || null;
}

function status() {
  const l = link();
  return l ? { linked: true, email: l.email || '', linkedAt: l.linkedAt } : { linked: false };
}

let access = null; // { token, expires }
let refreshing = null;

function saveTokens(t) {
  access = { token: t.access_token, expires: Date.now() + (Number(t.expires_in) || 3600) * 1000 };
  // Nuvio remplace le jeton de renouvellement a chaque utilisation : on garde le nouveau.
  if (t.refresh_token && config.get().nuvio) {
    config.get().nuvio.refreshToken = t.refresh_token;
    config.save();
  }
}

/** Jeton d'acces valide (renouvele au besoin, une seule fois a la fois). */
async function accessToken() {
  const l = link();
  if (!l) throw new Error("Aucun compte Nuvio n'est associé");
  if (access && access.expires > Date.now() + 60e3) return access.token;
  if (!refreshing) {
    refreshing = (async () => {
      try {
        saveTokens(await call('/auth/v1/token?grant_type=refresh_token', { refresh_token: l.refreshToken }));
        return access.token;
      } catch (e) {
        if (e.status === 400 || e.status === 401) throw new Error('Le lien avec Nuvio a expiré : associe à nouveau le compte');
        throw e;
      }
    })().finally(() => {
      refreshing = null;
    });
  }
  return refreshing;
}

function unlink() {
  access = null;
  delete config.get().nuvio;
  config.save();
  log('compte dissocie');
}

// ---- Appairage par code ---------------------------------------------------------------------

const pairings = new Map(); // id -> { code, nonce, expiresAt }

async function pairStart() {
  const nonce = crypto.randomBytes(24).toString('hex');
  const r = (await rpc('start_tv_login_session', { p_device_nonce: nonce, p_redirect_base_url: LOGIN_URL, p_device_name: 'Stremfin' }))?.[0];
  if (!r?.code) throw new Error("Nuvio n'a pas renvoyé de code");
  const id = crypto.randomUUID();
  const expiresAt = Date.parse(r.expires_at) || Date.now() + 10 * 60e3;
  pairings.set(id, { code: r.code, nonce, expiresAt });
  for (const [k, p] of pairings) if (p.expiresAt < Date.now()) pairings.delete(k);
  let webUrl = null;
  try {
    const u = new URL(r.web_url);
    if (['http:', 'https:'].includes(u.protocol)) webUrl = u.href;
  } catch {}
  return { id, code: r.code, webUrl: webUrl || LOGIN_URL, expiresAt };
}

/** Verifie si le code a ete valide sur le site Nuvio ; si oui, associe le compte. */
async function pairPoll(id) {
  const p = pairings.get(id);
  if (!p || p.expiresAt < Date.now()) throw new Error('Code expiré, recommence');
  if (p.busy) return { status: 'pending' };
  p.busy = true;
  try {
    const r = (await rpc('poll_tv_login_session', { p_code: p.code, p_device_nonce: p.nonce }))?.[0];
    if (r?.status !== 'approved') return { status: r?.status || 'pending' };
    const t = await call('/functions/v1/tv-logins-exchange', { code: p.code, device_nonce: p.nonce });
    const user = await call('/auth/v1/user', null, t.access_token, 'GET');
    config.get().nuvio = { userId: user?.id || '', email: user?.email || '', refreshToken: t.refresh_token, linkedAt: Date.now() };
    saveTokens(t);
    pairings.delete(id);
    log(`compte associe (${user?.email || user?.id})`);
    return { status: 'connected', email: user?.email || '' };
  } finally {
    p.busy = false;
  }
}

// ---- Lectures ---------------------------------------------------------------------------------

/** Profils du compte : [{ index, name, avatar }]. */
async function profiles() {
  const token = await accessToken();
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

/** Addons installes sur un profil Nuvio : [{ url, name }] (les collections y font reference par id). */
async function addons(profileIndex) {
  const token = await accessToken();
  const identity = (await rpc('sync_pull_profiles', {}, token)).find((p) => Number(p.profile_index) === Number(profileIndex));
  if (!identity) return [];
  // Profil qui partage les addons du profil principal.
  const pid = identity.uses_primary_addons ? 1 : Number(profileIndex);
  const rows = await call(`/rest/v1/addons?user_id=eq.${encodeURIComponent(identity.user_id)}&profile_id=eq.${pid}&order=sort_order.asc`, null, token, 'GET');
  return (Array.isArray(rows) ? rows : []).filter((r) => r.url).map((r) => ({ url: String(r.url), name: String(r.name || '') }));
}

/** Collections d'un profil Nuvio (format de l'app Nuvio : dossiers -> sources). */
async function collections(profileIndex) {
  const rows = await rpc('sync_pull_collections', { p_profile_id: Number(profileIndex) }, await accessToken());
  const blob = Array.isArray(rows) ? rows[0] : rows;
  const raw = blob?.collections_json ?? blob?.collectionsJson ?? [];
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.collections) ? raw.collections : [];
  return list.filter((c) => c && c.id && Array.isArray(c.folders));
}

module.exports = { status, pairStart, pairPoll, unlink, profiles, addons, collections };
