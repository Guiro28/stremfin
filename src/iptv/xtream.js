// Compte Xtream Codes : API player_api.php (sur le modele de Polyfin, internal/iptv/fetch.go).
//   connexion        player_api.php?username=&password=            -> user_info, server_info
//   chaines          action=get_live_categories / get_live_streams
//   films            action=get_vod_categories / get_vod_streams / get_vod_info
//   series           action=get_series_categories / get_series / get_series_info
//   guide court      action=get_short_epg&stream_id=
// Adresses des flux : {serveur}/live/{u}/{p}/{id}.ts (ou .m3u8 si le compte n'autorise que HLS),
// {serveur}/movie/{u}/{p}/{id}.{ext}, {serveur}/series/{u}/{p}/{id}.{ext}, et le replay
// {serveur}/timeshift/{u}/{p}/{minutes}/{AAAA-MM-JJ:HH-MM}/{id}.ts.
const fetch = require('./fetch');

/** "hote:port", "http://hote:port/", "http://hote/player_api.php?..." -> "http://hote:port". */
function normalizeServer(server) {
  let s = String(server || '').trim();
  if (!s) throw new Error("L'adresse du serveur est obligatoire");
  if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
  let u;
  try {
    u = new URL(s);
  } catch {
    throw new Error('Adresse du serveur invalide');
  }
  // Chemin d'un panneau installe dans un sous-dossier : garde, sans player_api.php / get.php.
  const p = u.pathname.replace(/\/(player_api|get|xmltv)\.php$/i, '').replace(/\/+$/, '');
  return `${u.protocol}//${u.host}${p}`;
}

function enc(s) {
  return encodeURIComponent(String(s ?? ''));
}

function apiUrl(src, action, params = {}) {
  const q = new URLSearchParams({ username: src.username, password: src.password });
  if (action) q.set('action', action);
  for (const [k, v] of Object.entries(params)) q.set(k, v);
  return `${src.server}/player_api.php?${q}`;
}

async function call(src, action, params, max) {
  return fetch.json(apiUrl(src, action, params), { source: src, timeout: 60000, max });
}

/** Connexion : etat du compte. Erreur si les identifiants sont refuses. */
async function login(src) {
  const r = await call(src, null, {}, 1e6);
  const u = r?.user_info;
  if (!u || Number(u.auth) !== 1) throw new Error('Identifiants refusés par le serveur Xtream');
  if (u.status && !/^active$/i.test(u.status)) throw new Error(`Compte ${String(u.status).toLowerCase()}`);
  const formats = Array.isArray(u.allowed_output_formats) ? u.allowed_output_formats.map(String) : [];
  return {
    status: u.status || 'Active',
    expires: Number(u.exp_date) > 0 ? Number(u.exp_date) * 1000 : null,
    maxConnections: Number(u.max_connections) || 0,
    activeConnections: Number(u.active_cons) || 0,
    trial: String(u.is_trial) === '1',
    formats,
    // Le compte autorise le MPEG-TS (ou ne dit rien) : flux .ts ; sinon HLS.
    liveExt: !formats.length || formats.includes('ts') ? 'ts' : 'm3u8',
    timezone: r.server_info?.timezone || '',
    serverTime: Number(r.server_info?.timestamp_now) * 1000 || null
  };
}

function list(x) {
  return Array.isArray(x) ? x : x && typeof x === 'object' ? Object.values(x) : [];
}

async function categories(src, kind) {
  const action = { live: 'get_live_categories', movie: 'get_vod_categories', series: 'get_series_categories' }[kind];
  const r = list(await call(src, action, {}, 5e6));
  if (r.length > 10000) throw new Error('Trop de catégories (plus de 10 000)');
  return r.map((c) => ({ id: String(c.category_id), name: String(c.category_name || '').trim() || `#${c.category_id}` }));
}

/** Chaines en direct du compte, au format des entrees M3U (voir m3u.parse). */
async function liveEntries(src, account) {
  const [cats, streams] = await Promise.all([categories(src, 'live'), call(src, 'get_live_streams', {}, 100e6).then(list)]);
  if (streams.length > 100000) throw new Error('Trop de chaînes (plus de 100 000)');
  const catName = new Map(cats.map((c) => [c.id, c.name]));
  const ext = account?.liveExt || 'ts';
  const entries = [];
  for (const s of streams) {
    const id = s.stream_id;
    const name = String(s.name || '').trim();
    if (id === undefined || !name) continue;
    const cat = String(s.category_id ?? (Array.isArray(s.category_ids) ? s.category_ids[0] : ''));
    const archive = Number(s.tv_archive) === 1 ? Number(s.tv_archive_duration) || 0 : 0;
    entries.push({
      kind: 'live',
      xid: String(id),
      name,
      tvgId: String(s.epg_channel_id || ''),
      tvgName: '',
      logo: /^https?:\/\//i.test(s.stream_icon || '') ? s.stream_icon : '',
      number: s.num !== undefined && /^\d+(\.\d+)?$/.test(String(s.num)) ? String(s.num) : '',
      group: catName.get(cat) || '',
      groupId: cat,
      url: `${src.server}/live/${enc(src.username)}/${enc(src.password)}/${id}.${ext}`,
      headers: {},
      catchup: archive > 0 ? { mode: 'xc', days: archive, source: '' } : null
    });
  }
  return { categories: cats, entries };
}

/** Adresse du guide XMLTV que le serveur publie pour le compte. */
function guideUrl(src) {
  return `${src.server}/xmltv.php?username=${enc(src.username)}&password=${enc(src.password)}`;
}

/** Adresse d'un film ou d'un episode. */
function vodUrl(src, kind, id, ext) {
  return `${src.server}/${kind === 'series' ? 'series' : 'movie'}/${enc(src.username)}/${enc(src.password)}/${id}.${ext || 'mp4'}`;
}

/** Adresse du replay d'une chaine : debut (ms), duree (minutes). L'heure est celle du serveur. */
function timeshiftUrl(src, streamId, start, minutes, timezone) {
  const d = new Date(start);
  let parts;
  try {
    const f = new Intl.DateTimeFormat('en-CA', { timeZone: timezone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    parts = Object.fromEntries(f.formatToParts(d).map((p) => [p.type, p.value]));
  } catch {
    parts = { year: d.getUTCFullYear(), month: String(d.getUTCMonth() + 1).padStart(2, '0'), day: String(d.getUTCDate()).padStart(2, '0'), hour: String(d.getUTCHours()).padStart(2, '0'), minute: String(d.getUTCMinutes()).padStart(2, '0') };
  }
  const when = `${parts.year}-${parts.month}-${parts.day}:${parts.hour}-${parts.minute}`;
  return `${src.server}/timeshift/${enc(src.username)}/${enc(src.password)}/${Math.max(1, Math.round(minutes))}/${when}/${streamId}.ts`;
}

module.exports = { normalizeServer, login, categories, liveEntries, guideUrl, vodUrl, timeshiftUrl, call, list, apiUrl };
