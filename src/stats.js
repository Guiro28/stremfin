// Statistiques de visionnage : lectures faites dans les apps (enregistrees ici, avec le temps
// reellement regarde) et historiques importes (Trakt, Simkl, Nuvio), dans la table plays.
// Le calcul et la page reprennent ceux de Nuvio Manager, panneau "Lecture en cours" compris :
// ici, les apps donnent elles-memes la position, la pause et l'arret (positions exactes), et le
// debit est mesure sur les videos qui passent par le serveur. Une lecture arretee quitte le panneau.
const crypto = require('crypto');
const config = require('./config');
const ids = require('./ids');
const { db } = require('./db');

const TICKS = 10000; // ticks Jellyfin par ms
const IDLE = 5 * 60e3; // sans nouvelles depuis 5 min : lecture terminee
const MIN_WATCHED = 30e3; // en dessous : simple essai, pas garde dans l'historique
const TICK = 5000; // mesure du debit toutes les 5 s
const SAMPLES = 12; // courbe du debit : la derniere minute

const q = {
  start: db.prepare(`INSERT INTO plays (profile, uuid, kind, title, series, started, ended, watched, position, duration, release, bitrate, client, device, addon, addon_logo, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, 'local')`),
  update: db.prepare('UPDATE plays SET ended = ?, watched = ?, position = ? WHERE id = ?'),
  drop: db.prepare('DELETE FROM plays WHERE id = ?'),
  range: db.prepare('SELECT * FROM plays WHERE started >= ? AND started < ? ORDER BY started DESC')
};

function log(...args) {
  console.log(new Date().toISOString(), '[stats]', ...args);
}

// ---- Lecture en cours ----------------------------------------------------------------------------

const live = new Map(); // id -> session
const byDevice = new Map(); // "profil|appareil" -> id de la session active

/** Titre lisible pour l'historique : film, ou "Serie · S01E02 · Nom de l'episode". */
function titleOf(entry) {
  if (entry.kind !== 'episode') return { title: entry.data.name || entry.data.sid, series: null };
  const series = ids.get(entry.data.seriesUuid)?.data || {};
  const se = `S${String(entry.data.season).padStart(2, '0')}E${String(entry.data.episode).padStart(2, '0')}`;
  return { title: [series.name, se, entry.data.name].filter(Boolean).join(' · '), series: series.name || null };
}

/** Fin d'une lecture : elle quitte le panneau et rejoint l'historique. */
function finish(s, now = Date.now()) {
  if (!live.has(s.id)) return;
  live.delete(s.id);
  if (byDevice.get(s.deviceKey) === s.id) byDevice.delete(s.deviceKey);
  if (s.watched < MIN_WATCHED) q.drop.run(s.playId);
  else q.update.run(Math.min(now, s.updatedAt + 60e3), Math.round(s.watched), Math.round(s.position), s.playId);
}

/** Lectures sans nouvelles depuis 5 min (app fermee sans prevenir) : terminees. */
function sweep(now = Date.now()) {
  for (const s of [...live.values()]) if (now - s.updatedAt > IDLE) finish(s, now);
}

/**
 * Rapport de lecture d'une app (debut / progression / arret).
 * info : { position, ticks (duree), paused, client, device, deviceId,
 *          source: { release, quality, size, addonName, addonLogo } }.
 */
