// Groupes et chaines IPTV en base (tables iptv_groups / iptv_channels de db.js).
// A chaque telechargement, la liste du fournisseur est rapprochee de ce qui est en base, par cles
// stables : id Xtream de la chaine, sinon tvg-id + groupe + nom (M3U). Les modifications faites
// dans l'admin (colonnes custom_*, activation, ordre) restent ; le nom, le logo, le numero,
// l'adresse et l'id du guide du fournisseur sont mis a jour en dessous. Ce que la liste ne donne
// plus disparait, avec ses modifications. Les groupes ajoutes a la main (added = 1) restent.
const crypto = require('crypto');
const { db, transaction } = require('../db');
const ids = require('../ids');

const q = {
  groups: db.prepare('SELECT * FROM iptv_groups WHERE source = ?'),
  groupPut: db.prepare(`INSERT INTO iptv_groups (source, key, name, position, enabled, added) VALUES (?, ?, ?, ?, ?, 0)
    ON CONFLICT(source, key) DO UPDATE SET name = excluded.name, position = excluded.position`),
  groupDel: db.prepare('DELETE FROM iptv_groups WHERE source = ? AND key = ?'),
  channels: db.prepare('SELECT key, uuid FROM iptv_channels WHERE source = ?'),
  chanPut: db.prepare(`INSERT INTO iptv_channels (source, key, uuid, name, logo, number, group_key, position, enabled, url, headers, epg_id, archive_days, catchup)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source, key) DO UPDATE SET name = excluded.name, logo = excluded.logo, number = excluded.number,
      group_key = excluded.group_key, position = excluded.position, url = excluded.url, headers = excluded.headers,
      epg_id = excluded.epg_id, archive_days = excluded.archive_days, catchup = excluded.catchup`),
  chanDel: db.prepare('DELETE FROM iptv_channels WHERE source = ? AND key = ?'),
  dropSource: db.prepare('DELETE FROM iptv_channels WHERE source = ?'),
  dropGroups: db.prepare('DELETE FROM iptv_groups WHERE source = ?'),
  byUuid: db.prepare('SELECT * FROM iptv_channels WHERE uuid = ?'),
  byKey: db.prepare('SELECT * FROM iptv_channels WHERE source = ? AND key = ?'),
  counts: db.prepare(`SELECT COUNT(*) AS total, SUM(c.enabled = 1 AND COALESCE(g.enabled, 1) = 1) AS shown, SUM(c.archive_days > 0) AS archive, SUM(c.epg_channel IS NOT NULL) AS mapped
    FROM iptv_channels c LEFT JOIN iptv_groups g ON g.source = c.source AND g.key = COALESCE(c.custom_group, c.group_key) WHERE c.source = ?`),
  groupCounts: db.prepare(`SELECT COALESCE(custom_group, group_key) AS gk, COUNT(*) AS n, SUM(enabled = 1) AS on_n FROM iptv_channels WHERE source = ? GROUP BY gk`)
};

/** Cle d'un groupe : id de categorie Xtream, sinon son nom. */
function groupKey(e) {
  return e.groupId ? `c:${e.groupId}` : `g:${e.group || ''}`;
}

function channelUuid(source, key) {
  return ids.uuidOf(`chan|${source}|${key}`);
}

/**
 * Rapproche la liste telechargee (entrees "live") de la base. opts : newEnabled (chaines et groupes
 * nouveaux actives), excluded (cles de groupes a desactiver a leur premiere arrivee).
 * Renvoie { groups, channels, added, removed }.
 */
