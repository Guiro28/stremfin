// Relais des chaines IPTV, sur le modele de Polyfin (docs/live-tv.md, "How a channel plays") :
//   - flux MPEG-TS : une seule connexion au fournisseur par chaine, quel que soit le nombre de
//     lecteurs (apps, FFmpeg, analyse). Elle garde les 6 derniers Mo recus ; un nouveau lecteur
//     commence par la fin de ce tampon (sur un debut de paquet TS), un lecteur trop lent est
//     lache plutot que de retenir les autres. Elle reste ouverte 20 s apres le depart du dernier
//     lecteur, pour qu'un retour rapide sur la chaine demarre tout de suite ;
//   - flux HLS : listes du fournisseur relayees, leurs adresses (segments, sous-listes, cles)
//     remplacees par des adresses de Stremfin, impossibles a deviner ;
//   - limite de connexions d'un compte Xtream (max_connections) : pour ouvrir une chaine, on ferme
//     d'abord une chaine que plus personne ne regarde, puis la plus ancienne du meme profil ;
//     sinon, refus (les chaines des autres profils prennent toutes les connexions).
const crypto = require('crypto');
const config = require('../config');
const { request, readAll } = require('../http');
const fetchIptv = require('./fetch');

function log(...args) {
  console.log(new Date().toISOString(), '[live]', ...args);
}

const BUFFER = 6 * 1024 * 1024;
const GRACE = 20e3;
const SLOW = 8 * 1024 * 1024;
const HLS_ACTIVE = 20e3;

class LimitError extends Error {}

// ---- Sessions de lecture : jeton -> chaine, profil, mode ------------------------------

const sessions = new Map();
/** Cree une session de lecture (jeton des adresses de flux), gardee 12 h. */
function newSession({ channel, source, profileId, mode, name }) {
  const id = crypto.randomBytes(16).toString('hex');
  sessions.set(id, { id, channel, source, profileId, mode, name, at: Date.now() });
  return id;
}
function session(id) {
  const s = sessions.get(String(id || ''));
  if (s) s.at = Date.now();
  return s || null;
}
setInterval(() => {
  for (const [k, s] of sessions) if (Date.now() - s.at > 12 * 3600e3) sessions.delete(k);
  for (const [k, r] of rewritten) if (Date.now() - r.at > 10 * 60e3) rewritten.delete(k);
}, 60e3).unref();

function upstreamFor(mode) {
  return mode === 'warp' ? config.get().settings.upstream : undefined;
}

function headersFor(channel, source) {
  return { 'user-agent': channel.headers?.['user-agent'] || source?.userAgent || fetchIptv.BROWSER_UA, accept: '*/*', ...(channel.headers || {}) };
}

// ---- Connexions ouvertes par source (limite du compte) --------------------------------

const feeds = new Map(); // "source|cle" -> Feed
const hlsActive = new Map(); // "source|cle" -> { at, profileId }

function limitOf(source) {
  return Number(source?.account?.maxConnections) || 0;
}

function connectionsOf(sourceId) {
  const now = Date.now();
  let n = 0;
  for (const f of feeds.values()) if (f.source.id === sourceId && !f.closed) n++;
  for (const [k, h] of hlsActive) {
    if (now - h.at > HLS_ACTIVE) hlsActive.delete(k);
    else if (k.startsWith(sourceId + '|') && !feeds.has(k)) n++;
  }
  return n;
}

/** Fait de la place pour une nouvelle chaine sur un compte limite, ou leve LimitError. */
function makeRoom(source, profileId, key) {
  const max = limitOf(source);
  if (!max) return;
  if (connectionsOf(source.id) < max) return;
  // 1. une chaine que plus personne ne regarde (dans ses 20 s de grace)
  const idle = [...feeds.values()].filter((f) => f.source.id === source.id && f.key !== key && !f.readers.size && !f.recorders);
  if (idle.length) {
    idle[0].close('place libérée pour une autre chaîne');
    return;
  }
  // 2. la plus ancienne chaine du meme profil
  // (une chaine en cours d'enregistrement n'est jamais fermee)
  const mine = [...feeds.values()].filter((f) => f.source.id === source.id && f.key !== key && f.profileId === profileId && !f.recorders).sort((a, b) => a.openedAt - b.openedAt);
  if (mine.length) {
    mine[0].close('remplacée par une autre chaîne du même profil');
    return;
  }
  for (const [k, h] of hlsActive) {
    if (k.startsWith(source.id + '|') && k !== key && h.profileId === profileId && !h.rec) {
      hlsActive.delete(k);
      return;
    }
  }
  throw new LimitError(`Toutes les connexions du compte sont utilisées (${max})`);
}

