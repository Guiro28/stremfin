const { SocksProxyAgent } = require('socks-proxy-agent');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { HttpProxyAgent } = require('http-proxy-agent');

// Cache des agents pour ne pas les recreer a chaque requete.
let cache = { key: null, agents: null };

/**
 * Retourne l'agent http(s) a utiliser pour joindre `urlObj` selon la config upstream.
 * - direct  -> undefined (sortie = IP du serveur)
 * - socks   -> SocksProxyAgent (ex: WARP en socks5://127.0.0.1:40000)
 * - http    -> Http(s)ProxyAgent
 */
function getAgent(urlObj, upstream) {
  if (!upstream || upstream.mode === 'direct' || !upstream.url) return undefined;

  const key = `${upstream.mode}|${upstream.url}`;
  if (cache.key !== key) {
    cache.key = key;
    cache.agents = {};
    try {
      if (upstream.mode === 'socks') {
        const a = new SocksProxyAgent(upstream.url);
        cache.agents.http = a;
        cache.agents.https = a;
      } else if (upstream.mode === 'http') {
        cache.agents.http = new HttpProxyAgent(upstream.url);
        cache.agents.https = new HttpsProxyAgent(upstream.url);
      }
    } catch (e) {
      // URL upstream invalide -> on retombe en direct plutot que de tout casser.
      cache = { key: null, agents: null };
      return undefined;
    }
  }

  return urlObj.protocol === 'https:' ? cache.agents.https : cache.agents.http;
}

module.exports = { getAgent };
