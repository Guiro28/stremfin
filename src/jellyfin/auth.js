// Authentification facon Jellyfin : jeton par appareil, nom libre, mot de passe = code du profil.
const crypto = require('crypto');
const config = require('../config');
const { st } = require('../db');

/** Lit l'en-tete `Authorization: MediaBrowser Client="..", Device="..", Token=".."`. */
function parseAuth(req) {
  const h = req.headers['authorization'] || req.headers['x-emby-authorization'] || '';
  const out = {};
  const m = String(h).match(/^\s*(MediaBrowser|Emby)\s+(.*)$/i);
  if (m) {
    for (const p of m[2].matchAll(/(\w+)\s*=\s*"([^"]*)"/g)) {
      let v = p[2];
      try { v = decodeURIComponent(v); } catch {}
      out[p[1].toLowerCase()] = v;
    }
  }
  const q = req.query || {};
  // Apps Emby : infos de l'appareil dans des en-tetes separes ou dans la query.
  const dec = (v) => {
    try { return decodeURIComponent(String(v || '')); } catch { return String(v || ''); }
  };
  out.client = out.client || dec(req.headers['x-emby-client'] || q['X-Emby-Client']);
  out.device = out.device || dec(req.headers['x-emby-device-name'] || q['X-Emby-Device-Name']);
  out.deviceid = out.deviceid || dec(req.headers['x-emby-device-id'] || q['X-Emby-Device-Id']);
  out.version = out.version || dec(req.headers['x-emby-client-version'] || q['X-Emby-Client-Version']);
  // App Emby (et non Jellyfin) : schema "Emby", en-tetes X-Emby-Client separes ou prefixe /emby.
  out.emby = (m && m[1].toLowerCase() === 'emby') || !!(req.headers['x-emby-client'] || q['X-Emby-Client']) || !!req.embyPrefix;
  out.token =
    out.token ||
    req.headers['x-emby-token'] ||
    req.headers['x-mediabrowser-token'] ||
    q.api_key || q.ApiKey || q.apiKey || q.api_Key ||
    '';
  return out;
}

function createToken(profile, info) {
  const token = crypto.randomBytes(16).toString('hex');
  const now = Date.now();
  // Un seul jeton par appareil et par profil.
  if (info.deviceid) st.tokenDelDevice.run(profile.id, info.deviceid);
  st.tokenPut.run(token, profile.id, info.deviceid || '', info.device || '', info.client || '', info.version || '', now, now);
  return st.tokenGet.get(token);
}

const lastSeenWrite = new Map();

/** Middleware : attache req.profile / req.tok si le jeton est valide. */
function attach(req, res, next) {
  const info = parseAuth(req);
  req.authInfo = info;
  if (info.token) {
    const tok = st.tokenGet.get(String(info.token));
    const profile = tok && config.getProfile(tok.profile);
    // Profil desactive dans l'admin : ses sessions ne sont plus acceptees.
    if (profile && !profile.disabled) {
      req.tok = tok;
      req.profile = profile;
      const now = Date.now();
      if ((lastSeenWrite.get(tok.token) || 0) < now - 60e3) {
        lastSeenWrite.set(tok.token, now);
        st.tokenSeen.run(now, tok.token);
      }
    }
  }
  next();
}

function required(req, res, next) {
  if (req.profile) return next();
  res.status(401).send('Unauthorized');
}

// ---- Quick Connect ----------------------------------------------------------
// L'app affiche un code a 6 chiffres ; on l'approuve depuis l'admin (ou une autre app connectee).

const pending = new Map(); // secret -> { code, deviceId, deviceName, appName, appVersion, at, profileId }
const QC_TTL = 10 * 60e3;

function qcPurge() {
  const now = Date.now();
  for (const [k, v] of pending) if (now - v.at > QC_TTL) pending.delete(k);
}

function qcInitiate(info) {
  qcPurge();
  const secret = crypto.randomBytes(32).toString('hex');
  let code;
  do code = String(crypto.randomInt(0, 1e6)).padStart(6, '0');
  while ([...pending.values()].some((p) => p.code === code));
  const p = {
    code,
    deviceId: info.deviceid || '',
    deviceName: info.device || '',
    appName: info.client || '',
    appVersion: info.version || '',
    at: Date.now(),
    profileId: null
  };
  pending.set(secret, p);
  return qcDto(secret, p);
}

function qcDto(secret, p) {
  return {
    Authenticated: !!p.profileId,
    Secret: secret,
    Code: p.code,
    DeviceId: p.deviceId,
    DeviceName: p.deviceName,
    AppName: p.appName,
    AppVersion: p.appVersion,
    DateAdded: new Date(p.at).toISOString()
  };
}

function qcState(secret) {
  qcPurge();
  const p = pending.get(String(secret || ''));
  return p ? qcDto(secret, p) : null;
}

function qcAuthorize(code, profileId) {
  qcPurge();
  const c = String(code || '').replace(/\D/g, '');
  for (const p of pending.values()) {
    if (p.code === c && !p.profileId) {
      p.profileId = profileId;
      return true;
    }
  }
  return false;
}

/** Consomme un secret approuve : renvoie le profil, ou null. */
function qcConsume(secret) {
  const p = pending.get(String(secret || ''));
  if (!p || !p.profileId) return null;
  pending.delete(secret);
  return { profile: config.getProfile(p.profileId), info: { deviceid: p.deviceId, device: p.deviceName, client: p.appName, version: p.appVersion } };
}

module.exports = { parseAuth, createToken, attach, required, qcInitiate, qcState, qcAuthorize, qcConsume };