function reconcile(source, entries, { newEnabled = true, excluded = [] } = {}) {
  const skip = new Set(excluded);
  return transaction(() => {
    const oldGroups = new Map(q.groups.all(source).map((g) => [g.key, g]));
    const oldChannels = new Map(q.channels.all(source).map((c) => [c.key, c]));
    const seenGroups = new Set();
    const seenKeys = new Set();
    const groupOrder = [];
    const groupName = new Map();
    for (const e of entries) {
      const gk = groupKey(e);
      if (!groupName.has(gk)) {
        groupName.set(gk, e.group || '');
        groupOrder.push(gk);
      }
    }
    groupOrder.forEach((gk, i) => {
      const enabled = oldGroups.has(gk) ? 1 : skip.has(gk) ? 0 : newEnabled ? 1 : 0;
      q.groupPut.run(source, gk, groupName.get(gk), i, enabled);
      seenGroups.add(gk);
    });
    let added = 0;
    const dup = new Map();
    entries.forEach((e, i) => {
      let key = e.xid ? `x:${e.xid}` : `m:${e.tvgId}|${e.group}|${e.name}`;
      // Deux entrees identiques (meme nom, groupe et tvg-id) : la 2e devient "#2".
      if (seenKeys.has(key)) {
        const n = (dup.get(key) || 1) + 1;
        dup.set(key, n);
        key = `${key}#${n}`;
      }
      seenKeys.add(key);
      const isNew = !oldChannels.has(key);
      if (isNew) added++;
      const uuid = channelUuid(source, key);
      q.chanPut.run(source, key, uuid, e.name, e.logo || null, e.number || null, groupKey(e), i, newEnabled ? 1 : 0, e.url,
        Object.keys(e.headers || {}).length ? JSON.stringify(e.headers) : null, e.tvgId || null, e.catchup?.days || 0,
        e.catchup ? JSON.stringify(e.catchup) : null);
    });
    let removed = 0;
    for (const key of oldChannels.keys()) {
      if (!seenKeys.has(key)) {
        q.chanDel.run(source, key);
        removed++;
      }
    }
    for (const [gk, g] of oldGroups) if (!seenGroups.has(gk) && !g.added) q.groupDel.run(source, gk);
    return { groups: groupOrder.length, channels: entries.length, added, removed };
  });
}

/** Retire tout ce qui concerne une source (source supprimee). */
function drop(source) {
  transaction(() => {
    q.dropSource.run(source);
    q.dropGroups.run(source);
  });
}

// ---- Lecture : champs effectifs (modifications de l'admin sinon fournisseur) ------------

const EFFECTIVE = `c.source, c.key, c.uuid, COALESCE(c.custom_name, c.name) AS name, COALESCE(c.custom_logo, c.logo) AS logo,
  COALESCE(c.custom_number, c.number) AS number, COALESCE(c.custom_group, c.group_key) AS group_key,
  COALESCE(g.custom_name, g.name) AS group_name, c.enabled, c.url, c.headers, COALESCE(c.custom_epg, c.epg_id) AS epg_id,
  c.archive_days, c.catchup, c.epg_guide, c.epg_channel, c.name AS provider_name, c.logo AS provider_logo, c.number AS provider_number,
  c.group_key AS provider_group, c.epg_id AS provider_epg, c.custom_name, c.custom_logo, c.custom_number, c.custom_group, c.custom_epg,
  COALESCE(g.enabled, 1) AS group_enabled`;
const JOIN = 'FROM iptv_channels c LEFT JOIN iptv_groups g ON g.source = c.source AND g.key = COALESCE(c.custom_group, c.group_key)';
const ORDER = 'COALESCE(g.custom_position, g.position, 0), COALESCE(c.custom_position, c.position)';

function row(r) {
  if (!r) return null;
  return { ...r, headers: r.headers ? JSON.parse(r.headers) : {}, catchup: r.catchup ? JSON.parse(r.catchup) : null };
}

/** Chaine par son UUID (id Jellyfin), avec ses champs effectifs. */
function channel(uuid) {
  return row(db.prepare(`SELECT ${EFFECTIVE} ${JOIN} WHERE c.uuid = ?`).get(ids.norm(uuid)));
}

