// Bibliotheque d'addons du serveur (reprise de Nuvio Manager) : chaque addon est ajoute une fois
// (config.addons), puis attribue aux profils avec un mode de connexion par profil :
//   none   : l'app lit la video directement a la source (redirection) ;
//   direct : la video passe par le serveur, avec son IP ;
//   warp   : la video et les requetes a l'addon passent par le proxy externe (Reglages).
// Les profils gardent une copie de l'URL et du manifest (lib = id), remise a jour a chaque
// enregistrement de la configuration.
const crypto = require('crypto');
const config = require('./config');
const stremio = require('./stremio');

function byId(id) {
  return config.get().addons.find((l) => l.id === String(id || ''));
}

function checkMode(mode) {
  if (!config.MODES.includes(mode)) throw new Error('Mode de connexion invalide');
  return mode;
}

/** Fiche d'un addon pour l'interface, avec les profils qui l'utilisent. */
function describe(l) {
  const m = l.manifest;
  return {
    id: l.id,
    url: l.url,
    name: l.name || m?.name || l.url,
    customName: l.name || '',
    manifestName: m?.name || '',
    logo: m?.logo || null,
    version: m?.version || null,
    description: m?.description || '',
    ok: !!m,
    resources: (m?.resources || []).map((r) => (typeof r === 'string' ? r : r.name)),
    catalogCount: (m?.catalogs || []).length,
    configureUrl: m?.behaviorHints?.configurable ? stremio.baseOf(l.url) + '/configure' : null,
    users: config
      .get()
      .profiles.map((p) => ({ p, a: p.addons.find((a) => a.lib === l.id) }))
      .filter((x) => x.a)
      .map(({ p, a }) => ({ profileId: p.id, name: p.name, mode: a.mode, enabled: a.enabled !== false }))
  };
}

function list() {
  return config.get().addons.map(describe);
}

/**
 * Ajoute un addon a la bibliotheque (manifest lu tout de suite). Deja present (meme URL) :
 * renvoie l'existant si `reuse`, sinon erreur.
 */
async function add(url, name = '', { reuse = false } = {}) {
  const u = config.normalizeManifestUrl(url);
  const lib = config.get().addons;
  const known = lib.find((l) => l.url === u);
  if (known) {
    if (reuse) return known;
    throw new Error('Cet addon est déjà dans la bibliothèque');
  }
  let manifest;
  try {
    manifest = await stremio.fetchManifest(u);
  } catch (e) {
    throw new Error(`Manifest injoignable : ${e.message}`);
  }
  const l = { id: crypto.randomBytes(8).toString('hex'), url: u, name: String(name || '').trim().slice(0, 80), manifest, addedAt: Date.now() };
  lib.push(l);
  config.save();
  return l;
}

/** Nom et URL d'un addon : les profils qui l'utilisent suivent. */
async function update(id, { url, name } = {}) {
  const l = byId(id);
  if (!l) throw new Error('Addon introuvable');
  if (url !== undefined) {
    const u = config.normalizeManifestUrl(url);
    if (u !== l.url) {
      if (config.get().addons.some((x) => x !== l && x.url === u)) throw new Error('Cet addon est déjà dans la bibliothèque');
      try {
        l.manifest = await stremio.fetchManifest(u);
      } catch (e) {
        throw new Error(`Manifest injoignable : ${e.message}`);
      }
      l.url = u;
    }
  }
  if (name !== undefined) l.name = String(name || '').trim().slice(0, 80);
  config.save();
  return l;
}

/** Retire un addon de la bibliotheque et de tous les profils. */
function remove(id) {
  const c = config.get();
  const l = byId(id);
  if (!l) throw new Error('Addon introuvable');
  c.addons = c.addons.filter((x) => x !== l);
  for (const p of c.profiles) p.addons = p.addons.filter((a) => a.lib !== l.id);
  config.save();
}

/** Installe un addon sur un profil (a la fin), ou change son mode s'il y est deja. */
function install(p, l, mode) {
  const a = p.addons.find((x) => x.lib === l.id);
  if (a) {
    a.mode = mode;
    return 'updated';
  }
  p.addons.push({ lib: l.id, url: l.url, name: l.name || '', manifest: l.manifest, enabled: true, mode });
  return 'added';
}

/** Un addon vers plusieurs profils, avec un meme mode. */
function assignToProfiles(id, profileIds, mode) {
  const l = byId(id);
  if (!l) throw new Error('Addon introuvable');
  checkMode(mode);
  const results = [].concat(profileIds || []).map((pid) => {
    const p = config.getProfile(pid);
    return p ? { profileId: p.id, ok: true, action: install(p, l, mode) } : { profileId: pid, ok: false, error: 'Profil introuvable' };
  });
  config.save();
  return { applied: results.filter((r) => r.ok).length, results };
}

/** Plusieurs addons vers un profil, dans l'ordre donne, avec un meme mode. */
function assignMany(profileId, addonIds, mode) {
  const p = config.getProfile(profileId);
  if (!p) throw new Error('Profil introuvable');
  checkMode(mode);
  const results = [].concat(addonIds || []).map((id) => {
    const l = byId(id);
    return l ? { id: l.id, ok: true, action: install(p, l, mode) } : { id, ok: false, error: 'Addon introuvable' };
  });
  config.save();
  return { applied: results.filter((r) => r.ok).length, results };
}

/** Modes par profil d'un addon : [{ profileId, mode }] ou mode "remove" pour le retirer du profil. */
function setModes(id, changes) {
  const l = byId(id);
  if (!l) throw new Error('Addon introuvable');
  const results = [].concat(changes || []).map(({ profileId, mode } = {}) => {
    const p = config.getProfile(profileId);
    const a = p?.addons.find((x) => x.lib === l.id);
    if (!a) return { profileId, ok: false, error: 'Addon absent de ce profil' };
    if (mode === 'remove') p.addons = p.addons.filter((x) => x !== a);
    else if (config.MODES.includes(mode)) a.mode = mode;
    else return { profileId, ok: false, error: 'Mode de connexion invalide' };
    return { profileId, ok: true };
  });
  config.save();
  return { applied: results.filter((r) => r.ok).length, results };
}

module.exports = { byId, list, describe, add, update, remove, install, assignToProfiles, assignMany, setModes, checkMode };
