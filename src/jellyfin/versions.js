// Les deux versions d'un titre : tt... (addons, Cinemeta) et tmdb:... (catalogues TMDB) sont deux
// elements pour les apps. Ce qui est vu ou repris sur l'une vaut pour l'autre : la progression et
// le "vu" sont recopies sur la version jumelle (les favoris et "j'aime", eux, restent a part).
const ids = require('../ids');
const tmdb = require('../tmdb');
const config = require('../config');
const { st, transaction } = require('../db');

const resolved = new Map(); // "type|sid" -> sid de l'autre version (ou null)

async function otherSid(type, sid) {
  const k = `${type}|${sid}`;
  if (resolved.has(k)) return resolved.get(k);
  if (!tmdb.enabled()) return null;
  let other = null;
  try {
    const m = String(sid).match(/^tmdb:(\d+)$/);
    if (/^tt\d+$/.test(sid)) {
      const r = await tmdb.resolve(type, sid);
      other = r?.id ? `tmdb:${r.id}` : null;
    } else if (m) {
      other = await tmdb.imdbIdOf(type, m[1]);
    }
  } catch {
    return null; // panne passagere : pas garde, on reessaiera
  }
  resolved.set(k, other);
  return other;
}

/**
 * Version jumelle d'un film ou d'un episode : { key, kind, data } (a enregistrer), ou null.
 * Episode : meme id video (tt..:s:e), sous l'autre version de la serie.
 */
async function siblingOf(entry) {
  if (!entry) return null;
  if (entry.kind === 'movie') {
    const sid = entry.key.slice('item|movie|'.length);
    const other = entry.data.twin ? ids.get(entry.data.twin)?.key.slice('item|movie|'.length) : await otherSid('movie', sid);
    if (!other || other === sid) return null;
    return { key: `item|movie|${other}`, kind: 'movie', data: { ...entry.data, sid: other, twin: entry.uuid } };
  }
  if (entry.kind === 'episode') {
    const [, seriesSid, vid] = entry.key.split('|');
    if (!seriesSid || !vid) return null;
    const other = await otherSid('series', seriesSid);
    if (!other || other === seriesSid) return null;
    const season = entry.data.season;
    return {
      key: `ep|${other}|${vid}`,
      kind: 'episode',
      data: { ...entry.data, seriesSid: other, seriesUuid: ids.uuidOf(`item|series|${other}`), seasonUuid: ids.uuidOf(`season|${other}|${season}`) },
      series: { key: `item|series|${other}`, from: entry.data.seriesUuid, sid: other }
    };
  }
  return null;
}

/** Enregistre la version jumelle (et sa serie, pour un episode) et renvoie son uuid. */
function registerSibling(sib, entry) {
  if (sib.series && !ids.get(ids.uuidOf(sib.series.key))) {
    const series = ids.get(sib.series.from);
    if (series) ids.register(sib.series.key, 'series', { ...series.data, sid: sib.series.sid });
  }
  const uuid = ids.register(sib.key, sib.kind, sib.data);
  if (entry.kind === 'movie' && !entry.data.twin) ids.register(entry.key, 'movie', { twin: uuid });
  return uuid;
}

/** Recopie progression et "vu" d'un element sur sa version jumelle. */
async function mirror(profile, uuid) {
  const entry = ids.get(uuid);
  if (!entry || !['movie', 'episode'].includes(entry.kind)) return;
  const sib = await siblingOf(entry);
  if (!sib) return;
  const row = st.udGet.get(profile.id, uuid);
  if (!row) return;
  const twin = registerSibling(sib, entry);
  const cur = st.udGet.get(profile.id, twin);
  if (cur && cur.position === row.position && cur.played === row.played && cur.play_count === row.play_count && cur.last_played === row.last_played) return;
  st.udPut.run(profile.id, twin, row.position, row.played, cur?.favorite || 0, cur?.likes ?? null, row.play_count, row.last_played);
}

