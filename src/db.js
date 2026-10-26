const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');
const { DATA_DIR } = require('./config');

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'stremfin.db'));

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;

  -- Correspondance id Jellyfin (UUID) <-> objet Stremio (film, serie, saison, episode, catalogue...)
  CREATE TABLE IF NOT EXISTS ids (
    uuid TEXT PRIMARY KEY,
    key  TEXT NOT NULL,
    kind TEXT NOT NULL,
    data TEXT NOT NULL
  );

  -- Cache des reponses d'addons (catalogues, fiches, sources).
  CREATE TABLE IF NOT EXISTS cache (
    key     TEXT PRIMARY KEY,
    value   TEXT NOT NULL,
    expires INTEGER NOT NULL
  );

  -- Sessions des applications Jellyfin.
  CREATE TABLE IF NOT EXISTS tokens (
    token     TEXT PRIMARY KEY,
    profile   TEXT NOT NULL,
    device_id TEXT,
    device    TEXT,
    client    TEXT,
    version   TEXT,
    created   INTEGER NOT NULL,
    last_seen INTEGER NOT NULL
  );

  -- Progression, vu, favoris, j'aime : par profil et par element.
  CREATE TABLE IF NOT EXISTS userdata (
    profile     TEXT NOT NULL,
    uuid        TEXT NOT NULL,
    position    INTEGER NOT NULL DEFAULT 0,
    played      INTEGER NOT NULL DEFAULT 0,
    favorite    INTEGER NOT NULL DEFAULT 0,
    likes       INTEGER,
    play_count  INTEGER NOT NULL DEFAULT 0,
    last_played INTEGER,
    PRIMARY KEY (profile, uuid)
  );
  CREATE INDEX IF NOT EXISTS userdata_last ON userdata (profile, last_played);

  -- Historique des lectures : locales (apps) ou importees (trakt, simkl, nuvio).
  -- Une ligne par visionnage ; durees en ms.
  CREATE TABLE IF NOT EXISTS plays (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    profile  TEXT NOT NULL,
    uuid     TEXT NOT NULL,
    kind     TEXT,
    title    TEXT,
    series   TEXT,
    started  INTEGER NOT NULL,
    ended    INTEGER,
    watched  INTEGER NOT NULL DEFAULT 0,
    position INTEGER NOT NULL DEFAULT 0,
    duration INTEGER NOT NULL DEFAULT 0,
    release  TEXT,
    bitrate  INTEGER,
    client   TEXT,
    device   TEXT,
    source   TEXT NOT NULL DEFAULT 'local'
  );
  CREATE UNIQUE INDEX IF NOT EXISTS plays_unique ON plays (profile, uuid, source, started);
  CREATE INDEX IF NOT EXISTS plays_profile ON plays (profile, started);

  -- Index des catalogues : listes lues en entier en arriere-plan (catalogIndex.js).
  -- Une ligne par liste, une par titre de chaque liste (dans l'ordre du catalogue), et l'apercu
  -- de chaque titre une seule fois (nom, affiche, annee, note, genres...).
  CREATE TABLE IF NOT EXISTS idx_lists (
    key      TEXT PRIMARY KEY,
    name     TEXT,
    type     TEXT,
    source   TEXT,
    count    INTEGER NOT NULL DEFAULT 0,
    complete INTEGER NOT NULL DEFAULT 0,
    full_at  INTEGER,
    quick_at INTEGER,
    duration INTEGER,
    error    TEXT
  );
  CREATE TABLE IF NOT EXISTS idx_items (
    list  TEXT NOT NULL,
    pos   INTEGER NOT NULL,
    id    TEXT NOT NULL,
    added INTEGER NOT NULL,
    PRIMARY KEY (list, pos)
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS idx_titles (
    id      TEXT PRIMARY KEY,
    type    TEXT,
    data    TEXT NOT NULL,
    updated INTEGER NOT NULL
  );
  -- Date de sortie en VOD / DVD / TV de chaque titre (option "seulement ce qui est sorti"),
  -- verifiee pendant le scan : at = date (ms), 0 = inconnu (disponible), 9e15 = sans date.
  CREATE TABLE IF NOT EXISTS idx_avail (
    id      TEXT PRIMARY KEY,
    at      INTEGER NOT NULL,
    checked INTEGER NOT NULL
  );

  -- Sessions de l'interface d'administration (seul le hache du jeton est stocke).
  CREATE TABLE IF NOT EXISTS admin_sessions (
    token_hash TEXT PRIMARY KEY,
    created    INTEGER NOT NULL,
    expires    INTEGER NOT NULL,
    ip         TEXT,
    user_agent TEXT
  );
`);

// Migration : addon d'origine des lectures (classement "Addons les plus actifs").
{
  const cols = db.prepare('PRAGMA table_info(plays)').all().map((c) => c.name);
  if (!cols.includes('addon')) db.exec('ALTER TABLE plays ADD COLUMN addon TEXT');
  if (!cols.includes('addon_logo')) db.exec('ALTER TABLE plays ADD COLUMN addon_logo TEXT');
}

// Migration : role (admin | user) et profil des sessions de l'interface web.
{
  const cols = db.prepare('PRAGMA table_info(admin_sessions)').all().map((c) => c.name);
  if (!cols.includes('role')) db.exec("ALTER TABLE admin_sessions ADD COLUMN role TEXT NOT NULL DEFAULT 'admin'");
  if (!cols.includes('profile')) db.exec('ALTER TABLE admin_sessions ADD COLUMN profile TEXT');
}

const st = {
  idGet: db.prepare('SELECT key, kind, data FROM ids WHERE uuid = ?'),
  idPut: db.prepare('INSERT INTO ids (uuid, key, kind, data) VALUES (?, ?, ?, ?) ON CONFLICT(uuid) DO UPDATE SET data = excluded.data, kind = excluded.kind'),
  cacheGet: db.prepare('SELECT value, expires FROM cache WHERE key = ?'),
  cachePut: db.prepare('INSERT INTO cache (key, value, expires) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires = excluded.expires'),
  cachePurge: db.prepare('DELETE FROM cache WHERE expires < ?'),
  tokenGet: db.prepare('SELECT * FROM tokens WHERE token = ?'),
  tokenPut: db.prepare('INSERT INTO tokens (token, profile, device_id, device, client, version, created, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
  tokenSeen: db.prepare('UPDATE tokens SET last_seen = ? WHERE token = ?'),
  tokenDel: db.prepare('DELETE FROM tokens WHERE token = ?'),
  tokenDelDevice: db.prepare('DELETE FROM tokens WHERE profile = ? AND device_id = ?'),
  tokenDelProfile: db.prepare('DELETE FROM tokens WHERE profile = ?'),
  tokenList: db.prepare('SELECT * FROM tokens ORDER BY last_seen DESC'),
  udGet: db.prepare('SELECT * FROM userdata WHERE profile = ? AND uuid = ?'),
  udPut: db.prepare(`INSERT INTO userdata (profile, uuid, position, played, favorite, likes, play_count, last_played)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(profile, uuid) DO UPDATE SET position = excluded.position, played = excluded.played,
      favorite = excluded.favorite, likes = excluded.likes, play_count = excluded.play_count, last_played = excluded.last_played`),
  // Reprise : toute position gardee, meme sur un titre deja vu (revisionnage arrete en cours), comme Jellyfin.
  udResume: db.prepare('SELECT * FROM userdata WHERE profile = ? AND position > 0 ORDER BY last_played DESC LIMIT ?'),
  udPlayedOrStarted: db.prepare('SELECT * FROM userdata WHERE profile = ? AND (played = 1 OR position > 0)'),
  // "A suivre" : episodes touches depuis une date (vus, en cours ou seulement lances), avec leur fiche.
  udEpisodesSince: db.prepare(`SELECT u.uuid, u.played, u.position, u.last_played, i.data FROM userdata u JOIN ids i ON i.uuid = u.uuid
    WHERE u.profile = ? AND i.kind = 'episode' AND u.last_played >= ?`),
  // Episodes ranges sous un id video TMDB (tmdb:N:s:e), tous profils.
  udTmdbVidEpisodes: db.prepare(`SELECT u.*, i.data FROM userdata u JOIN ids i ON i.uuid = u.uuid
    WHERE i.kind = 'episode' AND i.data LIKE '%"vid":"tmdb:%'`),
  udDel: db.prepare('DELETE FROM userdata WHERE profile = ? AND uuid = ?'),
  // Index des catalogues.
  idxListGet: db.prepare('SELECT * FROM idx_lists WHERE key = ?'),
  idxListAll: db.prepare('SELECT * FROM idx_lists ORDER BY name'),
  idxListPut: db.prepare(`INSERT INTO idx_lists (key, name, type, source, count, complete, full_at, quick_at, duration, error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET name = excluded.name, type = excluded.type, source = excluded.source, count = excluded.count,
      complete = excluded.complete, full_at = excluded.full_at, quick_at = excluded.quick_at, duration = excluded.duration, error = excluded.error`),
  idxListError: db.prepare('UPDATE idx_lists SET error = ? WHERE key = ?'),
  idxListDel: db.prepare('DELETE FROM idx_lists WHERE key = ?'),
  idxItems: db.prepare('SELECT id, added FROM idx_items WHERE list = ? ORDER BY pos'),
  // Toute une liste indexee (tris et filtres des apps).
  idxRows: db.prepare(`SELECT i.id, i.pos, i.added, t.type, t.data, a.at FROM idx_items i JOIN idx_titles t ON t.id = i.id
    LEFT JOIN idx_avail a ON a.id = i.id WHERE i.list = ? ORDER BY i.pos`),
  // Une page d'une liste indexee (positions continues 0..n-1), avec l'apercu de chaque titre.
  idxPage: db.prepare(`SELECT i.id, t.type, t.data, a.at FROM idx_items i JOIN idx_titles t ON t.id = i.id
    LEFT JOIN idx_avail a ON a.id = i.id WHERE i.list = ? AND i.pos >= ? ORDER BY i.pos LIMIT ?`),
  // Titres dont la date de sortie est a verifier : jamais verifies, ou pas encore sortis et
  // verifies avant `?` (un titre sorti ne change plus).
  idxAvailDue: db.prepare(`SELECT t.id, t.type, t.data FROM idx_titles t LEFT JOIN idx_avail a ON a.id = t.id
    WHERE a.id IS NULL OR (a.at > ? AND a.checked < ?)`),
  idxAvailPut: db.prepare(`INSERT INTO idx_avail (id, at, checked) VALUES (?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET at = excluded.at, checked = excluded.checked`),
  // Titres d'une liste dont la date de sortie n'est pas encore connue.
  idxAvailMissing: db.prepare('SELECT COUNT(*) AS n FROM idx_items i LEFT JOIN idx_avail a ON a.id = i.id WHERE i.list = ? AND a.id IS NULL'),
  idxAvailOrphan: db.prepare('DELETE FROM idx_avail WHERE id NOT IN (SELECT id FROM idx_titles)'),
  idxItemsDel: db.prepare('DELETE FROM idx_items WHERE list = ?'),
  idxItemPut: db.prepare('INSERT INTO idx_items (list, pos, id, added) VALUES (?, ?, ?, ?)'),
  idxTitlePut: db.prepare(`INSERT INTO idx_titles (id, type, data, updated) VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET type = excluded.type, data = excluded.data, updated = excluded.updated`),
  // Apercus qui ne figurent plus dans aucune liste.
  idxTitlesOrphan: db.prepare('DELETE FROM idx_titles WHERE id NOT IN (SELECT DISTINCT id FROM idx_items)'),
  idxStats: db.prepare(`SELECT (SELECT COUNT(*) FROM idx_lists) AS lists, (SELECT COUNT(*) FROM idx_items) AS items,
    (SELECT COUNT(*) FROM idx_titles) AS titles, (SELECT COALESCE(SUM(LENGTH(data)), 0) FROM idx_titles) AS bytes`),
  // Episodes vus (pastille "episodes restants" et coche des series).
  udPlayedEpisodes: db.prepare(`SELECT i.data FROM userdata u JOIN ids i ON i.uuid = u.uuid
    WHERE u.profile = ? AND i.kind = 'episode' AND u.played = 1`),
  udFavorites: db.prepare('SELECT * FROM userdata WHERE profile = ? AND favorite = 1 ORDER BY last_played DESC'),
  udRecent: db.prepare('SELECT * FROM userdata WHERE profile = ? AND last_played IS NOT NULL ORDER BY last_played DESC LIMIT ?'),
  udPlayed: db.prepare('SELECT uuid FROM userdata WHERE profile = ? AND played = 1'),
  udDelProfile: db.prepare('DELETE FROM userdata WHERE profile = ?'),
  playImport: db.prepare(`INSERT OR IGNORE INTO plays (profile, uuid, kind, title, series, started, ended, watched, duration, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  playDelProfile: db.prepare('DELETE FROM plays WHERE profile = ?'),
  // Meme titre (une de ses deux versions) deja dans l'historique a quelques heures pres, venu d'une
  // autre source (meme lecture vue par deux services). Une meme source ne se double pas : deux
  // visionnages rapproches qu'elle donne sont bien deux visionnages.
  playNear: db.prepare('SELECT 1 FROM plays WHERE profile = ? AND uuid IN (?, ?) AND started BETWEEN ? AND ? AND source != ? LIMIT 1'),
  udCount: db.prepare('SELECT COUNT(*) AS n FROM userdata WHERE profile = ? AND (played = 1 OR position > 0)'),
  cacheCount: db.prepare('SELECT COUNT(*) AS n FROM cache'),
  idsCount: db.prepare('SELECT COUNT(*) AS n FROM ids'),
  adminSessionGet: db.prepare('SELECT * FROM admin_sessions WHERE token_hash = ? AND expires > ?'),
  adminSessionPut: db.prepare('INSERT INTO admin_sessions (token_hash, created, expires, ip, user_agent, role, profile) VALUES (?, ?, ?, ?, ?, ?, ?)'),
  adminSessionDelProfile: db.prepare("DELETE FROM admin_sessions WHERE role = 'user' AND profile = ?"),
  adminSessionDel: db.prepare('DELETE FROM admin_sessions WHERE token_hash = ?'),
  adminSessionDelOthers: db.prepare("DELETE FROM admin_sessions WHERE token_hash <> ? AND role = 'admin'"),
  adminSessionDelAll: db.prepare('DELETE FROM admin_sessions'),
  adminSessionList: db.prepare("SELECT * FROM admin_sessions WHERE expires > ? AND role = 'admin' ORDER BY created DESC"),
  adminSessionPurge: db.prepare('DELETE FROM admin_sessions WHERE expires <= ?')
};

function transaction(fn) {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// Menage du cache expire depuis plus d'une semaine.
setInterval(() => {
  try { st.cachePurge.run(Date.now() - 7 * 864e5); } catch {}
}, 6 * 3600e3).unref();

module.exports = { db, st, transaction };
