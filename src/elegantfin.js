// Theme ElegantFin (https://github.com/lscambo13/ElegantFin, licence GPL-2.0) pour le client web
// Jellyfin servi par Stremfin. Fichier d'origine dans vendor/elegantfin, inchange ; a l'envoi, les
// polices (Google Fonts) pointent vers les copies locales de vendor/elegantfin/fonts.
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'vendor', 'elegantfin');
const FONTS = path.join(DIR, 'fonts');
const INTER = 'https://fonts.googleapis.com/css2?family=Inter:ital,opsz,wght@0,14..32,100..900;1,14..32,100..900&display=swap';

let ready = fs.readFileSync(path.join(DIR, 'elegantfin.css'), 'utf8');
// Inter, puis les deux polices d'icones (version reduite et complete) : adresses relatives
// a /stremfin/elegantfin/.
const rewrites = [[`@import url("${INTER}")`, '@import url("fonts/inter.css")']];
for (const m of ready.matchAll(/@font-face\{[^}]*font-family:([^;]+);[^}]*src:url\((https:\/\/fonts\.gstatic\.com[^)]+)\)/g)) {
  const file = /minimal/i.test(m[1]) ? 'material-symbols-rounded-minimal.woff2' : 'material-symbols-rounded.woff2';
  rewrites.push([`url(${m[2]})`, `url(fonts/${file})`]);
}
for (const [from, to] of rewrites) {
  if (!ready.includes(from)) console.log(`[theme] elegantfin.css : passage introuvable, laisse tel quel : ${from.slice(0, 60)}`);
  ready = ready.split(from).join(to);
}
if (/fonts\.(googleapis|gstatic)\.com/.test(ready.replace(/\/\*[\s\S]*?\*\//g, ''))) console.log('[theme] elegantfin.css : une police externe reste a remplacer');

/** Route /stremfin/elegantfin/* : le theme et ses polices locales. */
function serve(name, res) {
  if (name === 'elegantfin.css') {
    // Revalide a chaque chargement : une mise a jour du theme s'applique tout de suite.
    res.setHeader('Cache-Control', 'no-cache');
    return res.type('text/css').send(ready);
  }
  const m = name.match(/^fonts\/([a-z0-9-]+\.(woff2|css))$/);
  if (m && fs.existsSync(path.join(FONTS, m[1]))) {
    res.setHeader('Cache-Control', 'public, max-age=2592000');
    return res.type(m[2] === 'css' ? 'text/css' : 'font/woff2').sendFile(path.join(FONTS, m[1]));
  }
  res.status(404).end();
}

module.exports = { serve };
