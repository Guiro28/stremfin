// Interface web (page a la racine, API sous /stremfin/api) : tout ce qui se regle passe par ici, rien a editer a la main sur
// le serveur. Session "admin" : tout ; session "user" : uniquement son propre profil.
const path = require('path');
const express = require('express');
const config = require('./config');
const stremio = require('./stremio');
const catalog = require('./catalog');
const cache = require('./cache');
const ids = require('./ids');
const avatars = require('./avatars');
const tmdb = require('./tmdb');
const libraryImages = require('./libraryImages');
const { st } = require('./db');
const adminAuth = require('./adminAuth');
const auth = require('./jellyfin/auth');
const pkg = require('../package.json');
const backup = require('./backup');
const nuvio = require('./nuvio');
const collections = require('./collections');
const tracking = require('./tracking');
const stats = require('./stats');
const { verifyPassword } = require('./security');

const router = express.Router();
const STARTED = Date.now();

// Fichiers de l'interface (publics : les donnees, elles, passent par l'API authentifiee).
// La page elle-meme est servie a la racine du serveur.
router.use('/ui', express.static(path.join(__dirname, '..', 'public', 'admin'), { index: false, maxAge: 0 }));

router.use('/api/auth', express.json(), adminAuth.router);
router.use('/api', adminAuth.requireApi);
router.put('/api/profiles/:id/library-image', express.raw({ type: (req) => !String(req.headers['content-type'] || '').includes('json'), limit: avatars.MAX_BYTES + 1024 }));
router.put('/api/profiles/:id/avatar', express.raw({ type: () => true, limit: avatars.MAX_BYTES + 1024 }));
router.put('/api/backups/upload', express.raw({ type: () => true, limit: '1gb' }));
router.put('/api/collections/:id/image', express.raw({ type: (req) => !String(req.headers['content-type'] || '').includes('json'), limit: avatars.MAX_BYTES + 1024 }));
// 8 Mo : fichiers .json de collections envoyes depuis l'interface.
router.use('/api', express.json({ limit: '8mb' }));

const adminOnly = adminAuth.requireAdmin;

// Un utilisateur n'accede qu'a son propre profil.
router.use('/api/profiles/:id', (req, res, next) => {
  if (req.role === 'admin' || ids.norm(req.params.id) === req.sessionProfileId) return next();
  res.status(403).json({ error: 'Accès refusé' });
});

/** Infos utiles a toutes les pages (admin ou utilisateur). */
router.get('/api/server-info', (req, res) => {
  const s = config.get().settings;
  res.json({ serverName: s.serverName, publicUrl: s.publicUrl, tmdb: tmdb.enabled(), role: req.role });
});

function fail(res, status, error) {
  return res.status(status).json({ error });
}

/** Execute fn et renvoie une erreur 400 lisible si elle leve une exception. */
function attempt(res, fn) {
  try {
    return fn();
  } catch (e) {
    fail(res, 400, e.message);
    return undefined;
  }
}

function profileOr404(req, res) {
  const p = config.getProfile(req.params.id);
  if (!p) fail(res, 404, 'Profil introuvable');
  return p;
}

function avatarUrl(p) {
  return p.avatar ? `/Users/${p.id}/Images/Primary?tag=${p.avatarAt}` : null;
}

function devicesOf(profileId) {
  return st.tokenList
    .all()
    .filter((t) => !profileId || t.profile === profileId)
    .map((t) => ({
      id: t.token.slice(0, 12),
      profileId: t.profile,
      profileName: config.getProfile(t.profile)?.name || '?',
      client: t.client,
      device: t.device,
      version: t.version,
      created: t.created,
      lastSeen: t.last_seen
    }));
}

function profileSummary(p) {
  const devices = devicesOf(p.id);
  return {
    id: p.id,
    name: p.name,
    avatarUrl: avatarUrl(p),
    hasPassword: !!p.passwordHash,
    showOnLogin: !!p.showOnLogin,
    disabled: !!p.disabled,
    addonsCount: p.addons.length,
    librariesCount: catalog.views(p).length,
    devicesCount: devices.length,
    lastSeen: Math.max(0, ...devices.map((d) => d.lastSeen)),
    watchedCount: st.udCount.get(p.id).n
  };
}

