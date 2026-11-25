// Enregistrements (DVR) des chaines IPTV, sur le modele de Jellyfin et de Polyfin :
//   - programmations (timers) : un programme du guide, avec marges avant et apres ; series
//     (series timers) : tous les programmes a venir de meme titre sur la chaine (ou sur toutes) ;
//   - enregistrement : FFmpeg copie le flux de la chaine (sans conversion) dans un fichier .ts,
//     en lisant la connexion partagee de la chaine (un spectateur de la meme chaine ne prend pas
//     une 2e connexion). Une connexion du compte est prise ; une chaine en cours d'enregistrement
//     n'est jamais fermee pour en ouvrir une autre ;
//   - fichiers dans <data>/recordings (ou le dossier des reglages), lus par les apps comme une video.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { db } = require('../db');
const config = require('../config');
const store = require('./store');
const epg = require('./epg');

function log(...args) {
  console.log(new Date().toISOString(), '[dvr]', ...args);
}

db.exec(`
  CREATE TABLE IF NOT EXISTS dvr_timers (
    id            TEXT PRIMARY KEY,
    profile       TEXT NOT NULL,
    chan          TEXT NOT NULL,
    program_start INTEGER,
    start         INTEGER NOT NULL,
    stop          INTEGER NOT NULL,
    pre           INTEGER NOT NULL DEFAULT 0,
    post          INTEGER NOT NULL DEFAULT 0,
    name          TEXT NOT NULL,
    episode       TEXT,
    overview      TEXT,
    image         TEXT,
    series_timer  TEXT,
    status        TEXT NOT NULL DEFAULT 'scheduled',
    file          TEXT,
    size          INTEGER,
    error         TEXT,
    created       INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS dvr_timers_profile ON dvr_timers (profile, start);
  CREATE UNIQUE INDEX IF NOT EXISTS dvr_timers_prog ON dvr_timers (profile, chan, program_start);
  CREATE TABLE IF NOT EXISTS dvr_series (
    id          TEXT PRIMARY KEY,
    profile     TEXT NOT NULL,
    chan        TEXT NOT NULL,
    title       TEXT NOT NULL,
    any_channel INTEGER NOT NULL DEFAULT 0,
    pre         INTEGER NOT NULL DEFAULT 0,
    post        INTEGER NOT NULL DEFAULT 0,
    image       TEXT,
    created     INTEGER NOT NULL
  );
`);

const q = {
  timer: db.prepare('SELECT * FROM dvr_timers WHERE id = ?'),
  timers: db.prepare('SELECT * FROM dvr_timers WHERE profile = ? ORDER BY start'),
  allTimers: db.prepare('SELECT * FROM dvr_timers ORDER BY start DESC'),
  due: db.prepare("SELECT * FROM dvr_timers WHERE status = 'scheduled' AND start - pre <= ? AND stop + post > ?"),
  missed: db.prepare("UPDATE dvr_timers SET status = 'failed', error = ? WHERE status = 'scheduled' AND stop + post <= ?"),
  byProg: db.prepare('SELECT * FROM dvr_timers WHERE profile = ? AND chan = ? AND program_start = ?'),
  put: db.prepare(`INSERT OR IGNORE INTO dvr_timers (id, profile, chan, program_start, start, stop, pre, post, name, episode, overview, image, series_timer, status, created)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'scheduled', ?)`),
  setStatus: db.prepare('UPDATE dvr_timers SET status = ?, error = ?, file = COALESCE(?, file), size = COALESCE(?, size) WHERE id = ?'),
  setPadding: db.prepare('UPDATE dvr_timers SET pre = ?, post = ? WHERE id = ?'),
  del: db.prepare('DELETE FROM dvr_timers WHERE id = ?'),
  series: db.prepare('SELECT * FROM dvr_series WHERE profile = ? ORDER BY created'),
  allSeries: db.prepare('SELECT * FROM dvr_series'),
  oneSeries: db.prepare('SELECT * FROM dvr_series WHERE id = ?'),
  putSeries: db.prepare('INSERT INTO dvr_series (id, profile, chan, title, any_channel, pre, post, image, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'),
  delSeries: db.prepare('DELETE FROM dvr_series WHERE id = ?'),
  dropSeriesTimers: db.prepare("DELETE FROM dvr_timers WHERE series_timer = ? AND status = 'scheduled'")
};

const settings = () => config.get().settings;
const newId = () => crypto.randomBytes(16).toString('hex');

