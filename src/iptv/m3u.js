// Lecture d'une liste M3U (IPTV), au fil de l'eau, sur le modele de Polyfin (internal/iptv/m3u.go)
// et de Jellyfin (M3uParser.cs) :
//   #EXTM3U url-tvg="..." x-tvg-url="..."   guides XMLTV de la liste
//   #EXTINF:-1 tvg-id="" tvg-name="" tvg-logo="" tvg-chno="" group-title="" catchup="" ...,Nom
//   #EXTGRP:Groupe                           groupe, quand l'entree n'a pas de group-title
//   #EXTVLCOPT:http-user-agent=...           en-tetes de la requete du flux
//   #EXTHTTP:{"User-Agent":"..."}
//   adresse|User-Agent=...&Referer=...       en-tetes en fin d'adresse
// Les valeurs peuvent etre entre guillemets doubles, simples, ou sans. Les intertitres decoratifs
// ("##### FR #####", "=== SPORT ===") sont ignores. Les entrees de films et series (adresses
// Xtream /movie/ et /series/, ou fichiers video) sont mises a part pour la VOD.
const fetch = require('./fetch');

const MAX_BYTES = 100e6;
const MAX_ENTRIES = 100000;

/** Attributs cle=valeur d'un morceau de ligne (guillemets doubles, simples, ou sans). */
function attrs(s) {
  const out = {};
  const re = /([A-Za-z0-9_-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"',]*))/g;
  let m;
  while ((m = re.exec(s))) out[m[1].toLowerCase()] = (m[2] ?? m[3] ?? m[4] ?? '').trim();
  return out;
}

/** Coupe "#EXTINF:-1 a="x, y",Nom" en attributs et nom : la virgule hors guillemets. */
function splitExtinf(line) {
  const body = line.slice(line.indexOf(':') + 1);
  let quote = null;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      // Une apostrophe dans un mot ("l'equipe") n'ouvre pas de guillemet.
      if (c === '"' || /[=\s]/.test(body[i - 1] || ' ')) quote = c;
    } else if (c === ',') {
      return { attrs: attrs(body.slice(0, i)), name: body.slice(i + 1).trim() };
    }
  }
  return { attrs: attrs(body), name: '' };
}