class Feed {
  constructor(key, channel, source, mode, profileId) {
    this.key = key;
    this.channel = channel;
    this.source = source;
    this.mode = mode;
    this.profileId = profileId;
    this.readers = new Set();
    this.recorders = 0;
    this.chunks = [];
    this.size = 0;
    this.closed = false;
    this.openedAt = Date.now();
    this.graceTimer = null;
    this.ready = this.start();
  }

  async start() {
    const { res } = await request(this.channel.url, { upstream: upstreamFor(this.mode), headers: headersFor(this.channel, this.source), timeout: 20000, keepAlive: true });
    const code = res.statusCode || 0;
    const type = String(res.headers['content-type'] || '').toLowerCase();
    if (code >= 400 || /text\/html|application\/json/.test(type)) {
      res.resume();
      throw new Error(code >= 400 ? `le fournisseur répond ${code}` : "le fournisseur n'envoie pas de vidéo");
    }
    this.origin = res;
    res.on('data', (c) => this.push(c));
    res.on('end', () => this.close('fin du flux'));
    res.on('error', (e) => this.close(e.message));
    return this;
  }

  push(chunk) {
    this.chunks.push(chunk);
    this.size += chunk.length;
    while (this.size > BUFFER && this.chunks.length > 1) this.size -= this.chunks.shift().length;
    require('../stats').addBytes?.(this.channel.uuid, this.profileId, chunk.length);
    for (const r of this.readers) {
      if (r.writableLength > SLOW) {
        r.destroy();
        this.readers.delete(r);
        continue;
      }
      r.write(chunk);
    }
  }

  /** Fin du tampon (2 Mo au plus) a partir d'un debut de paquet TS. */
  tail() {
    const buf = Buffer.concat(this.chunks);
    let start = Math.max(0, buf.length - 2 * 1024 * 1024);
    while (start < buf.length - 188 * 3 && !(buf[start] === 0x47 && buf[start + 188] === 0x47 && buf[start + 376] === 0x47)) start++;
    return start < buf.length - 188 * 3 ? buf.subarray(start) : Buffer.alloc(0);
  }

  addReader(res) {
    clearTimeout(this.graceTimer);
    const t = this.tail();
    if (t.length) res.write(t);
    this.readers.add(res);
    res.on('close', () => {
      this.readers.delete(res);
      if (!this.readers.size && !this.closed) {
        clearTimeout(this.graceTimer);
        this.graceTimer = setTimeout(() => this.close('plus de spectateur'), this.mode === 'none' ? 1000 : GRACE);
        this.graceTimer.unref?.();
      }
    });
  }

  close(why) {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.graceTimer);
    try {
      this.origin?.destroy();
    } catch {}
    for (const r of this.readers) r.end();
    this.readers.clear();
    if (feeds.get(this.key) === this) feeds.delete(this.key);
    log(`${this.channel.name} : connexion fermée (${why})`);
  }
}

/** Ouvre (ou rejoint) la connexion d'une chaine MPEG-TS. */
async function feedFor(sess, channel, source) {
  const key = `${source.id}|${channel.key}`;
  let f = feeds.get(key);
  if (f && !f.closed) {
    await f.ready;
    return f;
  }
  makeRoom(source, sess.profileId, key);
  f = new Feed(key, channel, source, sess.mode, sess.profileId);
  feeds.set(key, f);
  try {
    await f.ready;
  } catch (e) {
    f.close(e.message);
    throw e;
  }
  log(`${channel.name} : connexion ouverte (${fetchIptv.redact(channel.url)}${limitOf(source) ? `, ${connectionsOf(source.id)}/${limitOf(source)} connexions` : ''})`);
  return f;
}

/** Sert le flux MPEG-TS d'une chaine a un lecteur. */
async function serveTs(req, res, sess, channel, source) {
  const f = await feedFor(sess, channel, source);
  // Lecteur d'un enregistrement : la chaine est protegee tant qu'il lit.
  if (req.query?.rec === '1') {
    f.recorders++;
    res.on('close', () => (f.recorders = Math.max(0, f.recorders - 1)));
  }
  res.status(200);
  res.setHeader('Content-Type', 'video/mp2t');
  res.setHeader('Cache-Control', 'no-store');
  res.flushHeaders?.();
  f.addReader(res);
}

// ---- HLS du fournisseur relaye ----------------------------------------------------------