/** Dossier des enregistrements (reglage, sinon <data>/recordings). */
function folder() {
  return settings().recordingsPath || path.join(config.DATA_DIR, 'recordings');
}

function padding() {
  const s = settings();
  return { pre: Math.max(0, Number(s.recordingPrePadding ?? 2)) * 60e3, post: Math.max(0, Number(s.recordingPostPadding ?? 5)) * 60e3 };
}

// ---- Programmations ---------------------------------------------------------------------

/** Programme une emission (chaine, programme du guide). Renvoie la programmation. */
function schedule(profile, ch, p, { pre, post, series } = {}) {
  const pad = padding();
  const known = q.byProg.get(profile.id, ch.uuid, p.start);
  if (known) {
    if (known.status === 'cancelled') q.del.run(known.id);
    else return known;
  }
  const id = newId();
  const episode = p.subtitle || null;
  q.put.run(id, profile.id, ch.uuid, p.start, p.start, p.stop, pre ?? pad.pre, post ?? pad.post, p.title, episode, p.descr || null, p.icon || ch.logo || null, series || null, Date.now());
  log(`${profile.name} : « ${p.title} » programmé sur ${ch.name} (${new Date(p.start).toISOString().slice(0, 16)})`);
  return q.timer.get(id);
}

function timersOf(profile) {
  return q.timers.all(profile.id);
}
function timer(id) {
  return q.timer.get(String(id || '').replace(/-/g, '').toLowerCase());
}

/** Annule une programmation (et arrete l'enregistrement en cours). */
function cancel(id) {
  const t = timer(id);
  if (!t) return false;
  const job = jobs.get(t.id);
  if (job) job.stop('annulé');
  if (t.status === 'scheduled') q.setStatus.run('cancelled', null, null, null, t.id);
  return true;
}

function setPadding(id, pre, post) {
  const t = timer(id);
  if (t) q.setPadding.run(Math.max(0, pre ?? t.pre), Math.max(0, post ?? t.post), t.id);
}

/** Supprime un enregistrement (son fichier aussi). */
function removeRecording(id) {
  const t = timer(id);
  if (!t) return false;
  cancel(t.id);
  if (t.file) {
    try {
      fs.unlinkSync(t.file);
    } catch {}
  }
  q.del.run(t.id);
  log(`enregistrement supprimé : ${t.name}`);
  return true;
}

// ---- Series --------------------------------------------------------------------------------

function seriesOf(profile) {
  return q.series.all(profile.id);
}
function oneSeries(id) {
  return q.oneSeries.get(String(id || '').replace(/-/g, '').toLowerCase());
}

function addSeries(profile, ch, p, { anyChannel = false, pre, post } = {}) {
  const pad = padding();
  const id = newId();
  q.putSeries.run(id, profile.id, ch.uuid, p.title, anyChannel ? 1 : 0, pre ?? pad.pre, post ?? pad.post, p.icon || ch.logo || null, Date.now());
  log(`${profile.name} : série « ${p.title} » programmée${anyChannel ? ' (toutes les chaînes)' : ` sur ${ch.name}`}`);
  planSeries();
  return q.oneSeries.get(id);
}

function removeSeries(id) {
  const s = oneSeries(id);
  if (!s) return false;
  q.dropSeriesTimers.run(s.id);
  q.delSeries.run(s.id);
  return true;
}

/** Programme les prochaines diffusions des series (3 jours a venir). */
function planSeries() {
  const now = Date.now();
  const sources = require('../iptvSources');
  for (const s of q.allSeries.all()) {
    const profile = config.getProfile(s.profile);
    if (!profile) continue;
    const live = sources.liveSourcesFor(profile);
    const channels = s.any_channel ? store.visible(live, { limit: 20000 }).items.filter((r) => r.epg_guide) : [store.channel(s.chan)].filter((r) => r && live.includes(r.source));
    const title = s.title.toLowerCase();
    for (const ch of channels) {
      for (const p of epg.programs(ch, now, now + 3 * 864e5)) {
        if (p.title.toLowerCase() !== title || p.start < now) continue;
        schedule(profile, ch, p, { pre: s.pre, post: s.post, series: s.id });
      }
    }
  }
}

// ---- Enregistrement -------------------------------------------------------------------------

const jobs = new Map();
const PORT = Number(process.env.PORT) || 8096;

function safe(s) {
  return String(s || '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || 'Enregistrement';
}

function fileFor(t) {
  const d = new Date(t.start);
  const z = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}h${z(d.getMinutes())}`;
  const dir = path.join(folder(), safe(t.name));
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${safe(t.name)}${t.episode ? ' - ' + safe(t.episode) : ''} ${stamp}.ts`);
}

