// Images des tuiles "Mes medias" choisies par profil, ou pour une collection (tous les profils) :
// fichier envoye (data/library-images) ou adresse d'une image. Sans choix, la tuile prend le fond
// du titre le plus populaire (ou l'image Nuvio d'une collection).
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

const hash = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 12);

/** Enregistre un fichier image pour `holder` (qui garde son adresse dans holder.image). */
function storeFile(holder, base, buf) {
  if (!Buffer.isBuffer(buf) || !buf.length) throw new Error('Image vide');
  if (buf.length > MAX_BYTES) throw new Error('Image trop lourde (3 Mo max.)');
  const ext = sniff(buf);
  if (!ext) throw new Error('Format non pris en charge (PNG, JPEG, WebP ou GIF)');
  fs.mkdirSync(DIR, { recursive: true });
  dropFile(holder.image);
  const name = `${base}.${ext}`;
  fs.writeFileSync(path.join(DIR, name), buf);
  holder.image = `${PREFIX}${name}?v=${Date.now()}`;
  config.save();
  return holder.image;
}

function storeUrl(holder, url) {
  const u = String(url || '').trim();
  if (!/^https?:\/\/\S+$/i.test(u)) throw new Error("Adresse d'image invalide");
  dropFile(holder.image);
  holder.image = u;
  config.save();
  return u;
}

function saveFile(profile, key, buf) {
  return storeFile(entry(profile, key), `${profile.id}-${hash(key)}`, buf);
}

function setUrl(profile, key, url) {
  return storeUrl(entry(profile, key), url);
}

function clear(profile, key) {
  const e = profile.catalogs?.[key];
  if (!e?.image) return;
  dropFile(e.image);
  delete e.image;
  config.save();
}

// Collection : image de sa tuile (commune a tous les profils, qui peuvent toujours choisir la
// leur), et images de ses dossiers et sous-dossiers. target : "" (collection), id de dossier, ou
// "dossier:n" (sous-dossier de la n-ieme source).
function collectionHolder(c, target) {
  if (!target) return c;
  c.images = c.images || {};
  c.images[target] = c.images[target] || {};
  return c.images[target];
}
const saveCollectionFile = (c, target, buf) => storeFile(collectionHolder(c, target), `col-${hash(`${c.id}|${target || ''}`)}`, buf);
const setCollectionUrl = (c, target, url) => storeUrl(collectionHolder(c, target), url);
function clearCollection(c, target) {
  const h = target ? c.images?.[target] : c;
  if (!h?.image) return;
  dropFile(h.image);
  delete h.image;
  if (target) delete c.images[target];
  config.save();
}
/** Toutes les images d'une collection (quand on la retire). */
function clearCollectionAll(c) {
  for (const t of Object.keys(c.images || {})) clearCollection(c, t);
  clearCollection(c, '');
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

module.exports = { saveFile, setUrl, clear, saveCollectionFile, setCollectionUrl, clearCollection, clearCollectionAll, file, custom };
