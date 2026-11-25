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

  -- Listes des catalogues deja chargees (titres dans l'ordre, "type|id"), gardees entre deux
  -- demarrages : une bibliotheque s'ouvre tout de suite et se met a jour en arriere-plan.
  CREATE TABLE IF NOT EXISTS lists (
    key       TEXT PRIMARY KEY,
    items     TEXT NOT NULL,
    raw       INTEGER NOT NULL DEFAULT 0,
    page_size INTEGER NOT NULL DEFAULT 0,
    last_size INTEGER NOT NULL DEFAULT 0,
    done      INTEGER NOT NULL DEFAULT 0,
    updated   INTEGER NOT NULL,
    used      INTEGER NOT NULL
  );

  -- IPTV : groupes et chaines de chaque source (compte Xtream, liste M3U), rapproches a chaque
  -- telechargement. Les colonnes custom_* (et enabled) sont les modifications faites dans
  -- l'admin : elles restent quand le fournisseur met a jour ses champs.
  CREATE TABLE IF NOT EXISTS iptv_groups (
    source          TEXT NOT NULL,
    key             TEXT NOT NULL,
    name            TEXT NOT NULL,
    custom_name     TEXT,
    position        INTEGER NOT NULL DEFAULT 0,
    custom_position INTEGER,
    enabled         INTEGER NOT NULL DEFAULT 1,
    added           INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (source, key)
  );
  CREATE TABLE IF NOT EXISTS iptv_channels (
    source          TEXT NOT NULL,
    key             TEXT NOT NULL,
    uuid            TEXT NOT NULL,
    name            TEXT NOT NULL,
    custom_name     TEXT,
    logo            TEXT,
    custom_logo     TEXT,
    number          TEXT,
    custom_number   TEXT,
    group_key       TEXT,
    custom_group    TEXT,
    position        INTEGER NOT NULL DEFAULT 0,
    custom_position INTEGER,
    enabled         INTEGER NOT NULL DEFAULT 1,
    url             TEXT NOT NULL,
    headers         TEXT,
    epg_id          TEXT,
    custom_epg      TEXT,
    archive_days    INTEGER NOT NULL DEFAULT 0,
    catchup         TEXT,
    PRIMARY KEY (source, key)
  );
  CREATE INDEX IF NOT EXISTS iptv_channels_uuid ON iptv_channels (uuid);

  -- Guides des programmes (XMLTV) : chaines de chaque guide (pour l'association) et programmes,
  -- dans la fenetre du guide (7 jours passes pour le replay, 8 jours a venir), remplaces a chaque
  -- telechargement du guide. guide = empreinte de son adresse (jamais l'adresse elle-meme).
  CREATE TABLE IF NOT EXISTS epg_channels (
    guide TEXT NOT NULL,
    id    TEXT NOT NULL,
    names TEXT NOT NULL,
    icon  TEXT,
    PRIMARY KEY (guide, id)
  );
  CREATE TABLE IF NOT EXISTS epg_programs (
    guide      TEXT NOT NULL,
    channel    TEXT NOT NULL,
    start      INTEGER NOT NULL,
    stop       INTEGER NOT NULL,
    title      TEXT NOT NULL,
    subtitle   TEXT,
    descr      TEXT,
    categories TEXT,
    icon       TEXT,
    season     INTEGER,
    episode    INTEGER,
    rerun      INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (guide, channel, start)
  );
  CREATE INDEX IF NOT EXISTS epg_programs_stop ON epg_programs (guide, channel, stop);

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

// Index des catalogues (essai sur la branche dev, retire) : ses tables sont supprimees.
db.exec('DROP TABLE IF EXISTS idx_items; DROP TABLE IF EXISTS idx_titles; DROP TABLE IF EXISTS idx_lists; DROP TABLE IF EXISTS idx_avail;');

// Migration : guide associe a chaque chaine IPTV (calcule : guide et id de la chaine du guide).
{
  const cols = db.prepare('PRAGMA table_info(iptv_channels)').all().map((c) => c.name);
  if (!cols.includes('epg_guide')) db.exec('ALTER TABLE iptv_channels ADD COLUMN epg_guide TEXT');
  if (!cols.includes('epg_channel')) db.exec('ALTER TABLE iptv_channels ADD COLUMN epg_channel TEXT');
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
  listGet: db.prepare('SELECT * FROM lists WHERE key = ?'),
  listPut: db.prepare(`INSERT INTO lists (key, items, raw, page_size, last_size, done, updated, used) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET items = excluded.items, raw = excluded.raw, page_size = excluded.page_size,
      last_size = excluded.last_size, done = excluded.done, updated = excluded.updated, used = excluded.used`),
  listUsed: db.prepare('UPDATE lists SET used = ? WHERE key = ?'),
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

// La base n'est jamais nettoyee : fiches, listes des catalogues et reponses en cache sont toutes
// gardees (une reponse perimee est remplacee quand elle est relue).

module.exports = { db, st, transaction };