function profileDetail(p) {
  const pos = catalog.positionOf(p);
  return {
    ...profileSummary(p),
    createdAt: p.createdAt,
    homeSections: p.homeSections || null,
    latestExcludes: p.latestExcludes || [],
    libraries: catalog.views(p).map((v) => {
      const custom = libraryImages.custom(p, v.key);
      return { key: v.key, name: v.name, type: v.type, image: custom || null, preview: custom || ids.get(v.uuid)?.data.image || null };
    }),
    preferredLanguages: p.preferredLanguages || [],
    hideWatched: !!p.hideWatched,
    onlyReleased: !!p.onlyReleased,
    defaultQuality: p.defaultQuality || '1080',
    versionMode: p.versionMode === 'releases' ? 'releases' : 'quality',
    customCss: p.customCss || '',
    tracking: tracking.describe(p),
    addons: p.addons.map((a, index) => ({
      index,
      url: a.url,
      ok: !!a.manifest,
      enabled: a.enabled !== false,
      catalogsHidden: !!a.catalogsHidden,
      catalogCount: (a.manifest?.catalogs || []).length,
      name: a.manifest?.name || a.url,
      description: a.manifest?.description || '',
      version: a.manifest?.version,
      logo: a.manifest?.logo,
      configurable: !!a.manifest?.behaviorHints?.configurable,
      configureUrl: a.manifest?.behaviorHints?.configurable ? stremio.baseOf(a.url) + '/configure' : null,
      resources: (a.manifest?.resources || []).map((r) => (typeof r === 'string' ? r : r.name)),
      types: a.manifest?.types || []
    })),
    catalogs: catalog
      .allCatalogs(p)
      .map((c, i) => ({ c, i }))
      .sort((a, b) => pos(a.c) - pos(b.c) || a.i - b.i)
      .map(({ c }) => ({
        key: c.key,
        addonName: c.addonName,
        builtin: c.addonUrl === tmdb.ADDON_URL,
        type: c.type,
        defaultName: c.defaultName,
        name: p.catalogs?.[c.key]?.name || '',
        enabled: catalog.isEnabled(p, c),
        browsable: c.browsable,
        searchable: c.searchable
      })),
    devices: devicesOf(p.id)
  };
}

const mask = (v) => (v ? '••••••••' + v.slice(-4) : '');

/** Cle TMDB et secret Trakt ne repartent jamais en clair vers le navigateur. */
function publicSettings(s) {
  return { ...s, tmdbApiKey: mask(s.tmdbApiKey), traktClientSecret: mask(s.traktClientSecret) };
}

// ---- Tableau de bord -----------------------------------------------------------------

router.get('/api/overview', adminOnly, (req, res) => {
  const c = config.get();
  const now = Date.now();
  const tokens = st.tokenList.all();
  const recent = [];
  for (const p of c.profiles) {
    for (const r of st.udRecent.all(p.id, 8)) {
      const e = ids.get(r.uuid);
      if (!e) continue;
      const series = e.kind === 'episode' ? ids.get(e.data.seriesUuid) : null;
      recent.push({
        profile: p.name,
        title: series ? `${series.data.name} · S${e.data.season}E${e.data.episode}` : e.data.name,
        subtitle: series ? e.data.name : e.data.releaseInfo,
        image: series?.data.poster || e.data.poster,
        played: !!r.played,
        position: r.position,
        at: r.last_played
      });
    }
  }
  recent.sort((a, b) => b.at - a.at);
  const brokenAddons = c.profiles.flatMap((p) => p.addons.filter((a) => !a.manifest).map((a) => ({ profile: p.name, url: a.url })));
  res.json({
    version: pkg.version,
    uptime: now - STARTED,
    serverName: c.settings.serverName,
    profiles: c.profiles.length,
    devices: tokens.length,
    activeDevices: tokens.filter((t) => now - t.last_seen < 24 * 3600e3).length,
    tmdb: tmdb.enabled(),
    introSkip: !!c.settings.introSkip,
    cacheEntries: st.cacheCount.get().n,
    indexedItems: st.idsCount.get().n,
    brokenAddons,
    recent: recent.slice(0, 12)
  });
});

