// Timestamps d'intro, recap, generique et apercu depuis TheIntroDB (base communautaire,
// sans cle : 30 requetes / 10 s, 5000 / jour). Exposes aux apps comme MediaSegments Jellyfin.
const cache = require('./cache');
const { request, readAll } = require('./http');

const API = 'https://api.theintrodb.org/v4/media';
const DAY = 24 * 3600e3;
const MIN_DELAY = 350; // ~30 requetes / 10 s

// TheIntroDB -> types de segments Jellyfin.
const TYPES = { intro: 'Intro', recap: 'Recap', credits: 'Outro', preview: 'Preview' };

let queue = Promise.resolve();
let last = 0;

/** Les requetes passent une par une, espacees, pour rester sous la limite anonyme. */
function throttled(fn) {
  const run = queue.then(async () => {
    const wait = last + MIN_DELAY - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    last = Date.now();
    return fn();
  });
  queue = run.catch(() => {});
  return run;
}

async function fetchMedia(query) {
  const { res } = await request(`${API}?${query}`, { timeout: 10000, headers: { accept: 'application/json', 'user-agent': 'Stremfin/0.1' } });
  const body = (await readAll(res)).toString('utf8');
  if (res.statusCode === 404) return {};
  if ((res.statusCode || 0) >= 400) throw new Error(`HTTP ${res.statusCode}`);
  return JSON.parse(body);
}

/**
 * Segments d'un film ou d'un episode. `ids` : { tmdb, imdb } de la serie ou du film,
 * `season`/`episode` pour un episode (numerotation TMDB). Renvoie
 * [{ type: 'Intro'|'Recap'|'Outro'|'Preview', startMs, endMs|null }].
 */
async function segments({ tmdb, imdb, season, episode }) {
  const q = new URLSearchParams();
  if (tmdb) q.set('tmdb_id', tmdb);
  else if (imdb) q.set('imdb_id', imdb);
  else return [];
  if (season !== undefined && episode !== undefined) {
    q.set('season', season);
    q.set('episode', episode);
  }
  const query = q.toString();
  const r = await cache.cached(`introdb|${query}`, 7 * DAY, () => throttled(() => fetchMedia(query)), { stale: 30 * DAY });
  const out = [];
  for (const [key, type] of Object.entries(TYPES)) {
    for (const s of r?.[key] || []) {
      const start = s.start_ms ?? 0;
      const end = s.end_ms ?? null;
      // 0/0 = segment confirme absent ; une fin avant le debut n'est jamais valide.
      if (end !== null && end <= start) continue;
      // Intro et recap doivent avoir une fin ; generique et apercu peuvent aller jusqu'au bout.
      if (end === null && (type === 'Intro' || type === 'Recap')) continue;
      out.push({ type, startMs: start, endMs: end });
    }
  }
  return out;
}

module.exports = { segments };
