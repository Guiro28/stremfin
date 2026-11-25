// Guides des programmes (XMLTV), sur le modele de Polyfin (docs/live-tv.md, "XMLTV guides") :
//   - guides d'une source : celui du fournisseur (xmltv.php d'un compte Xtream, url-tvg d'une
//     liste M3U) et ceux ajoutes a la main, dans l'ordre (le premier qui a la chaine gagne) ;
//   - lecture au fil de l'eau (.xml ou .xml.gz, 500 Mo decompresses au plus) : chaines du guide,
//     puis programmes, gardes de 7 jours passes (replay) a 8 jours a venir. Seuls les programmes
//     des chaines associees sont gardes (plus ce qui passe dans les 3 h, pour l'association a la
//     main) : un guide de fournisseur couvre souvent des dizaines de milliers de chaines ;
//   - association automatique : tvg-id (ou epg_channel_id) egal a l'id du guide, sinon nom
//     normalise (sans accents, prefixe pays, qualite) ; association a la main (custom_epg).
const crypto = require('crypto');
const { db, transaction } = require('../db');
const fetchIptv = require('./fetch');
const xtream = require('./xtream');

function log(...args) {
  console.log(new Date().toISOString(), '[epg]', ...args);
}

const PAST = 7 * 864e5;
const FUTURE = 8 * 864e5;
const MAX_BYTES = 500e6;

const q = {
  chanDel: db.prepare('DELETE FROM epg_channels WHERE guide = ?'),
  chanPut: db.prepare('INSERT OR REPLACE INTO epg_channels (guide, id, names, icon) VALUES (?, ?, ?, ?)'),
  progDel: db.prepare('DELETE FROM epg_programs WHERE guide = ?'),
  progPut: db.prepare(`INSERT OR REPLACE INTO epg_programs (guide, channel, start, stop, title, subtitle, descr, categories, icon, season, episode, rerun)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  channelsOf: db.prepare('SELECT id, names, icon FROM epg_channels WHERE guide = ?'),
  between: db.prepare('SELECT * FROM epg_programs WHERE guide = ? AND channel = ? AND stop > ? AND start < ? ORDER BY start'),
  at: db.prepare('SELECT * FROM epg_programs WHERE guide = ? AND channel = ? AND start <= ? AND stop > ? LIMIT 1'),
  one: db.prepare('SELECT * FROM epg_programs WHERE guide = ? AND channel = ? AND start = ?'),
  counts: db.prepare('SELECT COUNT(*) AS n FROM epg_programs WHERE guide = ?'),
  chanCount: db.prepare('SELECT COUNT(*) AS n FROM epg_channels WHERE guide = ?'),
  sourceChannels: db.prepare('SELECT key, name, custom_name, epg_id, custom_epg, epg_guide, epg_channel FROM iptv_channels WHERE source = ?'),
  setMap: db.prepare('UPDATE iptv_channels SET epg_guide = ?, epg_channel = ? WHERE source = ? AND key = ?')
};

/** Empreinte d'une adresse de guide (les adresses contiennent souvent les identifiants). */
function guideId(url) {
  return crypto.createHash('sha1').update(String(url)).digest('hex').slice(0, 16);
}

/** Guides d'une source, dans l'ordre : [{ id, url, provider }]. */
function guidesOf(src) {
  const out = [];
  if (src.useProviderGuide !== false) {
    if (src.kind === 'xtream') out.push({ url: xtream.guideUrl(src), provider: true });
    else for (const u of src.listGuides || []) out.push({ url: u, provider: true });
  }
  for (const u of src.epgUrls || []) out.push({ url: u, provider: false });
  const seen = new Set();
  return out.map((g) => ({ ...g, id: guideId(g.url) })).filter((g) => !seen.has(g.id) && seen.add(g.id));
}

// ---- Noms normalises (association par nom) ----------------------------------------------

const QUALITY = /\b(uhd|fhd|hd|sd|4k|8k|hevc|h265|h264|hdr|1080[pi]?|720p|576[pi]|540p|480p|360p|backup|multi|vip|\+1)\b/g;
function normName(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\[[^\]]*\]|\([^)]*\)/g, ' ')
    .replace(/^\s*[a-z]{2,3}\s*[|:\-]\s*/, '')
    .replace(QUALITY, ' ')
    .replace(/[^a-z0-9+]+/g, '');
}

// ---- Lecture XMLTV -------------------------------------------------------------------------

function decode(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .trim();
}

function attr(tag, name) {
  const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i'));
  return m ? decode(m[2] ?? m[3]) : '';
}

function texts(block, tag) {
  const out = [];
  const re = new RegExp(`<${tag}(\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'gi');
  let m;
  while ((m = re.exec(block))) out.push({ attrs: m[1] || '', text: decode(m[2]) });
  return out;
}

/** "20261122203000 +0100" -> ms (sans decalage : UTC). */
function xmltvTime(s) {
  const m = String(s || '').match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?\s*([+-]\d{2}):?(\d{2})?/);
  if (!m) return NaN;
  const utc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  const off = m[7] ? (Number(m[7]) * 60 + Math.sign(Number(m[7]) || 1) * Number(m[8] || 0)) * 60e3 : 0;
  return utc - off;
}

