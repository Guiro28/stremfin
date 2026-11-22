// Diffusion HLS des versions qu'une app ne lit pas telles quelles (voir decide.js), sur le modele
// de Polyfin et de Jellyfin : FFmpeg lit la source par le flux de Stremfin (memes routes : WARP,
// proxy, en-tetes), copie la video et le son quand l'app les lit, convertit le reste (son en AAC,
// image en H.264 sur la carte graphique si possible), et ecrit des segments de 6 s.
// La liste des segments couvre toute la duree des le depart (lecture "VOD") ; un segment demande
// loin de ce qu'ecrit FFmpeg (avance rapide, reprise) relance FFmpeg a partir de lui.
// Une session sans demande depuis 2 minutes, ou dont la lecture s'arrete, est fermee.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const config = require('../config');
const ffmpeg = require('./ffmpeg');

const SEGMENT = 6;
const IDLE = 120e3;
// Un segment demande au-dela de ce nombre devant FFmpeg (ou avant son depart) le relance.
const AHEAD = 4;
const DIR = path.join(config.DATA_DIR, 'transcodes');
const PORT = Number(process.env.PORT) || 8096;

function log(...args) {
  console.log(new Date().toISOString(), '[hls]', ...args);
}

const sessions = new Map();

// Dossier de travail vide au demarrage (restes d'une session coupee).
try {
  fs.rmSync(DIR, { recursive: true, force: true });
} catch {}

/** Nombre de conversions en cours (FFmpeg lances). */
function running() {
  return [...sessions.values()].filter((s) => s.proc).length;
}

/** Une nouvelle conversion peut-elle demarrer ? (FFmpeg pret, limite de sessions) */
function available() {
  const s = config.get().settings;
  return s.transcodeMode !== 'off' && ffmpeg.status().ok && running() < Math.max(1, Number(s.transcodeMaxSessions) || 2);
}

/**
 * Prepare une session et renvoie son adresse (TranscodingUrl). opts : itemUuid, msid, token,
 * container (de la source), runtime (s, d'apres la fiche), decision (decide.js), audio (piste
 * MediaStream choisie), video (piste video), profileId, name (pour le journal).
 */
function prepare(opts) {
  const id = crypto.randomBytes(16).toString('hex');
  const t = opts.decision.transcoding;
  const session = {
    id,
    ...opts,
    fmp4: t.container === 'mp4',
    dir: path.join(DIR, id),
    duration: 0,
    durationReady: null,
    proc: null,
    start: 0,
    written: -1,
    lastRequest: Date.now(),
    lastSegment: 0
  };
  sessions.set(id, session);
  const what = [opts.decision.copyVideo ? 'image copiée' : 'image convertie', opts.decision.copyAudio ? 'son copié' : 'son converti'].join(', ');
  log(`${opts.name} : conversion préparée (${what} ; ${opts.decision.reasons.join(', ')})`);
  return `/Videos/${opts.itemUuid}/hls/${id}/master.m3u8`;
}

function get(id) {
  const s = sessions.get(String(id || ''));
  if (s) s.lastRequest = Date.now();
  return s || null;
}

/** Adresse du flux de Stremfin que FFmpeg lit (memes routes que les apps). */
function inputUrl(s) {
  return `http://127.0.0.1:${PORT}/Videos/${s.itemUuid}/stream?static=true&mediaSourceId=${encodeURIComponent(s.msid)}&api_key=${encodeURIComponent(s.token)}`;
}

/** Duree de la source : ffprobe, sinon la duree de la fiche. */
function durationOf(s) {
  if (!s.durationReady) {
    s.durationReady = ffmpeg
      .duration(inputUrl(s))
      .catch(() => 0)
      .then((d) => {
        s.duration = d || s.runtime || 7200;
        return s.duration;
      });
  }
  return s.durationReady;
}

function segments(s) {
  return Math.max(1, Math.ceil(s.duration / SEGMENT));
}

/** Liste principale (une seule variante). */
async function master(s) {
  await durationOf(s);
  const v = s.video || {};
  const h = s.decision.copyVideo ? v.Height : Math.min(v.Height || 1080, 1080);
  const w = h && v.Width && v.Height ? Math.round((v.Width * h) / v.Height / 2) * 2 : 1920;
  const bandwidth = s.decision.copyVideo ? Math.max(2e6, Number(s.bitrate) || 8e6) : targetBitrate(s) + 400000;
  return ['#EXTM3U', `#EXT-X-STREAM-INF:BANDWIDTH=${Math.round(bandwidth)},RESOLUTION=${w}x${h || 1080}`, `main.m3u8`, ''].join('\n');
}