// ---- Statistiques de visionnage ------------------------------------------------------------
// Admin : profils choisis (?profiles=id,id ; "__none__" = aucun) ; utilisateur : le sien.

// Lecture en cours (panneau de la page Statistiques, rafraichi toutes les 3 s).
router.get('/api/stats/now-playing', (req, res) => {
  res.json({ items: stats.nowPlaying(req.role === 'admin' ? null : [req.sessionProfileId]) });
});

router.get('/api/stats', (req, res) => {
  const days = Number(req.query.days);
  if (!Number.isInteger(days) || days < 0 || days > 3650) return fail(res, 400, 'Période invalide');
  let refs = null;
  if (req.role !== 'admin') refs = [req.sessionProfileId];
  else if (req.query.profiles === '__none__') refs = [];
  else if (req.query.profiles) refs = String(req.query.profiles).split(',').filter(Boolean);
  const r = stats.summary({ days, refs });
  // Un utilisateur ne voit pas la liste des autres profils.
  if (req.role !== 'admin') r.availableProfiles = r.availableProfiles.filter((p) => p.ref === req.sessionProfileId);
  res.json(r);
});

// ---- Reglages du serveur ---------------------------------------------------------------

router.get('/api/settings', adminOnly, (req, res) => res.json(publicSettings(config.get().settings)));

router.put('/api/settings', adminOnly, async (req, res) => {
  const patch = { ...(req.body || {}) };
  const before = config.get().settings;
  // Valeur masquee renvoyee telle quelle : la cle ne change pas.
  for (const k of ['tmdbApiKey', 'traktClientSecret']) if (typeof patch[k] === 'string' && patch[k].startsWith('•')) delete patch[k];
  if (patch.tmdbApiKey) {
    try {
      await tmdb.checkKey(patch.tmdbApiKey.trim());
    } catch {
      return fail(res, 400, 'Clé TMDB refusée par TMDB');
    }
  }
  if (patch.publicUrl && !/^https?:\/\/[^\s]+$/i.test(String(patch.publicUrl).trim())) return fail(res, 400, 'URL publique invalide');
  if (patch.torrentServer && !/^https?:\/\/[^\s]+$/i.test(String(patch.torrentServer).trim())) return fail(res, 400, 'URL du serveur de streaming invalide');
  if (patch.upstream?.url && patch.upstream.mode !== 'direct' && !/^(socks5h?|socks4|https?):\/\/[^\s]+$/i.test(patch.upstream.url.trim())) {
    return fail(res, 400, 'URL du proxy de sortie invalide');
  }
  const keyChanged = patch.tmdbApiKey !== undefined && patch.tmdbApiKey !== before.tmdbApiKey;
  const langChanged = patch.metadataLanguage !== undefined && patch.metadataLanguage !== before.metadataLanguage;
  const s = config.updateSettings(patch);
  if (keyChanged || langChanged) tmdb.warm();
  res.json(publicSettings(s));
});

// ---- Suivi (Trakt, Simkl, historique Nuvio) d'un profil ----------------------------------------

// Compte Nuvio du profil (lecture seule) : appairage par code, profils du compte, retrait.
router.post('/api/profiles/:id/tracking/nuvio/pair', async (req, res) => {
  const p = profileOr404(req, res);
  if (!p) return;
  try {
    res.json(await nuvio.pairStart(p.id));
  } catch (e) {
    fail(res, 502, e.message);
  }
});

router.post('/api/profiles/:id/tracking/nuvio/pair/:pairId', async (req, res) => {
  const p = profileOr404(req, res);
  if (!p) return;
  try {
    res.json(await nuvio.pairPoll(req.params.pairId, nuvio.forProfile(p), p.id));
  } catch (e) {
    fail(res, 400, e.message);
  }
});

router.get('/api/profiles/:id/tracking/nuvio/profiles', async (req, res) => {
  const p = profileOr404(req, res);
  if (!p) return;
  try {
    res.json(await nuvio.profiles(nuvio.forProfile(p)));
  } catch (e) {
    fail(res, 502, e.message);
  }
});

