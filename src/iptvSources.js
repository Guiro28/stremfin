// Sources IPTV (comptes Xtream Codes, listes M3U), sur le modele de la bibliotheque d'addons
// (addons.js) et de Polyfin (docs/iptv.md) :
//   - config.iptv : chaque source une fois, avec owner = null (source du serveur, ajoutee par
//     l'admin et attribuable aux profils) ou l'id d'un profil (source privee, ajoutee par
//     l'utilisateur lui-meme : seul son profil l'utilise) ;
//   - profile.iptv : [{ lib, enabled, mode }] dans l'ordre, mode de lecture comme les addons
//     (none = l'app lit le flux a la source, direct = via le serveur, warp = via le proxy externe).
// Les identifiants ne sortent jamais vers l'interface ni le journal (voir describe et fetch.redact).
const crypto = require('crypto');
const config = require('./config');
const store = require('./iptv/store');
const m3u = require('./iptv/m3u');
const xtream = require('./iptv/xtream');
const fetch = require('./iptv/fetch');
const epg = require('./iptv/epg');
const vod = require('./iptv/vod');

function log(...args) {
  console.log(new Date().toISOString(), '[iptv]', ...args);
}

const KINDS = ['xtream', 'm3u'];
const NETWORKS = ['direct', 'warp'];

function all() {
  return config.get().iptv;
}

function byId(id) {
  return all().find((s) => s.id === String(id || ''));
}

function defaultOptions() {
  return { live: true, movies: false, series: false, newEnabled: true, excluded: [] };
}

// Etat des telechargements (en memoire) : en cours, derniere erreur, compte Xtream.
const runtime = new Map();
function stateOf(id) {
  if (!runtime.has(id)) runtime.set(id, { running: null, error: null, account: null });
  return runtime.get(id);
}

/** Fiche d'une source pour l'interface : jamais d'identifiants, seulement l'hote. */
function describe(s, viewer) {
  const st = stateOf(s.id);
  const c = config.get();
  const users = c.profiles
    .map((p) => ({ p, a: (p.iptv || []).find((x) => x.lib === s.id) }))
    .filter((x) => x.a)
    .map(({ p, a }) => ({ profileId: p.id, name: p.name, mode: a.mode, enabled: a.enabled !== false }));
  const owner = s.owner ? c.profiles.find((p) => p.id === s.owner) : null;
  return {
    id: s.id,
    kind: s.kind,
    name: s.name,
    host: fetch.redact(s.kind === 'xtream' ? s.server : s.url),
    username: s.kind === 'xtream' ? s.username : undefined,
    hasPassword: s.kind === 'xtream' ? !!s.password : undefined,
    userAgent: s.userAgent || '',
    network: s.network || 'direct',
    useProviderGuide: s.useProviderGuide !== false,
    epgUrls: (s.epgUrls || []).map((u) => ({ host: fetch.redact(u) })),
    owner: s.owner || null,
    ownerName: owner?.name || null,
    private: !!s.owner,
    mine: viewer ? s.owner === viewer : undefined,
    options: { ...defaultOptions(), ...(s.options || {}) },
    addedAt: s.addedAt,
    lastRefresh: s.lastRefresh || null,
    nextRefresh: s.lastRefresh ? s.lastRefresh + refreshEvery() : null,
    refreshing: !!st.running,
    error: st.error || s.lastError || null,
    account: st.account || s.account || null,
    counts: store.counts(s.id),
    guides: epg.describe(s),
    vod: vod.counts(s.id),
    users
  };
}

function refreshEvery() {
  return Math.min(168, Math.max(1, Number(config.get().settings.iptvRefreshHours) || 12)) * 3600e3;
}

/** Sources visibles : toutes pour l'admin, celles du serveur attribuees et les siennes pour un utilisateur. */
function list({ role = 'admin', profileId } = {}) {
  return all()
    .filter((s) => role === 'admin' || s.owner === profileId || (!s.owner && config.getProfile(profileId)?.iptv?.some((a) => a.lib === s.id)))
    .map((s) => describe(s, profileId));
}