/** Saison et episode : xmltv_ns ("1.4." = S2 E5, compte a partir de 0) ou "S02E05". */
function episodeOf(block) {
  let season = null;
  let episode = null;
  for (const e of texts(block, 'episode-num')) {
    const sys = attr(e.attrs, 'system').toLowerCase();
    if (sys === 'xmltv_ns') {
      const [s, ep] = e.text.split('.');
      const sn = parseInt(s, 10);
      const en = parseInt(ep, 10);
      if (Number.isFinite(sn)) season = sn + 1;
      if (Number.isFinite(en)) episode = en + 1;
    } else {
      const m = e.text.match(/S(\d+)\s*E(\d+)/i);
      if (m) {
        season = season ?? Number(m[1]);
        episode = episode ?? Number(m[2]);
      }
    }
  }
  return { season, episode };
}

/**
 * Lit un guide en flux. onChannels(list) est appele une fois les chaines lues (avant le premier
 * programme) et renvoie l'ensemble des ids de chaines dont on garde tous les programmes.
 */
async function readGuide(url, src, onChannels, onProgram) {
  const { stream } = await fetchIptv.open(url, { source: src, timeout: 120000 });
  return new Promise((resolve, reject) => {
    let buf = '';
    let size = 0;
    let channels = [];
    let keep = null;
    let programs = 0;
    const flushChannels = () => {
      if (keep === null) keep = onChannels(channels) || new Set();
    };
    const work = (final) => {
      for (;;) {
        const ci = buf.indexOf('<channel');
        const pi = buf.indexOf('<programme');
        if (ci < 0 && pi < 0) {
          // Rien d'ouvert : on garde la fin (un debut de balise coupe).
          buf = buf.slice(-20);
          return;
        }
        const isProg = pi >= 0 && (ci < 0 || pi < ci);
        const start = isProg ? pi : ci;
        const close = isProg ? '</programme>' : '</channel>';
        const end = buf.indexOf(close, start);
        const selfEnd = buf.indexOf('/>', start);
        const tagEnd = buf.indexOf('>', start);
        let block;
        let next;
        if (tagEnd > 0 && selfEnd >= 0 && selfEnd + 1 === tagEnd) {
          block = buf.slice(start, tagEnd + 1);
          next = tagEnd + 1;
        } else if (end >= 0) {
          block = buf.slice(start, end + close.length);
          next = end + close.length;
        } else {
          buf = buf.slice(start);
          if (final) return;
          return;
        }
        buf = buf.slice(next);
        const open = block.slice(0, block.indexOf('>') + 1);
        if (!isProg) {
          const id = attr(open, 'id');
          if (id) channels.push({ id, names: texts(block, 'display-name').map((x) => x.text).filter(Boolean), icon: (block.match(/<icon[^>]*\ssrc\s*=\s*["']([^"']+)["']/i) || [])[1] || null });
          continue;
        }
        flushChannels();
        const p = { channel: attr(open, 'channel'), start: xmltvTime(attr(open, 'start')), stop: xmltvTime(attr(open, 'stop')) };
        if (!p.channel || !Number.isFinite(p.start)) continue;
        if (!Number.isFinite(p.stop) || p.stop <= p.start) p.stop = p.start + 30 * 60e3;
        p.block = block;
        if (onProgram(p, keep)) programs++;
      }
    };
    stream.setEncoding?.('utf8');
    stream.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BYTES) {
        stream.destroy();
        reject(new Error('Guide trop grand (plus de 500 Mo)'));
        return;
      }
      buf += chunk;
      try {
        work(false);
      } catch (e) {
        stream.destroy();
        reject(e);
      }
    });
    stream.on('end', () => {
      try {
        work(true);
        flushChannels();
        resolve({ channels: channels.length, programs });
      } catch (e) {
        reject(e);
      }
    });
    stream.on('error', reject);
  });
}