router.delete('/api/profiles/:id/tracking/nuvio', (req, res) => {
  const p = profileOr404(req, res);
  if (!p) return;
  tracking.unlinkNuvio(p);
  res.json(profileDetail(p));
});

router.post('/api/profiles/:id/tracking/:service/pair', async (req, res) => {
  const p = profileOr404(req, res);
  if (!p) return;
  if (!['trakt', 'simkl'].includes(req.params.service)) return fail(res, 404, 'Service inconnu');
  try {
    res.json(await tracking.pairStart(p, req.params.service));
  } catch (e) {
    fail(res, 400, e.message);
  }
});

router.post('/api/profiles/:id/tracking/pair/:pairId', async (req, res) => {
  const p = profileOr404(req, res);
  if (!p) return;
  try {
    res.json(await tracking.pairPoll(p, req.params.pairId));
  } catch (e) {
    fail(res, 400, e.message);
  }
});

router.delete('/api/profiles/:id/tracking/:service', (req, res) => {
  const p = profileOr404(req, res);
  if (!p) return;
  if (!['trakt', 'simkl'].includes(req.params.service)) return fail(res, 404, 'Service inconnu');
  tracking.unlink(p, req.params.service);
  res.json(profileDetail(p));
});

router.patch('/api/profiles/:id/tracking', (req, res) => {
  const p = profileOr404(req, res);
  if (!p) return;
  tracking.update(p, req.body);
  res.json(profileDetail(p));
});

router.post('/api/profiles/:id/tracking/import', async (req, res) => {
  const p = profileOr404(req, res);
  if (!p) return;
  res.json({ results: await tracking.importProfile(p), profile: profileDetail(p) });
});

// ---- Bibliotheque de collections (fichiers .json + addons) ----------------------------------

router.get('/api/collections', adminOnly, (req, res) => res.json(collections.list()));

// Corps : { json (contenu du fichier) ou jsonUrl, addonUrls, ids?, profiles? }.
router.post('/api/collections/preview', adminOnly, async (req, res) => {
  try {
    res.json(await collections.preview(req.body || {}));
  } catch (e) {
    fail(res, 400, e.message);
  }
});

router.post('/api/collections/import', adminOnly, async (req, res) => {
  if (!Array.isArray(req.body?.ids) || !req.body.ids.length) return fail(res, 400, 'Aucune collection choisie');
  try {
    const added = await collections.importFrom(req.body, req.body.ids);
    // Attribution directe aux profils choisis dans la meme fenetre.
    if (Array.isArray(req.body.profiles)) {
      for (const id of added) collections.assign(id, [...new Set([...collections.list().find((c) => c.id === id).profiles, ...req.body.profiles])]);
    }
    res.json({ added: added.length });
  } catch (e) {
    fail(res, 502, e.message);
  }
});

router.post('/api/collections/refresh', adminOnly, async (req, res) => {
  try {
    res.json(await collections.refresh());
  } catch (e) {
    fail(res, 502, e.message);
  }
});

router.put('/api/collections/:id/profiles', adminOnly, (req, res) => {
  if (!collections.assign(req.params.id, req.body?.profiles)) return fail(res, 404, 'Collection introuvable');
  res.json({ ok: true });
});

// Image de la tuile "Mes medias" de la collection, ou d'un de ses dossiers / sous-dossiers
// (?target=dossier ou dossier:n) : fichier envoye ou adresse (JSON { url }).
function imageTargetOr404(req, res) {
  const c = collections.byId(req.params.id);
  const target = String(req.query.target || '');
  if (!c || !collections.imageTarget(c, target)) {
    fail(res, 404, 'Collection introuvable');
    return null;
  }
  return { c, target };
}

router.put('/api/collections/:id/image', adminOnly, (req, res) => {
  const t = imageTargetOr404(req, res);
  if (!t) return;
  const ok = attempt(res, () => (Buffer.isBuffer(req.body) ? libraryImages.saveCollectionFile(t.c, t.target, req.body) : libraryImages.setCollectionUrl(t.c, t.target, req.body?.url)));
  if (ok) res.json(collections.list().find((x) => x.id === t.c.id));
});

