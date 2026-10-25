// Authentification de l'interface d'administration : compte unique (cree au premier
// lancement), sessions par cookie, limite de tentatives et protection CSRF.
const crypto = require('crypto');
const express = require('express');
const config = require('./config');
const { st } = require('./db');
const { sha256, passwordProblem, verifyPassword } = require('./security');

const COOKIE = 'stremfin_admin';
const SESSION_TTL = 30 * 24 * 3600e3;
const MAX_FAILURES = 10;
const BLOCK_MS = 15 * 60e3;

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function cookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function isHttps(req) {
  return req.secure || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}

function setCookie(req, res, value, maxAgeMs) {
  const parts = [
    `${COOKIE}=${value}`,
    'Path=/stremfin/api',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`
  ];
  if (isHttps(req)) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

/**
 * Session de l'interface web : role "admin" (tout) ou "user" (son propre profil seulement).
 * Une session utilisateur tombe si le profil est supprime, desactive ou sans mot de passe.
 */
function currentSession(req) {
  const token = cookies(req)[COOKIE];
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
  const row = st.adminSessionGet.get(sha256(token), Date.now());
  if (!row) return null;
  if (row.role === 'user') {
    const p = config.getProfile(row.profile);
    if (!p || p.disabled || !p.passwordHash) return null;
    return { ...row, token, username: p.name };
  }
  return { ...row, token, username: config.get().admin?.username };
}

function openSession(req, res, role = 'admin', profileId = null) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  st.adminSessionPut.run(sha256(token), now, now + SESSION_TTL, req.ip || '', String(req.headers['user-agent'] || '').slice(0, 200), role, profileId);
  setCookie(req, res, token, SESSION_TTL);
}

// ---- Limite de tentatives (par adresse IP) ---------------------------------------

const failures = new Map();

function blocked(ip) {
  const f = failures.get(ip);
  return f && f.count >= MAX_FAILURES && Date.now() < f.until;
}

function recordFailure(ip) {
  const now = Date.now();
  const f = failures.get(ip);
  const next = f && now < f.until ? { count: f.count + 1, until: f.until } : { count: 1, until: now + BLOCK_MS };
  if (next.count >= MAX_FAILURES) next.until = now + BLOCK_MS;
  failures.set(ip, next);
}

// ---- Middlewares -------------------------------------------------------------------

/** API : session valide + en-tete anti-CSRF sur toute requete qui modifie. */
function requireApi(req, res, next) {
  const s = currentSession(req);
  if (!s) return res.status(401).json({ error: 'Session expirée, reconnecte-toi' });
  if (!['GET', 'HEAD'].includes(req.method) && req.headers['x-stremfin'] !== '1') {
    return res.status(403).json({ error: 'Requête refusée' });
  }
  req.adminSession = s;
  req.role = s.role;
  req.sessionProfileId = s.role === 'user' ? s.profile : null;
  next();
}

/** Routes reservees a l'administrateur. */
function requireAdmin(req, res, next) {
  if (req.role !== 'admin') return res.status(403).json({ error: "Réservé à l'administrateur" });
  next();
}

// ---- Routes ------------------------------------------------------------------------

const router = express.Router();

router.use((req, res, next) => {
  // Les reponses de l'admin ne doivent jamais etre mises en cache ni affichees dans un cadre.
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
});

router.get('/status', (req, res) => {
  const s = currentSession(req);
  res.json({
    setup: !config.hasAdmin(),
    authenticated: !!s,
    role: s?.role || null,
    username: s?.username || null,
    profileId: s?.role === 'user' ? s.profile : null,
    web: !!req.app.locals.hasWeb
  });
});

router.post('/setup', (req, res) => {
  if (config.hasAdmin()) return res.status(409).json({ error: 'Le compte admin existe déjà' });
  if (req.headers['x-stremfin'] !== '1') return res.status(403).json({ error: 'Requête refusée' });
  try {
    config.setAdmin(req.body?.username, req.body?.password);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  log(`[admin] compte admin cree : ${config.get().admin.username}`);
  openSession(req, res);
  res.json({ ok: true });
});

router.post('/login', (req, res) => {
  const ip = req.ip || '?';
  if (req.headers['x-stremfin'] !== '1') return res.status(403).json({ error: 'Requête refusée' });
  if (blocked(ip)) return res.status(429).json({ error: 'Trop de tentatives, réessaie dans 15 minutes' });
  // Compte admin, sinon compte d'un profil (acces a son seul profil).
  if (config.checkAdmin(req.body?.username, req.body?.password)) {
    failures.delete(ip);
    openSession(req, res, 'admin');
    log(`[admin] connexion admin depuis ${ip}`);
    return res.json({ ok: true, role: 'admin' });
  }
  const p = config.findProfileByName(req.body?.username);
  if (p && !p.disabled && p.passwordHash && verifyPassword(req.body?.password, p.passwordHash)) {
    failures.delete(ip);
    openSession(req, res, 'user', p.id);
    log(`[admin] connexion de ${p.name} (espace utilisateur) depuis ${ip}`);
    return res.json({ ok: true, role: 'user', profileId: p.id });
  }
  recordFailure(ip);
  log(`[admin] echec de connexion depuis ${ip}`);
  res.status(401).json({ error: 'Identifiants incorrects' });
});

router.post('/logout', (req, res) => {
  const s = currentSession(req);
  if (s) st.adminSessionDel.run(s.token_hash);
  setCookie(req, res, '', 0);
  res.json({ ok: true });
});

router.get('/sessions', requireApi, requireAdmin, (req, res) => {
  res.json(
    st.adminSessionList.all(Date.now()).map((s) => ({
      id: s.token_hash.slice(0, 12),
      current: s.token_hash === req.adminSession.token_hash,
      created: s.created,
      expires: s.expires,
      ip: s.ip,
      userAgent: s.user_agent
    }))
  );
});

router.delete('/sessions/others', requireApi, requireAdmin, (req, res) => {
  st.adminSessionDelOthers.run(req.adminSession.token_hash);
  res.json({ ok: true });
});

/** Changement du nom et/ou du mot de passe admin : le mot de passe actuel est exige. */
router.put('/account', requireApi, requireAdmin, (req, res) => {
  const b = req.body || {};
  const admin = config.get().admin;
  if (!config.checkAdmin(admin.username, b.currentPassword)) return res.status(401).json({ error: 'Mot de passe actuel incorrect' });
  try {
    if (b.newPassword) {
      const problem = passwordProblem(b.newPassword);
      if (problem) throw new Error(problem);
      config.setAdmin(b.username || admin.username, b.newPassword);
      // Nouveau mot de passe : toutes les autres sessions sont fermees.
      st.adminSessionDelOthers.run(req.adminSession.token_hash);
    } else if (b.username && b.username !== admin.username) {
      config.renameAdmin(b.username);
    }
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  res.json({ ok: true, username: config.get().admin.username });
});

setInterval(() => {
  try { st.adminSessionPurge.run(Date.now()); } catch {}
}, 3600e3).unref();

module.exports = { router, requireApi, requireAdmin, currentSession };