function onReport(profile, entry, stage, info) {
  const now = Date.now();
  sweep(now);
  const deviceKey = `${profile.id}|${info.deviceId || info.device || info.client || '?'}`;
  let s = live.get(byDevice.get(deviceKey));
  // Autre titre sur le meme appareil : la lecture precedente est terminee.
  if (s && s.uuid !== entry.uuid) {
    finish(s, now);
    s = null;
  }
  const position = Math.round((info.position || 0) / TICKS);
  if (!s) {
    if (stage === 'stopped') return;
    const t = titleOf(entry);
    const duration = info.ticks ? Math.round(info.ticks / TICKS) : 0;
    const src = info.source || {};
    // Debit moyen estime de la release : taille du fichier / duree.
    const bitrate = src.size && duration ? Math.round((src.size * 8) / (duration / 1000)) : null;
    const playId = q.start.run(profile.id, entry.uuid, entry.kind, t.title, t.series, now, now, position, duration, [src.quality, src.release].filter(Boolean).join(' · ') || null, bitrate, info.client || null, info.device || null, src.addonName || null, src.addonLogo || null).lastInsertRowid;
    const id = crypto.createHash('sha1').update(`${deviceKey}|${entry.uuid}|${now}`).digest('hex').slice(0, 16);
    s = {
      id,
      playId,
      deviceKey,
      profileId: profile.id,
      uuid: entry.uuid,
      kind: entry.kind,
      state: info.paused ? 'paused' : 'playing',
      startedAt: now,
      updatedAt: now,
      position,
      duration,
      watched: 0,
      release: src.release || null,
      size: src.size || 0,
      addonName: src.addonName || null,
      addonLogo: src.addonLogo || null,
      client: info.client || null,
      device: info.device || null,
      transferred: 0,
      tickBytes: 0,
      rate: 0,
      series: []
    };
    live.set(id, s);
    byDevice.set(deviceKey, id);
  } else {
    // Temps regarde : ecoule depuis le dernier rapport, hors pause (trous de plus d'1 min ignores).
    if (s.state === 'playing') s.watched += Math.min(now - s.updatedAt, 60e3);
    s.updatedAt = now;
    if (info.position !== undefined && info.position !== null) s.position = position;
    if (info.ticks) s.duration = Math.round(info.ticks / TICKS);
    s.state = info.paused ? 'paused' : 'playing';
  }
  if (stage === 'stopped') finish(s, now);
  else q.update.run(now, Math.round(s.watched), Math.round(s.position), s.playId);
}

/** Octets d'une video relayee par le serveur (modes "Proxy interne" et "Proxy externe") : debit et volume. */
function addBytes(uuid, profileId, n) {
  for (const s of live.values()) {
    if (s.uuid === uuid && (!profileId || s.profileId === profileId)) {
      s.transferred += n;
      s.tickBytes += n;
      return;
    }
  }
}

setInterval(() => {
  for (const s of live.values()) {
    s.rate = Math.round((s.tickBytes * 8) / (TICK / 1000));
    s.tickBytes = 0;
    s.series.push(s.rate);
    if (s.series.length > SAMPLES) s.series.shift();
  }
}, TICK).unref();

/** Lectures en cours au format du panneau "Lecture en cours" de Nuvio Manager, pour les profils donnes (tous si refs est vide). */
function nowPlaying(refs = null) {
  const now = Date.now();
  sweep(now);
  return [...live.values()]
    .filter((s) => !refs || refs.includes(s.profileId))
    .sort((a, b) => b.startedAt - a.startedAt)
    .map((s) => {
      const p = config.getProfile(s.profileId);
      const ev = eventOf({ uuid: s.uuid, kind: s.kind === 'movie' ? 'movie' : 'episode', started: s.startedAt, source: 'local', profile: s.profileId, client: s.client }, p?.name || '?');
      // Entre deux rapports de l'app, la position avance au rythme de la lecture.
      const position = s.state === 'playing' ? Math.min(s.duration || Infinity, s.position + (now - s.updatedAt)) : s.position;
      return {
        id: s.id,
        state: s.state,
        profileName: p?.name || '?',
        avatarUrl: avatarOf(p),
        contentId: ev.contentId,
        title: ev.title,
        kind: ev.kind,
        season: ev.season,
        episode: ev.episode,
        metadata: ev.metadata,
        release: s.release,
        size: s.size,
        addonName: s.addonName,
        addonLogo: s.addonLogo,
        position,
        duration: s.duration,
        exact: true,
        rate: s.rate,
        transferred: s.transferred,
        series: s.series,
        startedAt: s.startedAt,
        sources: [s.client || 'Stremfin']
      };
    });
}

// ---- Statistiques ------------------------------------------------------------------------------
// Meme calcul et meme forme de reponse que la page Statistiques de Nuvio Manager
// (summarizeStatistics), alimentes par la table plays et les fiches de Stremfin.