router.delete('/api/collections/:id/image', adminOnly, (req, res) => {
  const t = imageTargetOr404(req, res);
  if (!t) return;
  libraryImages.clearCollection(t.c, t.target);
  res.json(collections.list().find((x) => x.id === t.c.id));
});

router.delete('/api/collections/:id', adminOnly, (req, res) => {
  if (!collections.remove(req.params.id)) return fail(res, 404, 'Collection introuvable');
  res.json({ ok: true });
});

// ---- Profils ------------------------------------------------------------------------------

router.get('/api/profiles', adminOnly, (req, res) => res.json(config.get().profiles.map(profileSummary)));

router.post('/api/profiles', adminOnly, async (req, res) => {
  const p = attempt(res, () => config.addProfile(req.body?.name, req.body?.password));
  if (!p) return;
  await stremio.refreshManifests(p);
  res.json(profileDetail(p));
});

router.get('/api/profiles/:id', (req, res) => {
  const p = profileOr404(req, res);
  if (p) res.json(profileDetail(p));
});

const USER_FIELDS = ['password', 'preferredLanguages', 'defaultQuality', 'versionMode', 'customCss', 'hideWatched', 'onlyReleased', 'catalogs', 'catalogOrder', 'homeSections', 'latestExcludes'];

router.patch('/api/profiles/:id', (req, res) => {
  let body = req.body || {};
  const current = profileOr404(req, res);
  if (!current) return;
  if (req.role !== 'admin') {
    body = Object.fromEntries(Object.entries(body).filter(([k]) => USER_FIELDS.includes(k)));
    if (body.password && !verifyPassword(req.body.currentPassword, current.passwordHash)) return fail(res, 401, 'Mot de passe actuel incorrect');
  }
  const p = attempt(res, () => config.updateProfile(req.params.id, body));
  if (!p) return;
  // Nouveau mot de passe ou profil desactive : les appareils sont deconnectes.
  if (body.password || body.disabled === true) st.tokenDelProfile.run(p.id);
  // Profil desactive par l'admin : son espace web aussi.
  if (body.disabled === true) st.adminSessionDelProfile.run(p.id);
  res.json(profileDetail(p));
});

router.post('/api/profiles/:id/duplicate', adminOnly, async (req, res) => {
  if (!profileOr404(req, res)) return;
  const p = attempt(res, () => config.duplicateProfile(req.params.id, req.body?.name, req.body?.password));
  if (p) res.json(profileDetail(p));
});

router.delete('/api/profiles/:id', adminOnly, (req, res) => {
  const p = profileOr404(req, res);
  if (!p) return;
  if (config.get().profiles.length <= 1) return fail(res, 400, 'Il faut garder au moins un profil');
  avatars.remove(p);
  config.removeProfile(p.id);
  st.tokenDelProfile.run(p.id);
  st.udDelProfile.run(p.id);
  st.playDelProfile.run(p.id);
  st.adminSessionDelProfile.run(p.id);
  res.json({ ok: true });
});

router.put('/api/profiles/:id/avatar', (req, res) => {
  const p = profileOr404(req, res);
  if (!p) return;
  if (attempt(res, () => (avatars.save(p, req.body), true))) res.json(profileDetail(p));
});

router.delete('/api/profiles/:id/avatar', (req, res) => {
  const p = profileOr404(req, res);
  if (!p) return;
  avatars.remove(p);
  res.json(profileDetail(p));
});

// ---- Images des tuiles "Mes medias" ---------------------------------------------------------

/** Cle de bibliotheque valide pour ce profil (parmi ses catalogues). */
function libraryKey(p, key) {
  return catalog.allCatalogs(p).some((c) => c.key === key) ? key : null;
}

router.put('/api/profiles/:id/library-image', (req, res) => {
  const p = profileOr404(req, res);
  if (!p) return;
  const key = libraryKey(p, req.query.key);
  if (!key) return fail(res, 404, 'Bibliothèque introuvable');
  // Fichier envoye (corps binaire) ou adresse d'image (JSON { url }).
  const ok = attempt(res, () => (Buffer.isBuffer(req.body) ? libraryImages.saveFile(p, key, req.body) : libraryImages.setUrl(p, key, req.body?.url)));
  if (ok) res.json(profileDetail(p));
});