function programRow(guide, p) {
  const block = p.block;
  const title = texts(block, 'title')[0]?.text || '';
  const sub = texts(block, 'sub-title')[0]?.text || null;
  const desc = texts(block, 'desc')[0]?.text || null;
  const cats = texts(block, 'category').map((c) => c.text).filter(Boolean);
  const icon = (block.match(/<icon[^>]*\ssrc\s*=\s*["']([^"']+)["']/i) || [])[1] || null;
  const { season, episode } = episodeOf(block);
  const rerun = /<previously-shown/i.test(block) ? 1 : 0;
  return [guide, p.channel, p.start, p.stop, title || '?', sub, desc, cats.length ? JSON.stringify(cats) : null, icon && /^https?:/i.test(icon) ? icon : null, season, episode, rerun];
}

// ---- Telechargement d'un guide pour les sources qui l'utilisent -------------------------------

const running = new Map();

/**
 * Telecharge un guide et remplace ses chaines et programmes. sources : celles qui l'utilisent
 * (associations recalculees des que ses chaines sont lues).
 */
function downloadGuide(guide, sources) {
  if (running.has(guide.id)) return running.get(guide.id);
  const job = (async () => {
    const t0 = Date.now();
    const now = Date.now();
    const from = now - PAST;
    const to = now + FUTURE;
    const soonFrom = now - 3600e3;
    const soonTo = now + 3 * 3600e3;
    let batch = [];
    const flush = () => {
      if (!batch.length) return;
      const rows = batch;
      batch = [];
      transaction(() => rows.forEach((r) => q.progPut.run(...r)));
    };
    let started = false;
    const res = await readGuide(
      guide.url,
      sources[0],
      (channels) => {
        // Chaines du guide remplacees, associations recalculees, puis ce qu'on garde.
        transaction(() => {
          q.chanDel.run(guide.id);
          q.progDel.run(guide.id);
          for (const c of channels) q.chanPut.run(guide.id, c.id, JSON.stringify(c.names), c.icon);
        });
        started = true;
        const keep = new Set();
        for (const s of sources) {
          mapSource(s);
          for (const r of q.sourceChannels.all(s.id)) if (r.epg_guide === guide.id && r.epg_channel) keep.add(r.epg_channel);
        }
        return keep;
      },
      (p, keep) => {
        if (p.stop < from || p.start > to) return false;
        const soon = p.stop > soonFrom && p.start < soonTo;
        if (!keep.has(p.channel) && !soon) return false;
        batch.push(programRow(guide.id, p));
        if (batch.length >= 2000) flush();
        return true;
      }
    );
    flush();
    if (!started) throw new Error('Guide vide ou illisible');
    log(`${fetchIptv.redact(guide.url)} : ${res.channels} chaînes, ${res.programs} programmes gardés (${Math.round((Date.now() - t0) / 1000)} s)`);
    return res;
  })().finally(() => running.delete(guide.id));
  running.set(guide.id, job);
  return job;
}

/** Telecharge tous les guides d'une source ; etat de chacun dans src.guideStatus. */
async function refreshSource(src, allSources = [src]) {
  const guides = guidesOf(src);
  src.guideStatus = src.guideStatus || {};
  for (const g of guides) {
    const users = allSources.filter((s) => guidesOf(s).some((x) => x.id === g.id));
    try {
      const r = await downloadGuide(g, users.length ? users : [src]);
      src.guideStatus[g.id] = { at: Date.now(), channels: r.channels, programs: r.programs, error: null };
    } catch (e) {
      src.guideStatus[g.id] = { ...(src.guideStatus[g.id] || {}), at: Date.now(), error: e.message };
      log(`${fetchIptv.redact(g.url)} : ${e.message}`);
    }
  }
  // Guides retires de la source : leur etat aussi.
  for (const k of Object.keys(src.guideStatus)) if (!guides.some((g) => g.id === k)) delete src.guideStatus[k];
  mapSource(src);
}

