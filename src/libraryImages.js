// Images des tuiles "Mes medias" choisies par profil : fichier envoye (data/library-images)
// ou adresse d'une image. Sans choix, la tuile prend le fond du titre le plus populaire.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');
const { sniff, TYPES, MAX_BYTES } = require('./avatars');

const DIR = path.join(config.DATA_DIR, 'library-images');
const PREFIX = '/stremfin/library/';

function entry(profile, key) {
  profile.catalogs = profile.catalogs || {};
  profile.catalogs[key] = profile.catalogs[key] || {};
  return profile.catalogs[key];
}

/** Supprime le fichier local d'une image (si c'en est un). */
function dropFile(url) {
  if (typeof url !== 'string' || !url.startsWith(PREFIX)) return;
  const file = path.join(DIR, path.basename(url.slice(PREFIX.length).split('?')[0]));
  try { fs.unlinkSync(file); } catch {}
}

function saveFile(profile, key, buf) {
  if (!Buffer.isBuffer(buf) || !buf.length) throw new Error('Image vide');
  if (buf.length > MAX_BYTES) throw new Error('Image trop lourde (3 Mo max.)');
  const ext = sniff(buf);
  if (!ext) throw new Error('Format non pris en charge (PNG, JPEG, WebP ou GIF)');
  fs.mkdirSync(DIR, { recursive: true });
  const e = entry(profile, key);
  dropFile(e.image);
  const name = `${profile.id}-${crypto.createHash('sha1').update(key).digest('hex').slice(0, 12)}.${ext}`;
  fs.writeFileSync(path.join(DIR, name), buf);
  e.image = `${PREFIX}${name}?v=${Date.now()}`;
  config.save();
  return e.image;
}

function setUrl(profile, key, url) {
  const u = String(url || '').trim();
  if (!/^https?:\/\/\S+$/i.test(u)) throw new Error("Adresse d'image invalide");
  const e = entry(profile, key);
  dropFile(e.image);
  e.image = u;
  config.save();
  return u;
}

function clear(profile, key) {
  const e = profile.catalogs?.[key];
  if (!e?.image) return;
  dropFile(e.image);
  delete e.image;
  config.save();
}

/** Fichier a servir pour /stremfin/library/<nom>, ou null. */
function file(name) {
  const f = path.join(DIR, path.basename(String(name)));
  if (!fs.existsSync(f)) return null;
  return { file: f, type: TYPES[path.extname(f).slice(1)] || 'application/octet-stream' };
}

/** Image choisie pour une bibliotheque du profil (ou undefined). */
function custom(profile, key) {
  return profile?.catalogs?.[key]?.image || undefined;
}

module.exports = { saveFile, setUrl, clear, file, custom };