/** Champs d'un compte saisis dans l'admin, verifies. local = adresse du reseau local permise. */
function cleanAccount(input, { local, current } = {}) {
  const kind = KINDS.includes(input.kind) ? input.kind : current?.kind;
  if (!kind) throw new Error('Type de source invalide');
  const out = { kind };
  out.name = String(input.name ?? current?.name ?? '').trim().slice(0, 80);
  if (!out.name) throw new Error('Le nom est obligatoire');
  out.userAgent = String(input.userAgent ?? current?.userAgent ?? '').trim().slice(0, 300);
  out.network = NETWORKS.includes(input.network) ? input.network : current?.network || 'direct';
  if (kind === 'xtream') {
    out.server = input.server ? xtream.normalizeServer(input.server) : current?.server;
    if (!out.server) throw new Error("L'adresse du serveur est obligatoire");
    out.username = String(input.username ?? current?.username ?? '').trim();
    if (!out.username) throw new Error("L'identifiant est obligatoire");
    // Mot de passe laisse vide : on garde l'actuel.
    out.password = input.password ? String(input.password) : current?.password || '';
    if (!out.password) throw new Error('Le mot de passe est obligatoire');
    if (!local && fetch.isLocalAddress(out.server)) throw new Error("Seul l'administrateur peut ajouter une source du réseau local");
  } else {
    let url = input.url ? String(input.url).trim() : current?.url;
    if (!url || !/^https?:\/\//i.test(url)) throw new Error("L'adresse de la liste M3U est invalide");
    out.url = url;
    if (!local && fetch.isLocalAddress(url)) throw new Error("Seul l'administrateur peut ajouter une source du réseau local");
  }
  if (input.useProviderGuide !== undefined) out.useProviderGuide = !!input.useProviderGuide;
  if (Array.isArray(input.epgUrls)) {
    out.epgUrls = input.epgUrls.map((u) => String(u || '').trim()).filter(Boolean);
    for (const u of out.epgUrls) {
      if (!/^https?:\/\//i.test(u)) throw new Error('Adresse de guide invalide');
      if (!local && fetch.isLocalAddress(u)) throw new Error("Seul l'administrateur peut ajouter un guide du réseau local");
    }
  }
  return out;
}

/** Telecharge la liste d'un compte (sans rien enregistrer) : { account, entries, guides }. */
async function download(src) {
  if (src.kind === 'xtream') {
    const account = await xtream.login(src);
    const { entries } = await xtream.liveEntries(src, account);
    return { account, entries, guides: [] };
  }
  const { entries, guides } = await m3u.parse({ url: src.url, source: src });
  if (!entries.length) throw new Error('La liste ne contient aucune chaîne lisible');
  return { account: null, entries, guides };
}

// Apercus (2e etape de l'ajout) : liste telechargee une fois, gardee 5 minutes.
const previews = new Map();
setInterval(() => {
  for (const [k, v] of previews) if (Date.now() - v.at > 5 * 60e3) previews.delete(k);
}, 60e3).unref();

function groupsPreview(entries, vodRows) {
  const groups = new Map();
  for (const e of entries) {
    if (e.kind !== 'live') continue;
    const k = store.groupKey(e);
    if (!groups.has(k)) groups.set(k, { key: k, name: e.group || '', channels: 0 });
    groups.get(k).channels++;
  }
  const movieGroups = vod.categoryCounts(vodRows, 'movie');
  const seriesGroups = vod.categoryCounts(vodRows, 'series');
  const total = (list) => list.reduce((n, g) => n + g.count, 0);
  return { groups: [...groups.values()], movies: total(movieGroups), series: total(seriesGroups), movieGroups, seriesGroups };
}

/** 1re etape de l'ajout : verifie le compte et renvoie ses groupes (token pour l'ajout). */
async function preview(input, { local }) {
  const acc = cleanAccount(input, { local });
  const src = { ...acc, id: 'preview' };
  const data = await download(src);
  // Films et series aussi (categories a choisir), gardes pour l'ajout.
  data.vodRows = await vod.rowsOf(src, data.entries).catch(() => []);
  const token = crypto.randomBytes(12).toString('hex');
  previews.set(token, { at: Date.now(), acc, data });
  const live = data.entries.filter((e) => e.kind === 'live');
  return { token, account: data.account, channels: live.length, ...groupsPreview(data.entries, data.vodRows) };
}

/** Ajoute une source (apres l'apercu, ou directement). owner = id du profil pour une source privee. */
async function add(input, { local, owner = null } = {}) {
  const prev = input.token && previews.get(input.token);
  const acc = prev ? prev.acc : cleanAccount(input, { local });
  const data = prev ? prev.data : await download({ ...acc, id: 'new' });
  const s = {
    id: crypto.randomBytes(8).toString('hex'),
    ...acc,
    epgUrls: acc.epgUrls || [],
    useProviderGuide: acc.useProviderGuide !== false,
    owner,
    addedAt: Date.now(),
    options: { ...defaultOptions(), ...cleanOptions(input.options || {}) }
  };
  all().push(s);
  // Source privee : tout de suite sur le profil de son proprietaire.
  if (owner) {
    const p = config.getProfile(owner);
    if (p) install(p, s, input.mode || config.get().settings.addonMode);
  }
  config.save();
  apply(s, data);
  if (prev) previews.delete(input.token);
  log(`source ajoutée : ${s.name} (${s.kind === 'xtream' ? 'Xtream' : 'M3U'}, ${fetch.redact(s.kind === 'xtream' ? s.server : s.url)})`);
  return s;
}

function cleanOptions(o) {
  const out = {};
  for (const k of ['live', 'movies', 'series', 'newEnabled']) if (typeof o[k] === 'boolean') out[k] = o[k];
  for (const k of ['excluded', 'excludedMovies', 'excludedSeries']) if (Array.isArray(o[k])) out[k] = [...new Set(o[k].map(String))].slice(0, 20000);
  return out;
}

/** Enregistre une liste telechargee : chaines rapprochees, etat du compte. */
function apply(s, data) {
  const st = stateOf(s.id);
  // Chaines toujours rapprochees : "Chaines en direct" decoche les masque seulement des apps
  // (les modifications de l'admin restent).
  const live = data.entries.filter((e) => e.kind === 'live');
  const r = store.reconcile(s.id, live, { newEnabled: s.options?.newEnabled !== false, excluded: s.options?.excluded || [] });
  st.error = null;
  st.account = data.account;
  s.account = data.account;
  s.listGuides = data.guides || [];
  s.lastRefresh = Date.now();
  s.lastError = null;
  config.save();
  log(`${s.name} : ${r.channels} chaînes dans ${r.groups} groupes (${r.added} nouvelles, ${r.removed} retirées)`);
  // Guides : association tout de suite (guides deja connus), puis guides telecharges a nouveau.
  epg.mapSource(s);
  refreshGuides(s.id).catch(() => {});
  // Films et series (bibliotheques et recherche de secours), en arriere-plan.
  vod.refreshSource(s, data.entries || [], data.vodRows || null).catch((e) => log(`${s.name} : VOD illisible (${e.message})`));
  return r;
}

/** Telecharge les guides d'une source (en arriere-plan apres chaque liste). */
const guideJobs = new Map();
function refreshGuides(id) {
  const s = byId(id);
  if (!s) return Promise.reject(new Error('Source introuvable'));
  if (guideJobs.has(id)) return guideJobs.get(id);
  const job = epg
    .refreshSource(s, all())
    .then(() => config.save())
    .finally(() => guideJobs.delete(id));
  guideJobs.set(id, job);
  return job;
}

/** Telecharge a nouveau une source (une seule fois a la fois). Un echec garde les chaines. */
function refresh(id) {
  const s = byId(id);
  if (!s) return Promise.reject(new Error('Source introuvable'));
  const st = stateOf(s.id);
  if (st.running) return st.running;
  st.running = (async () => {
    try {
      const data = await download(s);
      return apply(s, data);
    } catch (e) {
      st.error = e.message;
      s.lastError = e.message;
      // Nouvel essai dans 30 minutes plutot qu'au prochain cycle.
      s.lastRefresh = Date.now() - refreshEvery() + 30 * 60e3;
      config.save();
      log(`${s.name} : téléchargement impossible (${e.message})`);
      throw e;
    } finally {
      st.running = null;
    }
  })();
  return st.running;
}

/** Modifie une source : compte (mot de passe vide = garde), options, guides. */
async function update(id, input, { local }) {
  const s = byId(id);
  if (!s) throw new Error('Source introuvable');
  const accountFields = ['name', 'server', 'username', 'password', 'url', 'userAgent', 'network', 'useProviderGuide', 'epgUrls'];
  if (accountFields.some((k) => input[k] !== undefined)) {
    const acc = cleanAccount({ ...input, kind: s.kind }, { local, current: s });
    const changed = acc.server !== s.server || acc.username !== s.username || acc.password !== s.password || acc.url !== s.url || acc.userAgent !== s.userAgent;
    // Nouvelle adresse ou nouveau compte : verifie avant d'enregistrer.
    if (changed) await download({ ...s, ...acc });
    Object.assign(s, acc);
  }
  if (input.options) s.options = { ...defaultOptions(), ...(s.options || {}), ...cleanOptions(input.options) };
  config.save();
  // Categories de films ou de series : bibliotheques relues a la prochaine ouverture.
  if (input.options && (input.options.excludedMovies || input.options.excludedSeries)) require('./catalog').invalidate(`${vod.PREFIX}${s.id}|`);
  // Guides changes : association et telechargement.
  if ((input.useProviderGuide !== undefined || input.epgUrls !== undefined) && !(input.server || input.url || input.username || input.password)) {
    epg.mapSource(s);
    refreshGuides(s.id).catch(() => {});
  }
  if (input.server || input.url || input.username || input.password || (input.options && Object.keys(input.options).some((k) => !['live', 'movies', 'series', 'excludedMovies', 'excludedSeries'].includes(k)))) refresh(s.id).catch(() => {});
  return s;
}

function remove(id) {
  const c = config.get();
  const s = byId(id);
  if (!s) throw new Error('Source introuvable');
  c.iptv = c.iptv.filter((x) => x !== s);
  for (const p of c.profiles) p.iptv = (p.iptv || []).filter((a) => a.lib !== s.id);
  config.save();
  store.drop(s.id);
  vod.drop(s.id);
  runtime.delete(s.id);
  log(`source retirée : ${s.name}`);
}

/** Attribue une source a un profil (a la fin), ou change son mode s'il l'a deja. */
function install(p, s, mode) {
  if (s.owner && s.owner !== p.id) throw new Error("Cette source est privée : elle n'est utilisable que par son propriétaire");
  if (!config.MODES.includes(mode)) mode = config.get().settings.addonMode;
  p.iptv = p.iptv || [];
  const a = p.iptv.find((x) => x.lib === s.id);
  if (a) {
    a.mode = mode;
    return 'updated';
  }
  p.iptv.push({ lib: s.id, enabled: true, mode });
  return 'added';
}

/** Une source vers plusieurs profils (cases a cocher de l'admin). */
function assignToProfiles(id, profileIds, mode) {
  const s = byId(id);
  if (!s) throw new Error('Source introuvable');
  const results = [].concat(profileIds || []).map((pid) => {
    const p = config.getProfile(pid);
    if (!p) return { profileId: pid, ok: false, error: 'Profil introuvable' };
    try {
      return { profileId: p.id, ok: true, action: install(p, s, mode) };
    } catch (e) {
      return { profileId: p.id, ok: false, error: e.message };
    }
  });
  config.save();
  return { applied: results.filter((r) => r.ok).length, results };
}

/** Source d'un profil : activation, mode, ou retrait. */
function setForProfile(p, id, { enabled, mode, remove: drop } = {}) {
  const a = (p.iptv || []).find((x) => x.lib === id);
  if (!a) throw new Error('Source absente de ce profil');
  if (drop) p.iptv = p.iptv.filter((x) => x !== a);
  if (typeof enabled === 'boolean') a.enabled = enabled;
  if (mode !== undefined) {
    if (!config.MODES.includes(mode)) throw new Error('Mode de lecture invalide');
    a.mode = mode;
  }
  config.save();
}

/** Ordre des sources d'un profil : liste complete de leurs ids. */
function orderForProfile(p, idList) {
  const cur = p.iptv || [];
  if (!Array.isArray(idList) || idList.length !== cur.length || !cur.every((a) => idList.includes(a.lib))) throw new Error('Ordre invalide');
  p.iptv = idList.map((id) => cur.find((a) => a.lib === id));
  config.save();
}

/** Sources actives d'un profil, dans son ordre : [{ source, mode }]. */
function activeFor(profile) {
  return (profile?.iptv || [])
    .filter((a) => a.enabled !== false)
    .map((a) => ({ source: byId(a.lib), mode: a.mode }))
    .filter((x) => x.source && (!x.source.owner || x.source.owner === profile.id));
}

/** Ids des sources actives d'un profil qui importent les chaines en direct. */
function liveSourcesFor(profile) {
  return activeFor(profile)
    .filter((x) => x.source.options?.live !== false)
    .map((x) => x.source.id);
}

/** Mode de lecture d'une source pour un profil. */
function modeFor(profile, sourceId) {
  return (profile?.iptv || []).find((a) => a.lib === sourceId)?.mode || config.get().settings.addonMode;
}

// Actualisation reguliere : chaque source une fois son delai passe (verifie toutes les 10 min).
let timer = null;
function startRefreshing() {
  clearInterval(timer);
  const tick = async () => {
    for (const s of [...all()]) {
      if (s.lastRefresh && Date.now() - s.lastRefresh < refreshEvery()) continue;
      await refresh(s.id).catch(() => {});
    }
  };
  setTimeout(tick, 90e3).unref();
  // Ids TMDB des films et series sans id : recherche en arriere-plan (reprend ou elle en etait).
  setTimeout(() => {
    for (const s of all()) vod.resolveSource(s).catch(() => {});
  }, 120e3).unref();
  timer = setInterval(tick, 10 * 60e3);
  timer.unref();
}

module.exports = {
  KINDS,
  all,
  byId,
  list,
  describe,
  preview,
  add,
  update,
  remove,
  refresh,
  refreshGuides,
  install,
  assignToProfiles,
  setForProfile,
  orderForProfile,
  activeFor,
  liveSourcesFor,
  modeFor,
  startRefreshing,
  stateOf
};