/**
 * Une fois : recopie sur leur version jumelle les vus et reprises qui n'y sont pas encore (lectures
 * faites ici et "vu" choisis dans les apps avant ce partage ; les imports marquaient deja les deux).
 */
async function syncAll() {
  const c = config.get();
  if (c.migrations.includes('ud-versions') || !tmdb.enabled()) return 0;
  let n = 0;
  for (const p of c.profiles) {
    const rows = st.udPlayedOrStarted.all(p.id);
    for (const r of rows) {
      const entry = ids.get(r.uuid);
      if (!entry || !['movie', 'episode'].includes(entry.kind)) continue;
      const sib = await siblingOf(entry).catch(() => null);
      if (!sib) continue;
      const twin = ids.uuidOf(sib.key);
      const cur = st.udGet.get(p.id, twin);
      if (cur && (cur.played || cur.position) && (cur.last_played || 0) >= (r.last_played || 0)) continue;
      transaction(() => {
        registerSibling(sib, entry);
        st.udPut.run(p.id, twin, r.position, r.played, cur?.favorite || 0, cur?.likes ?? null, r.play_count, r.last_played);
      });
      n++;
    }
  }
  c.migrations.push('ud-versions');
  config.save();
  return n;
}

/**
 * Une fois : episodes importes avant que l'id IMDb des series soit retrouve (Scrob ne donne que
 * l'id TMDB) et ranges sous un id video tmdb:N:s:e, alors que la fiche de la serie (TMDB, avec
 * son id IMDb) utilise tt..:s:e. Ils sont recopies sous l'id video de la fiche, pour les deux
 * versions de la serie, puis retires : la fiche, "A suivre" et les pastilles les voient enfin.
 */
async function rekeyTmdbVids() {
  const c = config.get();
  if (c.migrations.includes('ud-vids') || !tmdb.enabled()) return 0;
  const rows = st.udTmdbVidEpisodes.all();
  const imdbOf = new Map(); // id TMDB de la serie -> tt... (ou null)
  let n = 0;
  for (const r of rows) {
    const d = JSON.parse(r.data);
    const m = String(d.vid || '').match(/^tmdb:(\d+):(\d+):(\d+)$/);
    if (!m) continue;
    if (!imdbOf.has(m[1])) imdbOf.set(m[1], await tmdb.imdbIdOf('series', m[1]).catch(() => undefined));
    const imdb = imdbOf.get(m[1]);
    if (imdb === undefined) continue; // panne passagere : ligne gardee telle quelle
    if (!imdb) continue; // serie sans id IMDb : sa fiche utilise aussi tmdb:N:s:e
    const vid = `${imdb}:${m[2]}:${m[3]}`;
    transaction(() => {
      for (const sid of [`tmdb:${m[1]}`, imdb]) {
        const key = `ep|${sid}|${vid}`;
        const uuid = ids.register(key, 'episode', {
          ...d,
          vid,
          tmdbVid: d.vid,
          seriesSid: sid,
          seriesUuid: ids.uuidOf(`item|series|${sid}`),
          seasonUuid: ids.uuidOf(`season|${sid}|${Number(m[2])}`)
        });
        const cur = st.udGet.get(r.profile, uuid);
        // La ligne la plus recente (ou deja vue) l'emporte.
        if (cur && (cur.last_played || 0) >= (r.last_played || 0) && (cur.played || !r.played)) continue;
        st.udPut.run(r.profile, uuid, r.position, r.played || cur?.played || 0, cur?.favorite || 0, cur?.likes ?? null, Math.max(r.play_count || 0, cur?.play_count || 0), Math.max(r.last_played || 0, cur?.last_played || 0) || null);
      }
      st.udDel.run(r.profile, r.uuid);
    });
    n++;
  }
  c.migrations.push('ud-vids');
  config.save();
  return n;
}

module.exports = { mirror, syncAll, rekeyTmdbVids };