// ---- Association des chaines -------------------------------------------------------------

/** Recalcule l'association guide <-> chaine de chaque chaine d'une source. Renvoie le nombre associe. */
function mapSource(src) {
  const guides = guidesOf(src).map((g) => g.id);
  const byId = new Map();
  const byName = new Map();
  for (const gid of guides) {
    for (const c of q.channelsOf.all(gid)) {
      if (!byId.has(c.id)) byId.set(c.id, { gid, id: c.id });
      const lower = c.id.toLowerCase();
      if (!byId.has(lower)) byId.set(lower, { gid, id: c.id });
      for (const n of [...JSON.parse(c.names || '[]'), c.id.replace(/\.[a-z]{2,3}(@.*)?$/i, '')]) {
        const k = normName(n);
        if (k && !byName.has(k)) byName.set(k, { gid, id: c.id });
      }
    }
  }
  const find = (id) => {
    if (!id) return null;
    for (const cand of [id, id.toLowerCase(), id.split('@')[0], id.split('@')[0].toLowerCase()]) {
      const hit = byId.get(cand);
      if (hit) return hit;
    }
    return null;
  };
  let mapped = 0;
  const rows = q.sourceChannels.all(src.id);
  const idMemo = new Map();
  const findMemo = (id) => {
    if (!idMemo.has(id)) idMemo.set(id, find(id));
    return idMemo.get(id);
  };
  transaction(() => {
    for (const r of rows) {
      let hit = null;
      if (r.custom_epg) hit = findMemo(r.custom_epg);
      else {
        hit = findMemo(r.epg_id);
        if (!hit) hit = byName.get(normName(r.custom_name || r.name)) || null;
      }
      const g = hit ? hit.gid : null;
      const c = hit ? hit.id : null;
      if (g) mapped++;
      if (g !== r.epg_guide || c !== r.epg_channel) q.setMap.run(g, c, src.id, r.key);
    }
  });
  return mapped;
}

// ---- Lecture des programmes ---------------------------------------------------------------

function progOut(r) {
  if (!r) return null;
  return { ...r, categories: r.categories ? JSON.parse(r.categories) : [] };
}

/** Programmes d'une chaine (ligne iptv_channels effective) entre deux instants. */
function programs(ch, from, to) {
  if (!ch?.epg_guide || !ch.epg_channel) return [];
  return q.between.all(ch.epg_guide, ch.epg_channel, from, to).map(progOut);
}

/** Programme en cours d'une chaine. */
function airing(ch, at = Date.now()) {
  if (!ch?.epg_guide || !ch.epg_channel) return null;
  return progOut(q.at.get(ch.epg_guide, ch.epg_channel, at, at));
}

function programAt(guide, channel, start) {
  return progOut(q.one.get(guide, channel, start));
}

/** Etat des guides d'une source pour l'admin. */
function describe(src) {
  return guidesOf(src).map((g) => {
    const st = src.guideStatus?.[g.id] || {};
    return { id: g.id, host: fetchIptv.redact(g.url), provider: g.provider, channels: q.chanCount.get(g.id).n, programs: q.counts.get(g.id).n, at: st.at || null, error: st.error || null, running: running.has(g.id) };
  });
}

/** Chaines des guides d'une source qui correspondent a une recherche, avec ce qui passe. */
function search(src, text, limit = 30) {
  const needle = normName(text);
  const raw = String(text || '').toLowerCase();
  const now = Date.now();
  const out = [];
  for (const g of guidesOf(src)) {
    for (const c of q.channelsOf.all(g.id)) {
      const names = JSON.parse(c.names || '[]');
      if (raw && !c.id.toLowerCase().includes(raw) && !names.some((n) => normName(n).includes(needle) || n.toLowerCase().includes(raw))) continue;
      const p = q.at.get(g.id, c.id, now, now);
      out.push({ guide: g.id, guideHost: fetchIptv.redact(g.url), id: c.id, names, icon: c.icon, now: p ? p.title : null });
      if (out.length >= limit) return out;
    }
  }
  return out;
}

module.exports = { guidesOf, guideId, refreshSource, mapSource, programs, airing, programAt, describe, search, normName, xmltvTime, readGuide };