const DAY = 864e5;
const SOURCE_NAMES = { trakt: 'Trakt', simkl: 'Simkl', nuvio: 'Nuvio' };

/** Duree d'un element (ms), d'apres sa fiche ("42 min"...). */
function runtimeOf(uuid) {
  const e = ids.get(uuid);
  const raw = e?.data.runtime || (e?.kind === 'episode' ? ids.get(e.data.seriesUuid)?.data.runtime : null);
  const n = Number(String(raw ?? '').match(/\d+/)?.[0]);
  return n > 0 && n < 1000 ? n * 60e3 : 0;
}

/** Minutes suivies : mesurees ici, sinon duree connue (import), sinon fiche, sinon moyenne. */
function minutesOf(r) {
  const ms = r.watched || r.duration || runtimeOf(r.uuid);
  return ms ? ms / 60e3 : r.kind === 'movie' ? 100 : 45;
}

const imdbOf = (d) => d?.imdb || (/^tt\d+$/.test(d?.sid) ? d.sid : null);
const tmdbOf = (d) => Number(d?.tmdb) || Number(String(d?.sid || '').match(/^tmdb:(\d+)$/)?.[1]) || null;

/** Fiche affichee pour un film ou une serie (affiche, fond, resume, annee, note, genres, lien TMDB). */
function metadataOf(entry, kind) {
  const d = entry?.data;
  if (!d) return null;
  const tmdb = tmdbOf(d);
  return {
    title: d.name || null,
    poster: d.poster || null,
    backdrop: d.background || d.poster || null,
    overview: d.description || null,
    year: String(d.releaseInfo || '').match(/\d{4}/)?.[0] || null,
    rating: d.imdbRating ? Number(d.imdbRating) : null,
    genres: d.genres || [],
    url: tmdb ? `https://www.themoviedb.org/${kind === 'movie' ? 'movie' : 'tv'}/${tmdb}` : null
  };
}

/**
 * Une ligne de plays -> evenement au format de Nuvio Manager :
 * { contentId, title, kind, season, episode, source, app, at, ref, profileName, minutes, metadata }.
 * Les deux versions d'un titre (tt... / tmdb:...) donnent le meme contentId.
 */
function eventOf(r, profileName) {
  const e = ids.get(r.uuid);
  const base = { source: r.source, app: r.source === 'local' ? r.client || 'Stremfin' : SOURCE_NAMES[r.source] || r.source, at: r.started, ref: r.profile, profileName, minutes: minutesOf(r), release: r.release, device: r.device };
  if (r.kind === 'movie') {
    const twin = e?.data.twin ? ids.get(e.data.twin) : null;
    const contentId = imdbOf(e?.data) || imdbOf(twin?.data) || (tmdbOf(e?.data) ? `tmdb:${tmdbOf(e.data)}` : r.uuid);
    // Fiche la plus complete des deux versions.
    const best = e?.data.description || !twin ? e : twin;
    return { ...base, contentId, title: e?.data.name || r.title, kind: 'movie', season: null, episode: null, metadata: metadataOf(best, 'movie') };
  }
  const series = e?.kind === 'episode' ? ids.get(e.data.seriesUuid) : null;
  const contentId = String(e?.data.vid || '').replace(/:\d+:\d+$/, '') || imdbOf(series?.data) || r.series || r.uuid;
  return {
    ...base,
    contentId,
    title: series?.data.name || r.series || r.title,
    kind: 'episode',
    season: e?.data.season ?? null,
    episode: e?.data.episode ?? null,
    metadata: metadataOf(series, 'series')
  };
}

const avatarOf = (p) => (p?.avatar ? `/Users/${p.id}/Images/Primary?tag=${p.avatarAt}` : null);

/**
 * Statistiques d'une periode (days : 0 = tout l'historique) pour une liste de profils
 * (refs ; vide = tous). Reponse au format de Nuvio Manager, plus les lectures en cours.
 */