function normalizeSearch(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/**
 * Chaines visibles d'un ensemble de sources (dans l'ordre des sources donne), avec filtres :
 * groups (cles "source|groupe"), uuids (favoris), search (nom), start/limit.
 * Renvoie { items, total }.
 */
function visible(sources, { groups, uuids, search, start = 0, limit = 0 } = {}) {
  if (!sources.length) return { items: [], total: 0 };
  const where = [`c.source IN (${sources.map(() => '?').join(',')})`, 'c.enabled = 1', 'COALESCE(g.enabled, 1) = 1'];
  const args = [...sources];
  if (groups?.length) {
    where.push(`(c.source || '|' || COALESCE(c.custom_group, c.group_key)) IN (${groups.map(() => '?').join(',')})`);
    args.push(...groups);
  }
  if (uuids) {
    if (!uuids.length) return { items: [], total: 0 };
    where.push(`c.uuid IN (${uuids.map(() => '?').join(',')})`);
    args.push(...uuids);
  }
  if (search) {
    where.push("LOWER(COALESCE(c.custom_name, c.name)) LIKE ? ESCAPE '\\'");
    args.push(`%${String(search).toLowerCase().replace(/[%_\\]/g, (m) => '\\' + m)}%`);
  }
  const sourceOrder = `CASE c.source ${sources.map((_, i) => `WHEN ? THEN ${i}`).join(' ')} END`;
  const total = db.prepare(`SELECT COUNT(*) AS n ${JOIN} WHERE ${where.join(' AND ')}`).get(...args).n;
  const page = limit > 0 ? ` LIMIT ${Math.floor(limit)} OFFSET ${Math.max(0, Math.floor(start))}` : start ? ` LIMIT -1 OFFSET ${Math.floor(start)}` : '';
  const items = db
    .prepare(`SELECT ${EFFECTIVE} ${JOIN} WHERE ${where.join(' AND ')} ORDER BY ${sourceOrder}, ${ORDER}${page}`)
    .all(...args, ...sources)
    .map(row);
  return { items, total };
}

/** Groupes visibles (actives, avec au moins une chaine active) des sources donnees. */
function visibleGroups(sources) {
  if (!sources.length) return [];
  const sourceOrder = `CASE g.source ${sources.map((_, i) => `WHEN ? THEN ${i}`).join(' ')} END`;
  return db
    .prepare(`SELECT g.source, g.key, COALESCE(g.custom_name, g.name) AS name, COUNT(c.key) AS n FROM iptv_groups g
      JOIN iptv_channels c ON c.source = g.source AND COALESCE(c.custom_group, c.group_key) = g.key AND c.enabled = 1
      WHERE g.source IN (${sources.map(() => '?').join(',')}) AND g.enabled = 1
      GROUP BY g.source, g.key ORDER BY ${sourceOrder}, COALESCE(g.custom_position, g.position)`)
    .all(...sources, ...sources);
}

// ---- Admin -------------------------------------------------------------------------------

/** Groupes d'une source, dans l'ordre, avec le nombre de chaines (toutes et actives). */
function groupsOf(source) {
  const counts = new Map(q.groupCounts.all(source).map((r) => [r.gk, r]));
  return q.groups
    .all(source)
    .sort((a, b) => (a.custom_position ?? a.position) - (b.custom_position ?? b.position))
    .map((g) => ({
      key: g.key,
      name: g.custom_name || g.name || '',
      providerName: g.name,
      customName: g.custom_name || '',
      enabled: !!g.enabled,
      added: !!g.added,
      channels: counts.get(g.key)?.n || 0,
      enabledChannels: counts.get(g.key)?.on_n || 0
    }));
}

function counts(source) {
  const r = q.counts.get(source) || {};
  return { channels: r.total || 0, shown: r.shown || 0, archive: r.archive || 0, mapped: r.mapped || 0 };
}

/**
 * Chaines d'une source pour l'admin (pages de 100) : filtres group, state (on|off|hidden),
 * search, epg (with|without), archive (true).
 */
function channelsOf(source, { group, state, search, epg, archive, start = 0, limit = 100 } = {}) {
  const where = ['c.source = ?'];
  const args = [source];
  if (group) {
    where.push('COALESCE(c.custom_group, c.group_key) = ?');
    args.push(group);
  }
  if (state === 'on') where.push('c.enabled = 1 AND COALESCE(g.enabled, 1) = 1');
  else if (state === 'off') where.push('c.enabled = 0');
  else if (state === 'hidden') where.push('c.enabled = 1 AND COALESCE(g.enabled, 1) = 0');
  if (search) {
    where.push("(LOWER(COALESCE(c.custom_name, c.name)) LIKE ? ESCAPE '\\' OR LOWER(c.name) LIKE ? ESCAPE '\\')");
    const like = `%${String(search).toLowerCase().replace(/[%_\\]/g, (m) => '\\' + m)}%`;
    args.push(like, like);
  }
  if (archive) where.push('c.archive_days > 0');
  if (epg === 'without') where.push('c.epg_channel IS NULL');
  if (epg === 'with') where.push('c.epg_channel IS NOT NULL');
  const total = db.prepare(`SELECT COUNT(*) AS n ${JOIN} WHERE ${where.join(' AND ')}`).get(...args).n;
  const items = db
    .prepare(`SELECT ${EFFECTIVE} ${JOIN} WHERE ${where.join(' AND ')} ORDER BY ${ORDER} LIMIT ? OFFSET ?`)
    .all(...args, Math.min(500, Math.max(1, limit)), Math.max(0, start))
    .map(row);
  return { items, total };
}

const EDITABLE = { name: 'custom_name', logo: 'custom_logo', number: 'custom_number', group: 'custom_group', epg: 'custom_epg' };

/**
 * Modifie des chaines (cles) d'une source : patch { enabled, name, logo, number, group, epg }.
 * Une valeur vide (ou null) remet celle du fournisseur. Renvoie le nombre de chaines changees.
 */
function updateChannels(source, keys, patch) {
  const sets = [];
  const args = [];
  if (typeof patch.enabled === 'boolean') {
    sets.push('enabled = ?');
    args.push(patch.enabled ? 1 : 0);
  }
  for (const [k, col] of Object.entries(EDITABLE)) {
    if (patch[k] === undefined) continue;
    let v = patch[k] === null ? '' : String(patch[k]).trim();
    if (k === 'number' && v && !/^\d+(\.\d+)?$/.test(v)) throw new Error('Numéro de chaîne invalide');
    if (k === 'logo' && v && !/^https?:\/\//i.test(v)) throw new Error('Adresse du logo invalide');
    if (k === 'name') v = v.slice(0, 200);
    sets.push(`${col} = ?`);
    args.push(v || null);
  }
  if (!sets.length || !keys.length) return 0;
  const st = db.prepare(`UPDATE iptv_channels SET ${sets.join(', ')} WHERE source = ? AND key = ?`);
  return transaction(() => keys.reduce((n, key) => n + st.run(...args, source, key).changes, 0));
}

/** Cles des chaines d'une source dont le nom contient un mot (actions en lot par mot-cle). */
function keysMatching(source, { search, group } = {}) {
  const where = ['c.source = ?'];
  const args = [source];
  if (search) {
    where.push("(LOWER(COALESCE(c.custom_name, c.name)) LIKE ? ESCAPE '\\')");
    args.push(`%${String(search).toLowerCase().replace(/[%_\\]/g, (m) => '\\' + m)}%`);
  }
  if (group) {
    where.push('COALESCE(c.custom_group, c.group_key) = ?');
    args.push(group);
  }
  return db.prepare(`SELECT c.key FROM iptv_channels c WHERE ${where.join(' AND ')}`).all(...args).map((r) => r.key);
}

/** Nouvel ordre des chaines d'un groupe : liste complete de leurs cles. */
function orderChannels(source, keys) {
  const st = db.prepare('UPDATE iptv_channels SET custom_position = ? WHERE source = ? AND key = ?');
  transaction(() => keys.forEach((k, i) => st.run(i, source, k)));
}

/** Groupe : nom (vide = celui du fournisseur), activation. */
function updateGroup(source, key, { name, enabled } = {}) {
  if (name !== undefined) db.prepare('UPDATE iptv_groups SET custom_name = ? WHERE source = ? AND key = ?').run(String(name || '').trim().slice(0, 120) || null, source, key);
  if (typeof enabled === 'boolean') db.prepare('UPDATE iptv_groups SET enabled = ? WHERE source = ? AND key = ?').run(enabled ? 1 : 0, source, key);
}

/** Nouvel ordre des groupes : liste complete de leurs cles. */
function orderGroups(source, keys) {
  const st = db.prepare('UPDATE iptv_groups SET custom_position = ? WHERE source = ? AND key = ?');
  transaction(() => keys.forEach((k, i) => st.run(i, source, k)));
}

/** Groupe ajoute a la main (il reste quand la liste change). */
function addGroup(source, name) {
  const n = String(name || '').trim().slice(0, 120);
  if (!n) throw new Error('Le nom du groupe est obligatoire');
  const key = `u:${crypto.randomBytes(6).toString('hex')}`;
  const max = db.prepare('SELECT MAX(COALESCE(custom_position, position)) AS m FROM iptv_groups WHERE source = ?').get(source).m ?? -1;
  db.prepare('INSERT INTO iptv_groups (source, key, name, position, enabled, added) VALUES (?, ?, ?, ?, 1, 1)').run(source, key, n, max + 1);
  return key;
}

/** Supprime un groupe ajoute a la main : ses chaines retournent dans leur groupe d'origine. */
function removeGroup(source, key) {
  const g = db.prepare('SELECT added FROM iptv_groups WHERE source = ? AND key = ?').get(source, key);
  if (!g) throw new Error('Groupe introuvable');
  if (!g.added) throw new Error('Seuls les groupes ajoutés à la main peuvent être supprimés');
  transaction(() => {
    db.prepare('UPDATE iptv_channels SET custom_group = NULL WHERE source = ? AND custom_group = ?').run(source, key);
    q.groupDel.run(source, key);
  });
}

module.exports = {
  reconcile,
  drop,
  channel,
  visible,
  visibleGroups,
  groupsOf,
  counts,
  channelsOf,
  updateChannels,
  keysMatching,
  orderChannels,
  updateGroup,
  orderGroups,
  addGroup,
  removeGroup,
  groupKey,
  channelUuid,
  normalizeSearch,
  byKey: (source, key) => row(q.byKey.get(source, key))
};