const rewritten = new Map(); // id -> { url, at }
function hide(url) {
  const id = crypto.randomBytes(12).toString('hex');
  rewritten.set(id, { url, at: Date.now() });
  return id;
}

/** Liste HLS du fournisseur, ses adresses remplacees par des adresses de Stremfin. */
async function servePlaylist(req, res, sess, channel, source, url, base) {
  const key = `${source.id}|${channel.key}`;
  if (!hlsActive.has(key) && !feeds.has(key)) makeRoom(source, sess.profileId, key);
  hlsActive.set(key, { at: Date.now(), profileId: sess.profileId, rec: req.query?.rec === '1' || hlsActive.get(key)?.rec });
  const { res: r, finalUrl } = await request(url, { upstream: upstreamFor(sess.mode), headers: headersFor(channel, source), timeout: 20000 });
  const body = (await readAll(r)).toString('utf8').replace(/^﻿/, '');
  if ((r.statusCode || 0) >= 400 || !body.trimStart().startsWith('#EXTM3U')) throw new Error(`liste HLS illisible (${r.statusCode})`);
  const abs = (u) => new URL(u, finalUrl).toString();
  const link = (u) => {
    const target = abs(u);
    const isList = /\.m3u8(\?|$)/i.test(new URL(target).pathname);
    const ext = isList ? 'm3u8' : (new URL(target).pathname.match(/\.(ts|aac|mp4|m4s|vtt|key)$/i)?.[1] || 'ts').toLowerCase();
    return `${base}/${isList ? 'p' : 'f'}/${hide(target)}.${ext}?ls=${sess.id}`;
  };
  const out = body
    .split(/\r?\n/)
    .map((line) => {
      if (!line) return line;
      if (line.startsWith('#')) return line.replace(/URI="([^"]+)"/g, (_, u) => `URI="${link(u)}"`);
      return link(line.trim());
    })
    .join('\n');
  res.type('application/vnd.apple.mpegurl').setHeader('Cache-Control', 'no-store');
  res.send(out);
}

/** Sous-liste HLS (variante d'une liste principale) relayee. */
async function servePlaylistById(req, res, sess, channel, source, id, base) {
  const hit = rewritten.get(String(id));
  if (!hit) return res.status(404).end();
  hit.at = Date.now();
  return servePlaylist(req, res, sess, channel, source, hit.url, base);
}

/** Fichier relaye (segment, cle) d'une liste HLS. */
async function serveHidden(req, res, sess, channel, source, id) {
  const hit = rewritten.get(String(id));
  if (!hit) return res.status(404).end();
  hlsActive.set(`${source.id}|${channel.key}`, { at: Date.now(), profileId: sess.profileId });
  const { res: r } = await request(hit.url, { upstream: upstreamFor(sess.mode), headers: headersFor(channel, source), timeout: 20000, keepAlive: true });
  res.status(r.statusCode || 502);
  // Segment deguise en image par certains fournisseurs : on l'annonce comme video.
  const type = String(r.headers['content-type'] || '');
  res.setHeader('Content-Type', /image\/|octet|text\/plain/.test(type) || !type ? 'video/mp2t' : type);
  if (r.headers['content-length']) res.setHeader('Content-Length', r.headers['content-length']);
  res.setHeader('Cache-Control', 'no-store');
  req.on('close', () => r.destroy());
  r.on('data', (c) => require('../stats').addBytes?.(channel.uuid, sess.profileId, c.length));
  r.pipe(res);
}

/**
 * Replay : reserve une connexion du compte pour un programme (refus si toutes sont prises par
 * d'autres profils), puis la garde tant que le programme est lu (touch a chaque requete).
 */
function reserve(source, profileId, key) {
  if (!hlsActive.has(key)) makeRoom(source, profileId, key);
  hlsActive.set(key, { at: Date.now(), profileId });
}
function touch(key, profileId) {
  hlsActive.set(key, { at: Date.now(), profileId });
}

/** Ferme les connexions d'une source (source retiree ou modifiee). */
function closeSource(sourceId) {
  for (const f of [...feeds.values()]) if (f.source.id === sourceId) f.close('source modifiée');
}

/** Chaines ouvertes (pour l'admin). */
function list() {
  return [...feeds.values()].map((f) => ({ channel: f.channel.name, source: f.source.name, readers: f.readers.size, since: f.openedAt, profileId: f.profileId }));
}

module.exports = { reserve, touch, newSession, session, serveTs, servePlaylist, servePlaylistById, serveHidden, closeSource, list, connectionsOf, limitOf, LimitError };