function summary({ days = 30, refs = null } = {}, now = Date.now()) {
  const since = days ? now - days * DAY : 0;
  const all = config.get().profiles;
  const chosen = refs ? all.filter((p) => refs.includes(p.id)) : all;
  const names = new Map(all.map((p) => [p.id, p.name]));
  const rows = q.range.all(since, now + DAY).filter((r) => chosen.some((p) => p.id === r.profile));
  const allEvents = rows.map((r) => eventOf(r, names.get(r.profile) || '?')).sort((a, b) => b.at - a.at);

  const summaries = chosen.map((p) => {
    const events = allEvents.filter((ev) => ev.ref === p.id);
    const unique = new Set(events.map((ev) => ev.contentId));
    return {
      ref: p.id,
      accountName: '',
      profileName: p.name,
      avatarUrl: avatarOf(p),
      sources: [...new Set(events.map((ev) => ev.app))],
      plays: events.length,
      uniqueTitles: unique.size,
      movies: events.filter((ev) => ev.kind === 'movie').length,
      episodes: events.filter((ev) => ev.kind === 'episode').length,
      trackedMinutes: Math.round(events.reduce((n, ev) => n + ev.minutes, 0)),
      lastActivity: Math.max(0, ...events.map((ev) => ev.at)),
      contentIds: [...unique]
    };
  });

  // Fiches, une fois par titre (pour la fenetre de detail ouverte depuis un jour).
  const mediaMetadata = {};
  for (const ev of allEvents) {
    const k = `${ev.kind === 'movie' ? 'movie' : 'series'}:${ev.contentId}`;
    if (!mediaMetadata[k] && ev.metadata) mediaMetadata[k] = ev.metadata;
  }

  // Activite jour par jour : toute la periode (ou depuis la 1re lecture pour "tout").
  let earliest = now;
  for (const ev of allEvents) if (ev.at < earliest) earliest = ev.at;
  const timelineDays = days ? Math.min(days, 3650) : Math.max(1, Math.min(3650, Math.ceil((now - earliest) / DAY) + 1));
  const timeline = [];
  for (let offset = timelineDays - 1; offset >= 0; offset--) {
    const start = new Date(now - offset * DAY);
    start.setHours(0, 0, 0, 0);
    const end = start.getTime() + DAY;
    const dayEvents = allEvents.filter((ev) => ev.at >= start.getTime() && ev.at < end);
    const perProfile = new Map();
    for (const ev of dayEvents) perProfile.set(ev.ref, (perProfile.get(ev.ref) || 0) + 1);
    const date = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${String(start.getDate()).padStart(2, '0')}`;
    timeline.push({
      date,
      count: dayEvents.length,
      movies: dayEvents.filter((ev) => ev.kind === 'movie').length,
      series: dayEvents.filter((ev) => ev.kind === 'episode').length,
      profiles: [...perProfile.entries()].map(([ref, count]) => ({ ref, count })).sort((a, b) => b.count - a.count),
      items: dayEvents.map((ev) => ({
        contentId: ev.contentId,
        title: ev.title || ev.contentId,
        kind: ev.kind,
        season: ev.season,
        episode: ev.episode,
        source: ev.source,
        app: ev.app,
        at: ev.at,
        ref: ev.ref,
        profileName: ev.profileName,
        poster: ev.metadata?.poster || null,
        backdrop: ev.metadata?.backdrop || null
      }))
    });
  }

  // Classements : titres les plus regardes (lectures) et les plus populaires (profils).
  const popularity = new Map();
  for (const ev of allEvents) {
    const id = `${ev.kind}|${ev.contentId}`;
    const item = popularity.get(id) || { contentId: ev.contentId, title: ev.title || ev.contentId, kind: ev.kind, plays: 0, profiles: new Set(), profileDetails: new Map(), sources: new Set(), episodes: new Set(), seasons: new Set(), lastActivity: 0, metadata: ev.metadata };
    item.plays++;
    item.profiles.add(ev.ref);
    item.sources.add(ev.app);
    const pd = item.profileDetails.get(ev.ref) || { ref: ev.ref, profileName: ev.profileName, plays: 0 };
    pd.plays++;
    item.profileDetails.set(ev.ref, pd);
    if (ev.kind === 'episode') {
      item.episodes.add(`${ev.season ?? ''}:${ev.episode ?? ''}`);
      if (ev.season != null) item.seasons.add(ev.season);
    }
    item.lastActivity = Math.max(item.lastActivity, ev.at);
    if (!item.metadata && ev.metadata) item.metadata = ev.metadata;
    popularity.set(id, item);
  }
  const ranked = [...popularity.values()]
    .map((item) => ({
      contentId: item.contentId,
      title: item.title,
      kind: item.kind,
      plays: item.plays,
      profiles: item.profiles.size,
      profileDetails: [...item.profileDetails.values()].sort((a, b) => b.plays - a.plays),
      sources: [...item.sources],
      episodeCount: item.episodes.size,
      seasonCount: item.seasons.size,
      lastActivity: item.lastActivity,
      metadata: item.metadata
    }))
    .sort((a, b) => b.plays - a.plays || b.profiles - a.profiles || b.lastActivity - a.lastActivity);
  const watched = (kind) => ranked.filter((x) => x.kind === kind).slice(0, 5);
  const popular = (kind) => ranked.filter((x) => x.kind === kind).sort((a, b) => b.profiles - a.profiles || b.plays - a.plays || b.lastActivity - a.lastActivity).slice(0, 5);

  // Addons les plus actifs (comme Nuvio Manager) : lectures lancees ici, par addon d'origine.
  const addonMap = new Map();
  for (const r of rows) {
    if (!r.addon) continue;
    const entry = addonMap.get(r.addon) || { key: r.addon, name: r.addon, logo: '', opens: 0, profiles: new Set(), byRef: new Map() };
    entry.opens++;
    entry.profiles.add(r.profile);
    entry.byRef.set(r.profile, (entry.byRef.get(r.profile) || 0) + 1);
    if (!entry.logo && r.addon_logo) entry.logo = r.addon_logo;
    addonMap.set(r.addon, entry);
  }
  const addons = [...addonMap.values()]
    .map((entry) => ({
      key: entry.key,
      name: entry.name,
      logo: entry.logo,
      opens: entry.opens,
      profiles: entry.profiles.size,
      modes: [],
      breakdown: [...entry.byRef]
        .map(([ref, opens]) => ({ ref, profileName: names.get(ref) || '?', accountName: '', avatarUrl: avatarOf(config.getProfile(ref)) || '', opens, modes: [] }))
        .sort((a, b) => b.opens - a.opens)
    }))
    .sort((a, b) => b.opens - a.opens)
    .slice(0, 5);

  // Titres en commun entre profils (indice de Jaccard).
  const overlap = summaries.flatMap((left, index) =>
    summaries.slice(index + 1).map((right) => {
      const a = new Set(left.contentIds);
      const b = new Set(right.contentIds);
      const common = [...a].filter((id) => b.has(id)).length;
      const union = new Set([...a, ...b]).size;
      return { left: left.ref, right: right.ref, common, similarity: union ? Math.round((common / union) * 100) : 0 };
    })
  );
  for (const s of summaries) delete s.contentIds;

  return {
    generatedAt: now,
    days,
    availableProfiles: all.map((p) => ({ ref: p.id, profileName: p.name, accountName: '' })),
    totals: {
      profiles: summaries.length,
      plays: allEvents.length,
      uniqueTitles: new Set(allEvents.map((ev) => `${ev.kind}|${ev.contentId}`)).size,
      trackedMinutes: summaries.reduce((n, s) => n + s.trackedMinutes, 0)
    },
    profiles: summaries,
    timeline,
    top: ranked.slice(0, 12),
    rankings: { watchedSeries: watched('episode'), popularSeries: popular('episode'), watchedMovies: watched('movie'), popularMovies: popular('movie') },
    addons,
    overlap,
    mediaMetadata,
    recent: allEvents.slice(0, 200).map(({ metadata, ...ev }) => ({ ...ev, metadata: metadata && { poster: metadata.poster, backdrop: metadata.backdrop, title: metadata.title, year: metadata.year } }))
  };
}

module.exports = { onReport, addBytes, nowPlaying, summary };
