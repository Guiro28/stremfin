// Sauvegardes : une archive .tar.gz dans data/backups avec la base (sans le cache,
// reconstructible), config.json, les avatars et les images des tuiles "Mes medias".
// Une sauvegarde automatique par jour (heure reglable), retention en jours ; les
// sauvegardes manuelles et envoyees sont gardees jusqu'a leur suppression.
// La restauration est preparee dans data/restore-pending et appliquee au demarrage suivant
// (voir src/restore.js), avant l'ouverture de la base.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { pipeline } = require('stream/promises');
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');
const { db } = require('./db');
const pkg = require('../package.json');

const DATA_DIR = config.DATA_DIR;
const DIR = path.join(DATA_DIR, 'backups');
const PENDING = path.join(DATA_DIR, 'restore-pending');
const FOLDERS = ['avatars', 'library-images'];
const NAME_RE = /^stremfin-\d{4}-\d{2}-\d{2}_\d{6}-(auto|manual|upload)\.tar\.gz$/;
const CHECK_EVERY = 10 * 60e3;

function log(...args) {
  console.log(new Date().toISOString(), '[backup]', ...args);
}

// ---- Format tar (ustar), sans dependance ------------------------------------------------

function tarHeader(name, size, mtime) {
  const h = Buffer.alloc(512);
  const put = (str, offset, len) => h.write(str, offset, len, 'utf8');
  const oct = (n, len) => n.toString(8).padStart(len - 1, '0') + '\0';
  put(name, 0, 100);
  put(oct(0o644, 8), 100, 8);
  put(oct(0, 8), 108, 8);
  put(oct(0, 8), 116, 8);
  put(oct(size, 12), 124, 12);
  put(oct(Math.floor(mtime / 1000), 12), 136, 12);
  put('        ', 148, 8); // somme de controle calculee avec des espaces
  put('0', 156, 1);
  put('ustar\0', 257, 6);
  put('00', 263, 2);
  let sum = 0;
  for (const b of h) sum += b;
  put(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return h;
}

/** Lit une archive tar (deja decompressee) : [{ name, data }]. */
function untar(buf) {
  const files = [];
  for (let off = 0; off + 512 <= buf.length; ) {
    const h = buf.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const name = h.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '');
    const size = parseInt(h.subarray(124, 136).toString('utf8').replace(/\0.*$/s, '').trim() || '0', 8);
    const type = String.fromCharCode(h[156] || 48);
    off += 512;
    if (type === '0' || type === '\0') files.push({ name, data: buf.subarray(off, off + size) });
    off += Math.ceil(size / 512) * 512;
  }
  return files;
}

/** Nom de fichier sur dans une archive : pas de chemin absolu ni de "..". */
function safeEntry(name) {
  if (['stremfin.db', 'config.json', 'manifest.json'].includes(name)) return true;
  const m = name.match(/^([\w-]+)\/([\w.-]+)$/);
  return !!m && FOLDERS.includes(m[1]) && !m[2].startsWith('.');
}

// ---- Creation ------------------------------------------------------------------------------

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

let running = null;

/** Cree une sauvegarde ; kind = auto | manual. Une seule a la fois. */
function create(kind = 'manual') {
  if (running) return running;
  running = (async () => {
    fs.mkdirSync(DIR, { recursive: true });
    const t0 = Date.now();
    const name = `stremfin-${stamp()}-${kind}.tar.gz`;
    const tmpDb = path.join(DIR, `.tmp-${process.pid}-${t0}.db`);
    const tmpTar = path.join(DIR, `.tmp-${process.pid}-${t0}.tar.gz`);
    try {
      // Copie coherente de la base a chaud, puis sans le cache (reconstructible).
      db.exec(`VACUUM INTO '${tmpDb.replace(/'/g, "''")}'`);
      const copy = new DatabaseSync(tmpDb);
      copy.exec("DELETE FROM cache WHERE key NOT LIKE 'dp|%'; VACUUM;");
      copy.close();

      const entries = [{ name: 'stremfin.db', file: tmpDb }, { name: 'config.json', file: path.join(DATA_DIR, 'config.json') }];
      for (const folder of FOLDERS) {
        const dir = path.join(DATA_DIR, folder);
        if (!fs.existsSync(dir)) continue;
        for (const f of fs.readdirSync(dir)) {
          const file = path.join(dir, f);
          if (fs.statSync(file).isFile() && safeEntry(`${folder}/${f}`)) entries.push({ name: `${folder}/${f}`, file });
        }
      }
      const manifest = Buffer.from(JSON.stringify({ app: 'stremfin', version: pkg.version, createdAt: new Date().toISOString(), kind, files: entries.length }, null, 2));

      const gz = zlib.createGzip({ level: 6 });
      const out = fs.createWriteStream(tmpTar);
      const done = pipeline(gz, out);
      const write = (chunk) => (gz.write(chunk) ? Promise.resolve() : new Promise((r) => gz.once('drain', r)));
      await write(tarHeader('manifest.json', manifest.length, Date.now()));
      await write(Buffer.concat([manifest, Buffer.alloc((512 - (manifest.length % 512)) % 512)]));
      for (const e of entries) {
        const st = fs.statSync(e.file);
        await write(tarHeader(e.name, st.size, st.mtimeMs));
        for await (const chunk of fs.createReadStream(e.file)) await write(chunk);
        await write(Buffer.alloc((512 - (st.size % 512)) % 512));
      }
      gz.end(Buffer.alloc(1024));
      await done;
      fs.renameSync(tmpTar, path.join(DIR, name));
      const size = fs.statSync(path.join(DIR, name)).size;
      log(`${name} : ${entries.length} fichiers, ${(size / 1e6).toFixed(1)} Mo en ${Date.now() - t0} ms`);
      prune();
      return describe(name);
    } finally {
      for (const f of [tmpDb, tmpTar]) fs.rmSync(f, { force: true });
      running = null;
    }
  })();
  return running;
}