function start(t) {
  const ffmpeg = require('../transcode/ffmpeg').status();
  const profile = config.getProfile(t.profile);
  const ch = store.channel(t.chan);
  const sources = require('../iptvSources');
  if (!ffmpeg.path) return q.setStatus.run('failed', 'FFmpeg introuvable', null, null, t.id);
  if (!profile || !ch || !sources.liveSourcesFor(profile).includes(ch.source)) return q.setStatus.run('failed', 'Chaîne indisponible', null, null, t.id);
  const max = Math.max(1, Number(settings().recordingMaxConcurrent) || 2);
  if (jobs.size >= max) return; // reessaye au prochain passage
  let mode = sources.modeFor(profile, ch.source);
  if (mode === 'none') mode = 'direct';
  const relay = require('./relay');
  const sess = relay.newSession({ channel: ch.uuid, source: ch.source, profileId: profile.id, mode, name: ch.name });
  const isHls = /\.m3u8(\?|$)/i.test(ch.url);
  const input = `http://127.0.0.1:${PORT}/Videos/${ch.uuid}/live/${isHls ? 'index.m3u8' : 'stream.ts'}?ls=${sess}&relay=1&rec=1`;
  const file = fileFor(t);
  const remain = Math.max(10, Math.round((t.stop + t.post - Date.now()) / 1000));
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-fflags', '+genpts+discardcorrupt', '-i', input, '-map', '0:v?', '-map', '0:a?', '-c', 'copy', '-t', String(remain), '-f', 'mpegts', '-y', file];
  const proc = spawn(ffmpeg.path, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  proc.stderr.on('data', (c) => (err = (err + c).slice(-1500)));
  const job = {
    id: t.id,
    proc,
    stop(why) {
      job.why = why;
      try {
        proc.kill('SIGINT');
      } catch {}
      setTimeout(() => {
        try {
          proc.kill('SIGKILL');
        } catch {}
      }, 5000).unref();
    }
  };
  jobs.set(t.id, job);
  q.setStatus.run('recording', null, file, 0, t.id);
  log(`« ${t.name} » : enregistrement commencé (${ch.name}, ${Math.round(remain / 60)} min)`);
  proc.on('exit', (code) => {
    jobs.delete(t.id);
    let size = 0;
    try {
      size = fs.statSync(file).size;
    } catch {}
    const cancelled = job.why === 'annulé';
    const ok = size > 100 * 1024 && (code === 0 || job.why || Date.now() >= t.stop);
    q.setStatus.run(cancelled ? (size ? 'done' : 'cancelled') : ok ? 'done' : 'failed', ok || cancelled ? null : (err.trim().split('\n').pop() || `FFmpeg arrêté (code ${code})`).slice(0, 300), file, size, t.id);
    log(`« ${t.name} » : enregistrement ${ok ? 'terminé' : cancelled ? 'arrêté' : 'échoué'} (${Math.round(size / 1e6)} Mo)`);
  });
}

function tick() {
  const now = Date.now();
  q.missed.run('Programme passé sans enregistrement (serveur arrêté ?)', now);
  for (const t of q.due.all(now, now)) if (!jobs.has(t.id)) start(t);
}

let timers = [];
function startScheduler() {
  for (const x of timers) clearInterval(x);
  // Enregistrements coupes par un arret du serveur : termines avec ce qu'ils ont.
  db.prepare("UPDATE dvr_timers SET status = 'done' WHERE status = 'recording' AND file IS NOT NULL").run();
  timers = [setInterval(tick, 10e3), setInterval(planSeries, 10 * 60e3)];
  timers.forEach((x) => x.unref());
  setTimeout(planSeries, 60e3).unref();
}

// Stremfin s'arrete : les enregistrements aussi (les fichiers restent lisibles).
process.on('exit', () => {
  for (const j of jobs.values()) {
    try {
      j.proc.kill('SIGKILL');
    } catch {}
  }
});

function isRecording(id) {
  return jobs.has(id);
}

/** Etat pour l'admin : programmations de tous les profils et place utilisee. */
function overview() {
  const all = q.allTimers.all();
  const used = all.reduce((n, t) => n + (t.size || 0), 0);
  return { timers: all, series: q.allSeries.all(), used, folder: folder() };
}

module.exports = { schedule, timersOf, timer, cancel, setPadding, removeRecording, seriesOf, oneSeries, addSeries, removeSeries, planSeries, startScheduler, isRecording, overview, folder, padding };