/** Liste des segments (toute la duree). */
async function playlist(s) {
  await durationOf(s);
  const n = segments(s);
  const ext = s.fmp4 ? 'mp4' : 'ts';
  const lines = ['#EXTM3U', `#EXT-X-VERSION:${s.fmp4 ? 7 : 3}`, `#EXT-X-TARGETDURATION:${SEGMENT + 4}`, '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-PLAYLIST-TYPE:VOD'];
  if (s.fmp4) lines.push('#EXT-X-MAP:URI="init.mp4"');
  for (let i = 0; i < n; i++) {
    const d = i === n - 1 ? s.duration - SEGMENT * (n - 1) : SEGMENT;
    lines.push(`#EXTINF:${Math.max(0.1, d).toFixed(6)},`, `${i}.${ext}`);
  }
  lines.push('#EXT-X-ENDLIST', '');
  return lines.join('\n');
}

/** Debit video vise (bit/s) : le reglage, sans depasser ce que l'app accepte. */
function targetBitrate(s) {
  const settings = config.get().settings;
  const cap = (Number(settings.transcodeMaxBitrate) || 10) * 1e6;
  const app = Number(s.decision.transcoding.maxBitrate) || 0;
  return Math.max(1e6, Math.min(cap, app ? app - 400000 : cap));
}

/** Arguments FFmpeg pour ecrire a partir du segment n. */
function args(s, n) {
  const enc = ffmpeg.encoder();
  const offset = n * SEGMENT;
  const d = s.decision;
  const out = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-fflags', '+genpts'];
  const encInput = !d.copyVideo && enc ? enc.input() || [] : [];
  out.push(...encInput);
  // Image convertie : decodage par la carte graphique quand elle sait (repli automatique sur le
  // processeur sinon) ; un 4K HEVC ou AV1 decode par le processeur suit a peine le temps reel.
  if (!d.copyVideo && enc && enc.id !== 'software') out.push('-hwaccel', 'auto');
  if (offset) out.push('-ss', String(offset));
  // Lecture a 2 fois la vitesse de la video au plus, apres 30 s d'avance : FFmpeg ne telecharge pas
  // tout le film d'un coup (debit du debrideur, disque).
  out.push('-readrate', '2', '-readrate_initial_burst', '30');
  out.push('-i', inputUrl(s), '-map', '0:v:0');
  if (s.audio) out.push('-map', `0:${s.audio.Index}`);
  out.push('-sn', '-dn', '-map_metadata', '-1', '-map_chapters', '-1');
  // Image.
  if (d.copyVideo) {
    out.push('-c:v', 'copy');
    if (s.video?.Codec === 'hevc') out.push('-tag:v', 'hvc1');
  } else {
    const bitrate = Math.round(targetBitrate(s));
    const filters = [];
    const height = s.video?.Height || 0;
    const hdr = s.video?.VideoRange === 'HDR' || /HDR|DOVI|HLG/.test(String(s.video?.VideoRangeType || ''));
    if (hdr && ffmpeg.status().zscale) {
      // HDR vers SDR : correction des couleurs (sinon image terne et delavee).
      filters.push('zscale=t=linear:npl=100', 'format=gbrpf32le', 'zscale=p=bt709', 'tonemap=tonemap=hable:desat=0', 'zscale=t=bt709:m=bt709:r=tv');
    }
    if (height > 1080) filters.push('scale=-2:1080');
    filters.push('format=yuv420p');
    if (enc?.upload) filters.push(enc.upload);
    out.push('-vf', filters.join(','), '-c:v', enc ? enc.name : 'libx264', ...(enc ? enc.options(bitrate) : ['-preset', 'veryfast', '-crf', '21']).map(String));
    // Une image cle au debut de chaque segment : les segments durent exactement 6 s.
    out.push('-force_key_frames', `expr:gte(t,n_forced*${SEGMENT})`);
  }
  // Son.
  if (s.audio) {
    if (d.copyAudio) out.push('-c:a', 'copy');
    else {
      const channels = Math.min(s.audio.Channels || 2, d.transcoding.maxAudioChannels || 2) > 2 ? 6 : 2;
      out.push('-c:a', 'aac', '-ac', String(channels), '-b:a', channels > 2 ? '384k' : '192k');
    }
  }
  // Segments, numerotes a partir de n, horodates a leur place dans la video.
  const ext = s.fmp4 ? 'mp4' : 'ts';
  out.push('-max_muxing_queue_size', '2048', '-output_ts_offset', String(offset));
  out.push('-f', 'hls', '-hls_time', String(SEGMENT), '-hls_list_size', '0', '-start_number', String(n), '-hls_flags', 'temp_file+independent_segments');
  out.push('-hls_segment_type', s.fmp4 ? 'fmp4' : 'mpegts');
  if (s.fmp4) out.push('-hls_fmp4_init_filename', 'init.mp4');
  // Noms relatifs : FFmpeg tourne dans le dossier de la session (il y ecrit aussi init.mp4).
  out.push('-hls_segment_filename', `%d.${ext}`, 'ffmpeg.m3u8');
  return out;
}

function stopProcess(s) {
  if (!s.proc) return;
  const p = s.proc;
  s.proc = null;
  try {
    p.kill('SIGKILL');
  } catch {}
}