// ---- Liste, retention, fichiers -------------------------------------------------------------

function describe(name) {
  const st = fs.statSync(path.join(DIR, name));
  const kind = name.match(NAME_RE)[1];
  const [, y, mo, d, hh, mi, ss] = name.match(/(\d{4})-(\d{2})-(\d{2})_(\d{2})(\d{2})(\d{2})/);
  return { name, kind, size: st.size, createdAt: new Date(+y, +mo - 1, +d, +hh, +mi, +ss).getTime() };
}

function list() {
  if (!fs.existsSync(DIR)) return [];
  return fs
    .readdirSync(DIR)
    .filter((f) => NAME_RE.test(f))
    .map(describe)
    .sort((a, b) => b.createdAt - a.createdAt);
}

/** Chemin d'une sauvegarde de la liste (nom verifie), ou null. */
function file(name) {
  if (!NAME_RE.test(String(name))) return null;
  const p = path.join(DIR, name);
  return fs.existsSync(p) ? p : null;
}

function remove(name) {
  const p = file(name);
  if (!p) return false;
  fs.rmSync(p);
  return true;
}

/** Retire les sauvegardes automatiques plus vieilles que la retention. */
function prune() {
  const days = Number(config.get().settings.backupRetention) || 7;
  const limit = Date.now() - days * 86400e3;
  for (const b of list()) {
    if (b.kind === 'auto' && b.createdAt < limit) {
      fs.rmSync(path.join(DIR, b.name), { force: true });
      log(`${b.name} retiree (plus de ${days} jours)`);
    }
  }
  // Donnees mises de cote par les restaurations : les 3 dernieres suffisent.
  const before = fs.readdirSync(DIR).filter((f) => f.startsWith('before-restore-')).sort().reverse();
  for (const f of before.slice(3)) fs.rmSync(path.join(DIR, f), { recursive: true, force: true });
}

// ---- Verification, envoi, restauration ------------------------------------------------------

/** Lit et verifie une archive : fichiers indispensables presents, chemins surs. */
function inspect(buffer) {
  let files;
  try {
    files = untar(zlib.gunzipSync(buffer));
  } catch {
    throw new Error('Archive illisible (fichier .tar.gz attendu)');
  }
  const names = files.map((f) => f.name);
  if (!names.includes('stremfin.db') || !names.includes('config.json')) throw new Error("Ce n'est pas une sauvegarde Stremfin");
  if (files.some((f) => !safeEntry(f.name))) throw new Error('Archive refusée : contenu inattendu');
  try {
    JSON.parse(files.find((f) => f.name === 'config.json').data.toString('utf8'));
  } catch {
    throw new Error('Sauvegarde abîmée : config.json illisible');
  }
  return files;
}

/** Ajoute une archive envoyee depuis l'interface a la liste (apres verification). */
function importUpload(buffer) {
  inspect(buffer);
  fs.mkdirSync(DIR, { recursive: true });
  const name = `stremfin-${stamp()}-upload.tar.gz`;
  fs.writeFileSync(path.join(DIR, name), buffer);
  log(`${name} envoyee depuis l'interface`);
  return describe(name);
}

/** Prepare la restauration d'une sauvegarde de la liste ; appliquee au prochain demarrage. */
function prepareRestore(name) {
  const p = file(name);
  if (!p) throw new Error('Sauvegarde introuvable');
  const files = inspect(fs.readFileSync(p));
  fs.rmSync(PENDING, { recursive: true, force: true });
  for (const f of files) {
    const target = path.join(PENDING, f.name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, f.data);
  }
  fs.writeFileSync(path.join(PENDING, 'ready'), name);
  log(`restauration de ${name} preparee : redemarrage`);
}

// ---- Planification ----------------------------------------------------------------------------

/** Une sauvegarde automatique par jour, a partir de l'heure reglee (verifie toutes les 10 min). */
function check() {
  const s = config.get().settings;
  if (s.backupEnabled === false) return;
  const now = new Date();
  if (now.getHours() < (Number(s.backupHour) || 0)) return;
  const today = stamp(now).slice(0, 10);
  if (list().some((b) => b.kind === 'auto' && b.name.includes(today))) return;
  create('auto').catch((e) => log(`echec : ${e.message}`));
}

function start() {
  setTimeout(check, 60e3).unref();
  setInterval(check, CHECK_EVERY).unref();
}

module.exports = { create, list, file, remove, importUpload, prepareRestore, start, DIR };