/** Intertitre de liste plutot qu'une chaine : aucune lettre ni chiffre, ou decor de 3 signes ou plus. */
function isHeading(name) {
  if (!/[\p{L}\p{N}]/u.test(name)) return true;
  return /([#=*~_\-•★▬▀▄█|])\1{2,}/u.test(name);
}

/** "adresse|User-Agent=x&Referer=y" -> { url, headers }. */
function splitUrl(raw) {
  const i = raw.indexOf('|');
  if (i < 0) return { url: raw.trim(), headers: {} };
  const headers = {};
  for (const part of raw.slice(i + 1).split('&')) {
    const j = part.indexOf('=');
    if (j > 0) {
      const k = decodeURIComponent(part.slice(0, j).trim()).toLowerCase();
      const v = decodeURIComponent(part.slice(j + 1).trim());
      if (k && v) headers[k] = v;
    }
  }
  return { url: raw.slice(0, i).trim(), headers };
}

const VOD_EXT = /\.(mp4|mkv|avi|mov|m4v|wmv|flv|webm)(\?|$)/i;

/** Nature d'une entree : chaine (live), film ou episode de serie (VOD). */
function kindOf(url, attr) {
  const t = String(attr['tvg-type'] || attr.type || '').toLowerCase();
  if (t === 'movie' || t === 'movies' || t === 'vod') return 'movie';
  if (t === 'series' || t === 'serie') return 'series';
  if (/\/movie\//i.test(url)) return 'movie';
  if (/\/series\//i.test(url)) return 'series';
  if (VOD_EXT.test(url)) return 'movie';
  return 'live';
}

/**
 * Lit une liste depuis une adresse (ou un texte deja telecharge). Renvoie
 * { guides: [url], entries: [{ kind, name, tvgId, tvgName, logo, number, group, url, headers, catchup }] }.
 */
async function parse({ url, body, source }) {
  const guides = [];
  const entries = [];
  let pending = null;
  let group = '';
  let headers = {};
  const onLine = (raw) => {
    const line = raw.trim();
    if (!line) return;
    if (line.startsWith('#EXTM3U')) {
      const a = attrs(line.slice(7));
      for (const k of ['url-tvg', 'x-tvg-url', 'tvg-url']) {
        if (a[k]) for (const g of a[k].split(',')) if (/^https?:\/\//i.test(g.trim())) guides.push(g.trim());
      }
      return;
    }
    if (/^#EXTINF/i.test(line)) {
      const { attrs: a, name } = splitExtinf(line);
      pending = { a, name: name || a['tvg-name'] || '' };
      group = '';
      headers = {};
      // En-tetes donnes en attributs de l'entree.
      if (a['http-user-agent'] || a['user-agent']) headers['user-agent'] = a['http-user-agent'] || a['user-agent'];
      if (a['http-referrer'] || a['http-referer'] || a.referer) headers.referer = a['http-referrer'] || a['http-referer'] || a.referer;
      return;
    }
    if (/^#EXTGRP:/i.test(line)) {
      group = line.slice(8).trim();
      return;
    }
    if (/^#EXTVLCOPT:/i.test(line)) {
      const opt = line.slice(11);
      const j = opt.indexOf('=');
      if (j > 0) {
        const k = opt.slice(0, j).trim().toLowerCase();
        const v = opt.slice(j + 1).trim();
        if (k === 'http-user-agent') headers['user-agent'] = v;
        else if (k === 'http-referrer' || k === 'http-referer') headers.referer = v;
        else if (k === 'http-origin') headers.origin = v;
      }
      return;
    }
    if (/^#EXTHTTP:/i.test(line)) {
      try {
        const o = JSON.parse(line.slice(9));
        for (const [k, v] of Object.entries(o || {})) if (typeof v === 'string') headers[k.toLowerCase()] = v;
      } catch {}
      return;
    }
    if (line.startsWith('#')) return;
    // Adresse du flux : termine l'entree en cours.
    if (!pending) return;
    if (entries.length >= MAX_ENTRIES) throw new Error(`Liste trop grande (plus de ${MAX_ENTRIES} entrées)`);
    const { a, name } = pending;
    pending = null;
    const { url: streamUrl, headers: urlHeaders } = splitUrl(line);
    if (!/^(https?|rtmp|rtsp|udp|rtp):\/\//i.test(streamUrl)) return;
    if (!name || isHeading(name)) return;
    const number = a['tvg-chno'] || a['channel-number'] || a['tvg-channel-no'] || '';
    const days = Number(a['catchup-days'] || a['timeshift'] || a['tvg-rec'] || 0);
    entries.push({
      kind: kindOf(streamUrl, a),
      name,
      tvgId: a['tvg-id'] || '',
      tvgName: a['tvg-name'] || '',
      logo: /^https?:\/\//i.test(a['tvg-logo'] || '') ? a['tvg-logo'] : '',
      number: /^\d+(\.\d+)?$/.test(number) ? number : '',
      group: a['group-title'] || group || '',
      url: streamUrl,
      headers: { ...headers, ...urlHeaders },
      catchup: a.catchup || a['catchup-type'] ? { mode: (a.catchup || a['catchup-type']).toLowerCase(), days: Number.isFinite(days) ? days : 0, source: a['catchup-source'] || '' } : days > 0 ? { mode: 'default', days, source: a['catchup-source'] || '' } : null
    });
  };
  if (typeof body === 'string') {
    body.replace(/^﻿/, '').split(/\r?\n/).forEach(onLine);
  } else {
    const { stream } = await fetch.open(url, { source, timeout: 60000 });
    await fetch.lines(stream, onLine, MAX_BYTES);
  }
  return { guides: [...new Set(guides)], entries };
}

module.exports = { parse, attrs, splitExtinf, isHeading, kindOf };
