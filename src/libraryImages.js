// Images des tuiles "Mes medias" choisies par profil, ou pour une collection (tous les profils) :
// fichier envoye (data/library-images), adresse d'une image, ou image generee par Stremfin (fond
// fourni ou mur de jaquettes, calque de couleur et nom, voir libraryCard.js). Sans choix, Stremfin
// genere lui-meme l'image avec les jaquettes de la bibliotheque (les collections Nuvio gardent la leur).
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
  if (!e?.image && !e?.card) return;
  dropFile(e.image);
  delete e.image;
  if (e.card?.source) dropFile(PREFIX + e.card.source);
  delete e.card;
  config.save();
}

// ---- Images generees ------------------------------------------------------------------
// Style Polyfin (voir libraryCard.js) : mur de jaquettes, degrade sombre et nom en gras blanc.
// Generees a la demande (bouton "Generer l'image", gardees comme image choisie), ou
// automatiquement pour ce qui n'a pas d'image : bibliotheques, collections et leurs dossiers.

// Version du style : une image automatique d'une version plus ancienne est refaite.
const STYLE = 2;
const AUTO_EVERY = 7 * 864e5;
// Jaquettes demandees : de quoi remplir chaque case du mur sans repetition (28 en large).
const POSTERS = 32;

/** Image telechargee (jaquette), 8 Mo max. */
async function fetchImage(url) {
  const { request, readAll } = require('./http');
  const { res } = await request(url, { timeout: 15000, upstream: config.get().settings.upstream, headers: { 'user-agent': 'Stremfin' } });
  const buf = await readAll(res);
  if ((res.statusCode || 0) >= 400) throw new Error(`HTTP ${res.statusCode}`);
  if (buf.length > 8 * 1024 * 1024) throw new Error('Image trop lourde');
  return buf;
}

/** Jaquettes des premiers titres d'une liste (catalogue au sens de catalog.js), pour le mur. */
async function posterBuffers(view) {
  const { metas } = await require('./catalog').slice(view, 0, POSTERS + 10);
  const urls = [...new Set((metas || []).map((m) => m.poster).filter((u) => /^https?:\/\//i.test(String(u || ''))))].slice(0, POSTERS);
  // Par lots de 8, pour ne pas ouvrir 32 connexions d'un coup.
  const bufs = [];
  for (let i = 0; i < urls.length; i += 8) bufs.push(...(await Promise.all(urls.slice(i, i + 8).map((u) => fetchImage(u).catch(() => null)))));
  return bufs.filter(Boolean);
}

/** JPEG genere pour une liste : ses jaquettes et son nom. */
async function draw(view, name, poster = false) {
  return require('./libraryCard').render({ posters: await posterBuffers(view), title: name, poster });
}

/** Genere l'image d'une bibliotheque du profil (jaquettes + nom) et la garde comme image de sa tuile. */
async function generate(profile, view) {
  const e = entry(profile, view.key);
  storeFile(e, `${profile.id}-${hash(view.key)}`, await draw(view, view.name));
  if (e.card?.source) dropFile(PREFIX + e.card.source);
  delete e.card;
  config.save();
  return e.image;
}

// Images automatiques, generees en tache de fond l'une apres l'autre ; refaites quand le nom
// change, quand le style change, et chaque semaine (nouvelles jaquettes).
const autoQueue = [];
const autoPending = new Set();
let autoRunning = false;

async function runAuto() {
  if (autoRunning) return;
  autoRunning = true;
  while (autoQueue.length) {
    const job = autoQueue.shift();
    try {
      await job.run();
    } catch (err) {
      console.log(new Date().toISOString(), `[images] image de « ${job.label} » non generee : ${err.message}`);
    }
    autoPending.delete(job.id);
  }
  autoRunning = false;
}

function schedule(id, label, run) {
  if (autoPending.has(id)) return;
  autoPending.add(id);
  autoQueue.push({ id, label, run });
  setImmediate(runAuto);
}

/** Adresse d'une image automatique a jour, ou null ; stale : a refaire (nom, style ou age). */
function autoState(a, name) {
  const ready = !!a?.file && fs.existsSync(path.join(DIR, path.basename(a.file)));
  const stale = !ready || a.name !== name || a.v !== STYLE || Date.now() - a.at > AUTO_EVERY;
  return { url: ready ? `${PREFIX}${a.file}?v=${a.at}` : null, stale };
}

function writeAuto(file, jpegBuf, name) {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(path.join(DIR, file), jpegBuf);
  return { file, name, at: Date.now(), v: STYLE };
}

/**
 * Image automatique d'une bibliotheque (adresse), ou null tant qu'elle n'est pas prete : elle
 * est alors generee en tache de fond, et les apps la recoivent au prochain affichage. Une
 * collection qui a deja sa propre image (Nuvio ou choisie) la garde.
 */
function autoImage(profile, view) {
  if (!profile || !view) return null;
  if (view.type === 'nuviocol') {
    const c = require('./collections').byId(String(view.catId || view.key || '').replace(/^.*col:/, ''));
    if (c && require('./collections').imageOf(c)) return null;
  }
  const state = autoState(profile.catalogs?.[view.key]?.auto, view.name);
  if (state.stale) {
    schedule(`${profile.id}|${view.key}`, view.name, async () => {
      const p = config.getProfile(profile.id);
      const v = p && require('./jellyfin/library').viewByUuid(p, view.uuid);
      if (!v || custom(p, v.key)) return;
      entry(p, v.key).auto = writeAuto(`auto-${p.id}-${hash(v.key)}.jpg`, await draw(v, v.name), v.name);
      config.save();
    });
  }
  return state.url;
}

/**
 * Image automatique d'une collection ou d'un de ses dossiers (target : "" collection, id de
 * dossier, ou "dossier:n" sous-dossier), commune a tous les profils, ou null tant qu'elle n'est
 * pas prete. spec : { view, name, poster } (voir collections.generationSpec).
 */
function autoCollectionImage(c, target, spec) {
  if (!c || !spec?.view) return null;
  c.autoImages = c.autoImages || {};
  const state = autoState(c.autoImages[target || ''], spec.name);
  if (state.stale) {
    schedule(`col|${c.id}|${target || ''}`, spec.name, async () => {
      const jpegBuf = await draw(spec.view, spec.name, spec.poster);
      c.autoImages = c.autoImages || {};
      c.autoImages[target || ''] = writeAuto(`auto-col-${hash(`${c.id}|${target || ''}`)}.jpg`, jpegBuf, spec.name);
      config.save();
    });
  }
  return state.url;
}

/** Genere l'image d'une collection ou d'un de ses dossiers et la garde comme image choisie. */
async function generateCollection(c, target, spec) {
  if (!spec?.view) throw new Error('Aucune liste de titres pour cette image');
  return storeFile(collectionHolder(c, target), `col-${hash(`${c.id}|${target || ''}`)}`, await draw(spec.view, spec.name, spec.poster));
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

module.exports = { saveFile, setUrl, clear, saveCollectionFile, setCollectionUrl, clearCollection, clearCollectionAll, file, custom, generate, autoImage, autoCollectionImage, generateCollection };
