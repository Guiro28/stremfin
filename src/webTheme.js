// Theme Abyss (https://github.com/AumGupta/abyss-jellyfin, licence MIT) pour le client web
// Jellyfin servi par Stremfin. Les fichiers d'origine sont dans vendor/abyss, inchanges ;
// a l'envoi, les ressources externes (Google Fonts, jsDelivr) pointent vers les copies
// locales, la verification de mise a jour sur GitHub est coupee et Spotlight passe en francais.
const fs = require('fs');
const path = require('path');
const config = require('./config');

const DIR = path.join(__dirname, '..', 'vendor', 'abyss');
const FONTS = path.join(DIR, 'fonts');
const GOOGLE_SANS = "https://fonts.googleapis.com/css2?family=Google+Sans:ital,opsz,wght@0,17..18,400..700;1,17..18,400..700&display=swap";
const ICONS = 'https://cdn.jsdelivr.net/npm/material-icons@1.13.12/iconfont/material-icons-round.woff2';

// [fichier, [texte d'origine, remplacement]...]
const REWRITES = {
  'abyss.css': [
    [`@import url('${GOOGLE_SANS}');`, "@import url('fonts/google-sans.css');"],
    [`src: url(${ICONS})`, 'src: url(fonts/material-icons-round.woff2)']
  ],
  'spotlight.html': [
    ['<html lang="en">', '<html lang="fr">'],
    ['<link rel="preconnect" href="https://fonts.googleapis.com" />', ''],
    [`href="${GOOGLE_SANS}"`, 'href="fonts/google-sans.css"'],
    // Images redirigees vers TMDB : un fetch avec en-tete d'authentification est refuse (CORS).
    // On donne alors l'adresse telle quelle a <img>, qui suit la redirection.
    [
      'const response = await fetch(url, { headers, signal });\n\t\t\t\t\tif (!response.ok) return null;\n\t\t\t\t\tconst objectUrl',
      "const response = await fetch(url, { headers, signal, redirect: 'manual' });\n\t\t\t\t\tif (response.type === 'opaqueredirect') { imageCache.set(url, url); return url; }\n\t\t\t\t\tif (!response.ok) return null;\n\t\t\t\t\tconst objectUrl"
    ],
    // Points d'accroche des ajouts Stremfin (public/spotlight-stremfin.js) : films tendance
    // TMDB et leur annee.
    ['<script>\n\t\t// Updated automatically by the installer', '<script src="spotlight-stremfin.js"></script>\n\t<script>\n\t\t// Updated automatically by the installer'],
    ['const AUTO_INTERVAL = 5000;', 'const AUTO_INTERVAL = window.StremfinSpotlight?.interval || 5000;'],
    [
      'async function fetchItems(signal) {',
      "async function fetchItems(signal) {\n\t\t\t\tif (window.StremfinSpotlight?.mode === 'trending') {\n\t\t\t\t\tconst trending = await window.StremfinSpotlight.fetchItems(base, headers, signal).catch(error => { if (error.name === 'AbortError') throw error; return []; });\n\t\t\t\t\tif (trending.length) return trending;\n\t\t\t\t}"
    ],
    [
      'if (item.OfficialRating) meta.appendChild(metaPillWithIcon(SVG_RATING, item.OfficialRating));',
      'if (item.OfficialRating) meta.appendChild(metaPillWithIcon(SVG_RATING, item.OfficialRating));\n\t\t\t\t\twindow.StremfinSpotlight?.yearPill(item, meta, metaPillWithIcon);'
    ],
    ['async function checkForUpdate(base, token, userId) {', 'async function checkForUpdate(base, token, userId) {\n\t\t\t\treturn; // Stremfin : pas de verification sur GitHub'],
    ['aria-label="View item details"', 'aria-label="Voir la fiche"'],
    ['>Nothing to show<', '>Rien à afficher<'],
    [
      "isResume ? (isEpisode ? `Continue ${episodePrefix}` : 'Resume') : (isEpisode ? `Play ${episodePrefix}`.trim() : 'Play')",
      "isResume ? (isEpisode ? `Reprendre ${episodePrefix}` : 'Reprendre') : (isEpisode ? `Lire ${episodePrefix}`.trim() : 'Lire')"
    ],
    ['`View details for ${title}`', '`Voir la fiche de ${title}`'],
    ['`View details for ${title}`', '`Voir la fiche de ${title}`'],
    ['if (mins < 60) return `${mins}m`;', 'if (mins < 60) return `${mins} min`;'],
    ['return remainder > 0 ? `${hours}h ${remainder}m` : `${hours}h`;', 'return remainder > 0 ? `${hours} h ${remainder} min` : `${hours} h`;']
  ]
};
const TYPES = { css: 'text/css', html: 'text/html', js: 'text/javascript' };
const FILES = ['abyss.css', 'spotlight.html', 'spotlight.css', 'spotlight-loader.js'];

/** Fichiers du theme prets a servir (lus et reecrits une fois). */
const ready = {};
for (const name of FILES) {
  let s = fs.readFileSync(path.join(DIR, name), 'utf8');
  for (const [from, to] of REWRITES[name] || []) {
    if (!s.includes(from)) console.log(`[theme] ${name} : passage introuvable, laisse tel quel : ${from.slice(0, 60)}`);
    s = s.replace(from, to);
  }
  ready[name] = s;
}

// Ajouts Stremfin a Spotlight ; le mode (tendances TMDB ou reprises) est insere a l'envoi.
const STREMFIN_SPOTLIGHT = fs.readFileSync(path.join(__dirname, '..', 'public', 'spotlight-stremfin.js'), 'utf8');

function enabled() {
  return config.get().settings.webTheme === 'abyss';
}

/** Balises a ajouter a la page du client web selon les reglages. */
function inject(html) {
  if (!enabled()) return html;
  // En fin de page : Jellyfin ajoute ses feuilles (dont themes/dark/theme.css) dans <head>
  // pendant le chargement ; dans <body>, le theme passe toujours apres elles, comme le CSS
  // personnalise de Jellyfin pour lequel Abyss est concu.
  let tags = '<link rel="stylesheet" href="/stremfin/abyss/abyss.css">';
  if (config.get().settings.webSpotlight !== false) {
    tags += '<script src="/stremfin/abyss/spotlight-loader.js" data-abyss-spotlight></script>';
  }
  return html.replace('</body>', tags + '</body>');
}

/** Route /stremfin/abyss/* : fichiers du theme et polices locales. */
function serve(name, res) {
  // Fichiers du theme revalides a chaque chargement (une mise a jour s'applique tout de suite).
  res.setHeader('Cache-Control', 'no-cache');
  if (name === 'spotlight-stremfin.js') {
    const mode = config.get().settings.webSpotlightSource === 'resume' ? 'resume' : 'trending';
    return res.type('text/javascript').send(STREMFIN_SPOTLIGHT.replace("'__MODE__'", JSON.stringify(mode)));
  }
  if (ready[name] !== undefined) return res.type(TYPES[path.extname(name).slice(1)]).send(ready[name]);
  const m = name.match(/^fonts\/([a-z0-9-]+\.(woff2|css))$/);
  if (m && fs.existsSync(path.join(FONTS, m[1]))) {
    res.setHeader('Cache-Control', 'public, max-age=2592000');
    return res.type(m[2] === 'css' ? 'text/css' : 'font/woff2').sendFile(path.join(FONTS, m[1]));
  }
  res.status(404).end();
}

module.exports = { inject, serve, enabled };