router.delete('/api/profiles/:id/library-image', (req, res) => {
  const p = profileOr404(req, res);
  if (!p) return;
  const key = libraryKey(p, req.query.key);
  if (!key) return fail(res, 404, 'Bibliothèque introuvable');
  libraryImages.clear(p, key);
  res.json(profileDetail(p));
});

/** Nouvel ordre des bibliotheques actives (Mes medias et rangees) ; les autres suivent. */
router.put('/api/profiles/:id/libraries/order', (req, res) => {
  const p = profileOr404(req, res);
  if (!p) return;
  const keys = Array.isArray(req.body?.keys) ? req.body.keys.map(String) : null;
  if (!keys) return fail(res, 400, 'Ordre invalide');
  const all = profileDetail(p).catalogs.map((c) => c.key);
  const order = [...keys.filter((k) => all.includes(k)), ...all.filter((k) => !keys.includes(k))];
  const updated = attempt(res, () => config.updateProfile(p.id, { catalogOrder: order }));
  if (updated) res.json(profileDetail(updated));
});

// ---- Addons d'un profil ----------------------------------------------------------------------

router.post('/api/profiles/:id/addons', async (req, res) => {
  const p = profileOr404(req, res);
  if (!p) return;
  let url;
  try {
    url = config.normalizeManifestUrl(req.body?.url);
  } catch (e) {
    return fail(res, 400, e.message);
  }
  if (p.addons.some((a) => a.url === url)) return fail(res, 409, 'Cet addon est déjà installé sur ce profil');
  let manifest;
  try {
    manifest = await stremio.fetchManifest(url);
  } catch (e) {
    return fail(res, 400, `Manifest injoignable : ${e.message}`);
  }
  p.addons.push({ url, manifest, enabled: true });
  config.save();
  res.json(profileDetail(p));
});

/** Retrouve un addon par son index en verifiant l'URL (evite d'agir sur le mauvais apres un reordre). */
function addonAt(p, req) {
  const a = p.addons[Number(req.params.idx)];
  if (!a || (req.query.url && req.query.url !== a.url)) return null;
  return a;
}

router.patch('/api/profiles/:id/addons/:idx', (req, res) => {
  const p = profileOr404(req, res);
  if (!p) return;
  const a = addonAt(p, req);
  if (!a) return fail(res, 404, 'Addon introuvable, recharge la page');
  if (typeof req.body?.enabled === 'boolean') a.enabled = req.body.enabled;
  // Addon utilise seulement pour ses sources / fiches : ses catalogues ne sont plus proposes.
  if (typeof req.body?.catalogsHidden === 'boolean') a.catalogsHidden = req.body.catalogsHidden;
  config.save();
  res.json(profileDetail(p));
});

router.delete('/api/profiles/:id/addons/:idx', (req, res) => {
  const p = profileOr404(req, res);
  if (!p) return;
  const a = addonAt(p, req);
  if (!a) return fail(res, 404, 'Addon introuvable, recharge la page');
  p.addons.splice(p.addons.indexOf(a), 1);
  config.save();
  res.json(profileDetail(p));
});

/** Nouvel ordre des addons : liste complete de leurs URL. */
router.put('/api/profiles/:id/addons/order', (req, res) => {
  const p = profileOr404(req, res);
  if (!p) return;
  const urls = req.body?.urls;
  if (!Array.isArray(urls) || urls.length !== p.addons.length || !p.addons.every((a) => urls.includes(a.url))) {
    return fail(res, 400, 'Ordre invalide, recharge la page');
  }
  p.addons.sort((a, b) => urls.indexOf(a.url) - urls.indexOf(b.url));
  config.save();
  res.json(profileDetail(p));
});

router.post('/api/profiles/:id/addons/refresh', async (req, res) => {
  const p = profileOr404(req, res);
  if (!p) return;
  await stremio.refreshManifests(p, true);
  res.json(profileDetail(p));
});