/** (Re)lance FFmpeg a partir du segment n. */
function startAt(s, n) {
  stopProcess(s);
  fs.mkdirSync(s.dir, { recursive: true });
  s.start = n;
  s.written = n - 1;
  const a = args(s, n);
  const proc = spawn(ffmpeg.status().path, a, { cwd: s.dir, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  s.proc = proc;
  let err = '';
  proc.stderr.on('data', (c) => (err = (err + c).slice(-2000)));
  proc.on('exit', (code) => {
    if (s.proc !== proc) return;
    s.proc = null;
    s.ended = code === 0;
    if (code !== 0) log(`${s.name} : FFmpeg arrêté (code ${code}) ${err.trim().split('\n').pop() || ''}`);
  });
  log(`${s.name} : FFmpeg démarre au segment ${n} (${n * SEGMENT} s)`);
}

/** Fichier d'un segment ecrit (FFmpeg l'ecrit sous un nom temporaire puis le renomme). */
function segmentFile(s, n) {
  return path.join(s.dir, `${n}.${s.fmp4 ? 'mp4' : 'ts'}`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Plus haut segment fini dans le dossier (a partir du depart de FFmpeg). */
function highestWritten(s) {
  while (fs.existsSync(segmentFile(s, s.written + 1))) s.written++;
  return s.written;
}

/**
 * Chemin du segment n une fois ecrit (en relancant FFmpeg s'il est loin), ou null si la
 * conversion echoue ou tarde plus de 40 s.
 */
async function segment(s, n) {
  await durationOf(s);
  if (n < 0 || n >= segments(s)) return null;
  s.lastSegment = n;
  const file = segmentFile(s, n);
  if (fs.existsSync(file)) return file;
  const written = s.proc ? highestWritten(s) : -1;
  if (!s.proc || n < s.start || n > written + AHEAD) {
    if (!s.proc && !available() && !s.everStarted) return null;
    s.everStarted = true;
    startAt(s, n);
  }
  const deadline = Date.now() + 40000;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) return file;
    if (!s.proc) {
      // FFmpeg fini ou arrete : le segment existe peut-etre, sinon c'est la fin.
      return fs.existsSync(file) ? file : null;
    }
    await sleep(150);
  }
  return null;
}

/** Taille d'un fichier, 0 s'il n'existe pas. */
function sizeOf(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

/**
 * Segment d'initialisation (fMP4). FFmpeg cree init.mp4 vide des son depart et ne l'ecrit qu'avec
 * le premier segment : on attend qu'il soit rempli (un init vide rend tous les segments illisibles).
 */
async function init(s) {
  const file = path.join(s.dir, 'init.mp4');
  if (!s.proc && !sizeOf(file)) {
    s.everStarted = true;
    startAt(s, s.lastSegment || 0);
  }
  const deadline = Date.now() + 40000;
  while (Date.now() < deadline) {
    if (sizeOf(file) > 0) return file;
    if (!s.proc) return null;
    await sleep(150);
  }
  return null;
}

function close(s, why) {
  stopProcess(s);
  sessions.delete(s.id);
  setTimeout(() => {
    try {
      fs.rmSync(s.dir, { recursive: true, force: true });
    } catch {}
  }, 1000);
  if (s.everStarted) log(`${s.name} : conversion terminée (${why})`);
}

/** Ferme les sessions d'une lecture arretee (PlaySessionId Jellyfin, ou session HLS). */
function stopFor({ itemUuid, profileId, sessionId } = {}) {
  for (const s of sessions.values()) {
    if ((sessionId && s.id === sessionId) || (itemUuid && s.itemUuid === itemUuid && (!profileId || s.profileId === profileId))) close(s, 'lecture arrêtée');
  }
}

// Menage : sessions inactives, et segments deja lus (on garde les 10 derniers).
setInterval(() => {
  const now = Date.now();
  for (const s of sessions.values()) {
    if (now - s.lastRequest > IDLE) {
      close(s, 'inactive');
      continue;
    }
    try {
      for (const f of fs.readdirSync(s.dir)) {
        const n = parseInt(f, 10);
        if (Number.isFinite(n) && n < s.lastSegment - 10) fs.unlinkSync(path.join(s.dir, f));
      }
    } catch {}
  }
}, 30000).unref();

// Stremfin s'arrete : ses FFmpeg aussi (sous Windows, un processus enfant survit a son parent).
for (const sig of ['exit', 'SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    for (const s of sessions.values()) stopProcess(s);
    if (sig !== 'exit') process.exit(0);
  });
}

/** Sessions en cours (pour l'admin). */
function list() {
  return [...sessions.values()].map((s) => ({ name: s.name, converting: !!s.proc, copyVideo: s.decision.copyVideo, copyAudio: s.decision.copyAudio, reasons: s.decision.reasons, segment: s.lastSegment }));
}

module.exports = { prepare, get, master, playlist, segment, init, stopFor, available, running, list, SEGMENT };
