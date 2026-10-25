const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');

const config = require('./src/config');
// Restauration demandee depuis l'interface : appliquee avant de lire la config et la base.
require('./src/restore').applyPending(config.DATA_DIR);
config.load();

const stremio = require('./src/stremio');
const tmdb = require('./src/tmdb');
const auth = require('./src/jellyfin/auth');
const api = require('./src/jellyfin/api');
const socket = require('./src/jellyfin/socket');
const discovery = require('./src/jellyfin/discovery');
const admin = require('./src/admin');
const libraryImages = require('./src/libraryImages');
const webTheme = require('./src/webTheme');

const PORT = Number(process.env.PORT) || 8096; // port par defaut de Jellyfin
const WEB_DIR = process.env.WEB_DIR || path.join(__dirname, 'web');

const app = express();
app.disable('x-powered-by');
app.set('etag', false);
// En-tetes X-Forwarded-* acceptes seulement d'un reverse-proxy local (Docker, reseau prive).
app.set('trust proxy', 'loopback, uniquelocal');

// Les apps web/desktop appellent l'API depuis une autre origine (jamais l'interface Stremfin).
app.use((req, res, next) => {
  if (req.path === '/' || /^\/stremfin\/(api|ui)(\/|$)/i.test(req.path)) return next();
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, HEAD');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

// Journal des requetes (LOG_REQUESTS=1) : pour diagnostiquer une app qui se comporte mal.
if (process.env.LOG_REQUESTS === '1') {
  app.use((req, res, next) => {
    const t0 = Date.now();
    res.on('finish', () => {
      const ua = String(req.headers['x-emby-client'] || req.headers['user-agent'] || '').slice(0, 40);
      // Jetons masques dans le journal.
      const url = req.originalUrl.replace(/(api_key|X-Emby-Token|ApiKey)=[^&]+/gi, '$1=…');
      console.log(new Date().toISOString(), `[http] ${res.statusCode} ${req.method} ${url} ${Date.now() - t0}ms (${ua})`);
    });
    next();
  });
}

// Certaines apps prefixent les routes par /emby (heritage Emby).
app.use((req, res, next) => {
  if (/^\/emby\//i.test(req.url)) {
    req.url = req.url.slice(5);
    req.embyPrefix = true; // indice : c'est probablement une app Emby
  }
  next();
});

app.use(express.json({ limit: '5mb', strict: false, type: ['application/json', 'text/json', 'application/*+json', 'text/plain'] }));
// Les apps Emby envoient la connexion en formulaire (Username=...&Pw=...).
app.use(express.urlencoded({ extended: false, limit: '1mb' }));

// Interface Stremfin : fichiers sous /stremfin/ui, API sous /stremfin/api, page a la racine.
app.use('/stremfin', admin);

// Page Quick Connect.
const slash = (base) => (req, res, next) => (req.originalUrl.split('?')[0] === base ? res.redirect(301, base + '/' + (req.originalUrl.split('?')[1] ? '?' + req.originalUrl.split('?')[1] : '')) : next());
app.use('/pin', slash('/pin'), express.static(path.join(__dirname, 'public', 'pin')));

// Images des tuiles "Mes medias" envoyees depuis l'admin.
app.get('/stremfin/library/:file', (req, res) => {
  const img = libraryImages.file(req.params.file);
  if (!img) return res.status(404).end();
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.type(img.type).sendFile(img.file);
});

// Client web officiel de Jellyfin (copie dans l'image Docker), utilise par l'app Android
// et Jellyfin Media Player qui l'affichent tel quel.
const hasWeb = fs.existsSync(path.join(WEB_DIR, 'index.html'));
app.locals.hasWeb = hasWeb;

// App Emby Android TV : juste apres la connexion, elle lit /emby/web/manifest.json et, si le
// texte contient "jellyf", affiche "Incompatible Server Version", repasse en connexion
// manuelle et se ferme. On lui sert donc un manifeste neutre (sans le client web Jellyfin).
app.get('/web/manifest.json', (req, res, next) => {
  if (!req.embyPrefix) return next();
  const name = config.get().settings.serverName;
  res.json({ name, short_name: name, start_url: 'index.html', display: 'standalone', background_color: '#101010', theme_color: '#101010', icons: [] });
});
if (hasWeb) {
  // Page du client web : on y ajoute le theme (Abyss par defaut) et le script qui applique
  // le CSS du profil connecte (apres le theme, pour pouvoir le surcharger).
  const webIndex = fs.readFileSync(path.join(WEB_DIR, 'index.html'), 'utf8').replace('</head>', '<script defer src="/stremfin/web-css.js"></script></head>');
  const webCss = fs.readFileSync(path.join(__dirname, 'public', 'web-css.js'), 'utf8');
  app.get(['/web/', '/web/index.html'], (req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.type('html').send(webTheme.inject(webIndex));
  });
  app.get('/stremfin/abyss/*file', (req, res) => webTheme.serve([].concat(req.params.file).join('/'), res));
  app.get('/stremfin/web-css.js', (req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.type('js').send(webCss.replace('__SERVER_ID__', config.get().serverId));
  });
  app.use('/web', express.static(WEB_DIR, { index: 'index.html' }));
}

// Racine : connexion Stremfin (admin ou utilisateur) dans un navigateur. Les apps qui affichent
// le client web (Jellyfin Media Player, app Android telephone en WebView) ouvrent aussi la
// racine : elles partent directement vers /web.
const WEB_CLIENT_UA = /JellyfinMediaPlayer|Jellyfin|QtWebEngine|; wv\)/i;
const PORTAL = path.join(__dirname, 'public', 'admin', 'index.html');
app.get('/', (req, res) => {
  if (hasWeb && WEB_CLIENT_UA.test(req.headers['user-agent'] || '')) return res.redirect('/web/');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Vary', 'User-Agent');
  res.sendFile(PORTAL);
});

app.use(auth.attach);
app.use(api);

app.use((err, req, res, next) => {
  console.log(new Date().toISOString(), `[erreur] ${req.method} ${req.path}: ${err.stack || err.message}`);
  if (!res.headersSent) res.status(500).send('Erreur serveur');
});

const server = http.createServer(app);
socket.attach(server);

server.listen(PORT, () => {
  console.log(`Stremfin sur http://localhost:${PORT}  (connexion : /${hasWeb ? ', client web : /web' : ''})`);
  discovery.start(PORT);
  tmdb.warm();
  for (const p of config.get().profiles) stremio.refreshManifests(p).catch(() => {});
  // Bibliotheques et dossiers des collections prepares en arriere-plan (ouverture immediate).
  require('./src/jellyfin/library').startWarming();
  // Sauvegarde automatique quotidienne.
  require('./src/backup').start();
  // Collections mises a jour depuis Nuvio toutes les 6 h.
  require('./src/collections').start();
});