/** Copie les addons d'un autre profil (ajout des manquants, ou remplacement complet). */
router.post('/api/profiles/:id/addons/copy', (req, res) => {
  const p = profileOr404(req, res);
  if (!p) return;
  const from = config.getProfile(req.body?.from);
  if (!from || from.id === p.id) return fail(res, 400, 'Profil source invalide');
  const copy = (a) => JSON.parse(JSON.stringify(a));
  if (req.body?.mode === 'replace') p.addons = from.addons.map(copy);
  else for (const a of from.addons) if (!p.addons.some((x) => x.url === a.url)) p.addons.push(copy(a));
  config.save();
  res.json(profileDetail(p));
});

// ---- Appareils ---------------------------------------------------------------------------------

router.get('/api/devices', adminOnly, (req, res) => res.json(devicesOf()));

router.delete('/api/devices/:prefix', (req, res) => {
  const t = st.tokenList
    .all()
    .find((x) => x.token.startsWith(req.params.prefix) && (req.role === 'admin' || x.profile === req.sessionProfileId));
  if (t) st.tokenDel.run(t.token);
  res.json({ ok: !!t });
});

router.delete('/api/profiles/:id/devices', (req, res) => {
  const p = profileOr404(req, res);
  if (!p) return;
  st.tokenDelProfile.run(p.id);
  res.json(profileDetail(p));
});

router.post('/api/quickconnect', (req, res) => {
  // Un utilisateur approuve toujours pour son propre profil.
  const p = config.getProfile(req.role === 'admin' ? req.body?.profileId : req.sessionProfileId);
  if (!p) return fail(res, 404, 'Profil introuvable');
  if (p.disabled) return fail(res, 400, 'Ce profil est désactivé');
  if (!auth.qcAuthorize(req.body?.code, p.id)) return fail(res, 400, 'Code inconnu ou expiré');
  res.json({ ok: true });
});

// ---- Maintenance ----------------------------------------------------------------------------------

router.post('/api/maintenance/clear-cache', adminOnly, (req, res) => {
  cache.clear();
  res.json({ ok: true });
});

router.post('/api/maintenance/refresh-addons', adminOnly, async (req, res) => {
  await Promise.all(config.get().profiles.map((p) => stremio.refreshManifests(p, true)));
  const broken = config.get().profiles.reduce((n, p) => n + p.addons.filter((a) => !a.manifest).length, 0);
  res.json({ ok: true, broken });
});

router.post('/api/maintenance/reindex-tmdb', adminOnly, (req, res) => {
  if (!tmdb.enabled()) return fail(res, 400, 'Aucune clé TMDB configurée');
  tmdb.warm(true);
  res.json({ ok: true });
});

// ---- Sauvegardes ----------------------------------------------------------------------------------

router.get('/api/backups', adminOnly, (req, res) => {
  const s = config.get().settings;
  res.json({ backups: backup.list(), settings: { backupEnabled: s.backupEnabled !== false, backupHour: s.backupHour, backupRetention: s.backupRetention } });
});

router.post('/api/backups', adminOnly, async (req, res) => {
  try {
    res.json(await backup.create('manual'));
  } catch (e) {
    fail(res, 500, e.message);
  }
});

router.put('/api/backups/upload', adminOnly, (req, res) => {
  if (!Buffer.isBuffer(req.body) || !req.body.length) return fail(res, 400, 'Fichier vide');
  const r = attempt(res, () => backup.importUpload(req.body));
  if (r) res.json(r);
});

router.get('/api/backups/:name/download', adminOnly, (req, res) => {
  const file = backup.file(req.params.name);
  if (!file) return fail(res, 404, 'Sauvegarde introuvable');
  res.download(file, req.params.name);
});

router.delete('/api/backups/:name', adminOnly, (req, res) => {
  if (!backup.remove(req.params.name)) return fail(res, 404, 'Sauvegarde introuvable');
  res.json({ ok: true });
});

// Restauration : preparee maintenant, appliquee au redemarrage (relance automatique sous
// Docker avec "restart: unless-stopped").
router.post('/api/backups/:name/restore', adminOnly, (req, res) => {
  if (!attempt(res, () => (backup.prepareRestore(req.params.name), true))) return;
  res.json({ ok: true, restarting: true });
  setTimeout(() => process.exit(0), 800);
});

router.use('/api', (req, res) => fail(res, 404, 'Route inconnue'));

module.exports = router;
