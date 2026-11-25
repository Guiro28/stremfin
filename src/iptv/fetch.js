// Telechargements IPTV (listes M3U, API Xtream, guides XMLTV), sur le modele de Polyfin :
// requetes vers un meme serveur espacees d'une seconde au moins, reponse "trop de requetes"
// (429) redemandee deux fois au plus, taille limitee, gzip decompresse, proxy externe (WARP)
// pour une source en mode "warp". Les adresses (qui contiennent les identifiants) ne sont
// jamais ecrites dans le journal : seulement le schema et l'hote (voir redact).
const zlib = require('zlib');
const config = require('../config');
const { request } = require('../http');

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

/** Adresse sans identifiants pour l'interface et le journal : "http://hote:port". */
function redact(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return '?';
  }
}

// Derniere requete par serveur : une seconde d'ecart au moins.
const lastAt = new Map();
async function pace(host) {
  const prev = lastAt.get(host) || 0;
  const wait = prev + 1000 - Date.now();
  lastAt.set(host, Math.max(Date.now(), prev + 1000));
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Proxy externe a utiliser pour les listes d'une source (reseau "warp"), sinon sortie directe. */
function upstreamFor(source) {
  return source?.network === 'warp' ? config.get().settings.upstream : undefined;
}

/**
 * Ouvre une adresse et renvoie un flux lisible (decompresse si gzip), avec le code HTTP.
 * opts : source (user agent, reseau), timeout, headers.
 */
async function open(url, { source, timeout = 30000, headers = {}, tries = 3 } = {}) {
  const u = new URL(url);
  for (let attempt = 1; ; attempt++) {
    await pace(u.host);
    const { res } = await request(url, {
      upstream: upstreamFor(source),
      timeout,
      keepAlive: true,
      headers: { 'user-agent': source?.userAgent || BROWSER_UA, accept: '*/*', 'accept-encoding': 'gzip', ...headers }
    });
    const code = res.statusCode || 0;
    if (code === 429 && attempt < tries) {
      res.resume();
      const after = Number(res.headers['retry-after']);
      const wait = Number.isFinite(after) && after > 0 ? after * 1000 : 2000;
      if (wait > 30000) throw new Error('Le serveur demande de ralentir (trop de requêtes)');
      await sleep(wait);
      continue;
    }
    if (code === 429) {
      res.resume();
      throw new Error('Le serveur demande de ralentir (trop de requêtes)');
    }
    if (code >= 400) {
      res.resume();
      throw new Error(`HTTP ${code}`);
    }
    const gz = /gzip/i.test(res.headers['content-encoding'] || '') || /\.gz(\?|$)/i.test(u.pathname);
    let stream = res;
    if (gz) {
      stream = res.pipe(zlib.createGunzip());
      res.on('error', (e) => stream.destroy(e));
    }
    return { stream, res, code };
  }
}

/** Lit un flux en entier, au plus `max` octets (au-dela : erreur). */
function readLimited(stream, max) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    stream.on('data', (c) => {
      size += c.length;
      if (size > max) {
        stream.destroy();
        reject(new Error(`Réponse trop grande (plus de ${Math.round(max / 1e6)} Mo)`));
        return;
      }
      chunks.push(c);
    });
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

/** Texte entier d'une adresse (au plus `max` octets). */
async function text(url, opts = {}) {
  const { stream } = await open(url, opts);
  return (await readLimited(stream, opts.max || 100e6)).toString('utf8');
}

/** JSON d'une adresse (au plus `max` octets). */
async function json(url, opts = {}) {
  const body = await text(url, { max: 50e6, ...opts });
  try {
    return JSON.parse(body);
  } catch {
    throw new Error('Réponse illisible (pas du JSON)');
  }
}

/**
 * Lit un flux ligne par ligne (fin de ligne CRLF ou LF) et appelle onLine pour chacune.
 * S'arrete a `max` octets.
 */
function lines(stream, onLine, max = 100e6) {
  return new Promise((resolve, reject) => {
    let rest = '';
    let size = 0;
    let first = true;
    stream.setEncoding?.('utf8');
    stream.on('data', (chunk) => {
      size += chunk.length;
      if (size > max) {
        stream.destroy();
        reject(new Error(`Liste trop grande (plus de ${Math.round(max / 1e6)} Mo)`));
        return;
      }
      let s = rest + chunk;
      if (first) {
        s = s.replace(/^﻿/, '');
        first = false;
      }
      const parts = s.split(/\r?\n/);
      rest = parts.pop();
      try {
        for (const l of parts) onLine(l);
      } catch (e) {
        stream.destroy();
        reject(e);
      }
    });
    stream.on('end', () => {
      try {
        if (rest) onLine(rest);
        resolve();
      } catch (e) {
        reject(e);
      }
    });
    stream.on('error', reject);
  });
}

/** Adresse du reseau local (refusee pour une source ajoutee par un utilisateur). */
function isLocalAddress(url) {
  let host;
  try {
    host = new URL(url).hostname.replace(/^\[|\]$/g, '').toLowerCase();
  } catch {
    return false;
  }
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.lan') || host.endsWith('.home') || host.endsWith('.internal')) return true;
  if (/^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(host)) return true;
  const m = host.match(/^172\.(\d+)\./);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host)) return true;
  if (host === '::1' || /^f[cd][0-9a-f]{2}:/.test(host) || /^fe80:/.test(host)) return true;
  return false;
}

module.exports = { open, text, json, lines, readLimited, redact, upstreamFor, isLocalAddress, BROWSER_UA };
