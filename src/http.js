const http = require('http');
const https = require('https');
const { getAgent } = require('./upstream');

/**
 * Requete HTTP(S) bas niveau avec suivi des redirections et routage upstream.
 * Resout avec { res, finalUrl } (res = IncomingMessage de la reponse finale).
 */
function request(urlStr, opts = {}) {
  const maxRedirects = opts.maxRedirects ?? 5;
  return new Promise((resolve, reject) => {
    follow(urlStr, opts, maxRedirects, resolve, reject);
  });
}

function follow(urlStr, opts, redirectsLeft, resolve, reject) {
  let u;
  try {
    u = new URL(urlStr);
  } catch (e) {
    return reject(new Error('URL invalide: ' + urlStr));
  }

  const lib = u.protocol === 'https:' ? https : http;
  const agent = getAgent(u, opts.upstream);

  const req = lib.request(
    u,
    {
      method: opts.method || 'GET',
      headers: opts.headers || {},
      agent,
      timeout: opts.timeout || 30000
    },
    (res) => {
      const code = res.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(code) && res.headers.location && redirectsLeft > 0) {
        res.resume(); // draine la reponse de redirection
        let next;
        try {
          next = new URL(res.headers.location, u).toString();
        } catch {
          return reject(new Error('Redirection invalide'));
        }
        const nextOpts = { ...opts };
        // 303 (et souvent 302) -> on repasse en GET
        if (code === 303) {
          nextOpts.method = 'GET';
          delete nextOpts.body;
        }
        return follow(next, nextOpts, redirectsLeft - 1, resolve, reject);
      }
      // Le timeout ne sert qu'a l'etablissement : une fois la reponse recue, un lecteur
      // peut mettre le flux en pause (buffer plein) bien plus longtemps sans que ce soit une erreur.
      if (opts.keepAlive) req.setTimeout(0);
      resolve({ res, finalUrl: u.toString() });
    }
  );

  req.on('timeout', () => req.destroy(new Error('Timeout')));
  req.on('error', reject);
  if (opts.body) req.write(opts.body);
  req.end();
}

/** Lit entierement un flux et renvoie un Buffer. */
function readAll(res) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve(Buffer.concat(chunks)));
    res.on('error', reject);
  });
}

/** GET JSON avec timeout global (connexion + lecture). */
async function getJson(url, { upstream, timeout = 15000, headers = {} } = {}) {
  let timer;
  const work = (async () => {
    const { res } = await request(url, {
      upstream,
      timeout,
      headers: { accept: 'application/json', 'user-agent': 'Stremfin/0.1', ...headers }
    });
    const body = await readAll(res);
    if ((res.statusCode || 0) >= 400) throw new Error(`HTTP ${res.statusCode}`);
    return JSON.parse(body.toString('utf8'));
  })();
  const limit = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('Timeout')), timeout);
  });
  try {
    return await Promise.race([work, limit]);
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { request, readAll, getJson };
