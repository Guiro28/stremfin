// Restauration d'une sauvegarde, appliquee au demarrage avant l'ouverture de la base et la
// lecture de config.json (voir src/backup.js : prepareRestore). Les donnees remplacees sont
// gardees dans data/backups/before-restore-<date>/ par securite.
const fs = require('fs');
const path = require('path');

function log(...args) {
  console.log(new Date().toISOString(), '[restore]', ...args);
}

function applyPending(dataDir) {
  const pending = path.join(dataDir, 'restore-pending');
  if (!fs.existsSync(path.join(pending, 'ready'))) return false;
  const from = fs.readFileSync(path.join(pending, 'ready'), 'utf8').trim();
  const keep = path.join(dataDir, 'backups', `before-restore-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  fs.mkdirSync(keep, { recursive: true });

  // Base : la nouvelle remplace l'ancienne (fichiers WAL compris, devenus sans objet).
  for (const f of ['stremfin.db', 'stremfin.db-wal', 'stremfin.db-shm', 'config.json']) {
    const cur = path.join(dataDir, f);
    if (fs.existsSync(cur)) fs.renameSync(cur, path.join(keep, f));
  }
  for (const folder of ['avatars', 'library-images']) {
    const cur = path.join(dataDir, folder);
    if (fs.existsSync(path.join(pending, folder))) {
      if (fs.existsSync(cur)) fs.renameSync(cur, path.join(keep, folder));
      fs.renameSync(path.join(pending, folder), cur);
    }
  }
  fs.renameSync(path.join(pending, 'stremfin.db'), path.join(dataDir, 'stremfin.db'));
  fs.renameSync(path.join(pending, 'config.json'), path.join(dataDir, 'config.json'));
  fs.rmSync(pending, { recursive: true, force: true });
  log(`sauvegarde ${from} restauree (anciennes donnees dans ${path.relative(dataDir, keep)})`);
  return true;
}

module.exports = { applyPending };
