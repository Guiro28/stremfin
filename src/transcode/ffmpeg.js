// FFmpeg pour les conversions (voir hls.js) : trouve l'executable, et choisit l'encodeur video en
// essayant pour de vrai ceux de la machine, dans l'ordre : NVIDIA (NVENC), Intel (QuickSync),
// Intel / AMD sous Linux (VA-API), Mac (VideoToolbox), AMD sous Windows (AMF), puis le processeur
// (libx264). Un encodeur liste par FFmpeg mais inutilisable (pas de carte, pilote absent, conteneur
// sans /dev/dri) echoue a l'essai et n'est pas retenu.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const config = require('../config');

function log(...args) {
  console.log(new Date().toISOString(), '[ffmpeg]', ...args);
}

/** Lance une commande et renvoie { code, out, err } (sans lever d'erreur). */
function run(file, args, timeout = 20000) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === 'number' ? error.code : -1) : 0, out: String(stdout || ''), err: String(stderr || error?.message || '') });
    });
  });
}

// Peripherique VA-API (Linux) : le premier rendu DRI, sauf choix par VAAPI_DEVICE.
function vaapiDevice() {
  if (process.env.VAAPI_DEVICE) return process.env.VAAPI_DEVICE;
  try {
    const node = fs.readdirSync('/dev/dri').filter((n) => n.startsWith('renderD')).sort()[0];
    return node ? `/dev/dri/${node}` : null;
  } catch {
    return null;
  }
}

/**
 * Encodeurs essayes, du plus rapide au plus lent. Pour chacun : les options d'entree (peripherique),
 * la fin de la chaine de filtres (envoi des images a la carte) et les options d'encodage pour un
 * debit cible bitrate (bit/s).
 */
const ENCODERS = [
  { id: 'nvenc', name: 'h264_nvenc', label: 'NVIDIA (NVENC)', input: () => [], upload: '', options: (b) => ['-preset', 'p4', '-rc', 'vbr', '-b:v', b, '-maxrate', b, '-bufsize', b * 2, '-forced-idr', '1'] },
  { id: 'qsv', name: 'h264_qsv', label: 'Intel (QuickSync)', input: () => [], upload: '', options: (b) => ['-preset', 'veryfast', '-b:v', b, '-maxrate', b, '-bufsize', b * 2] },
  {
    id: 'vaapi',
    name: 'h264_vaapi',
    label: 'Intel / AMD (VA-API)',
    input: () => (vaapiDevice() ? ['-vaapi_device', vaapiDevice()] : null),
    upload: 'format=nv12,hwupload',
    options: (b) => ['-b:v', b, '-maxrate', b, '-bufsize', b * 2]
  },
  { id: 'videotoolbox', name: 'h264_videotoolbox', label: 'Apple (VideoToolbox)', input: () => [], upload: '', options: (b) => ['-b:v', b, '-maxrate', b, '-bufsize', b * 2] },
  { id: 'amf', name: 'h264_amf', label: 'AMD (AMF)', input: () => [], upload: '', options: (b) => ['-quality', 'speed', '-b:v', b, '-maxrate', b, '-bufsize', b * 2] },
  { id: 'software', name: 'libx264', label: 'Processeur (libx264)', input: () => [], upload: '', options: (b) => ['-preset', 'veryfast', '-crf', '21', '-maxrate', b, '-bufsize', b * 2, '-profile:v', 'high', '-level', '4.1'] }
];

let state = { ready: false, ok: false, path: null, probe: null, version: '', encoder: null, tried: [], zscale: false, checkedAt: 0, error: '' };
let pending = null;

/** Executable FFmpeg : reglage, puis FFMPEG_PATH, puis le PATH. */
function candidates() {
  const s = config.get().settings;
  return [s.ffmpegPath, process.env.FFMPEG_PATH, 'ffmpeg'].filter(Boolean);
}

/** ffprobe a cote de ffmpeg (meme dossier), sinon celui du PATH. */
function probeOf(ffmpegPath) {
  if (ffmpegPath === 'ffmpeg') return 'ffprobe';
  const dir = path.dirname(ffmpegPath);
  const exe = path.basename(ffmpegPath).replace(/ffmpeg/i, 'ffprobe');
  const p = path.join(dir, exe);
  return fs.existsSync(p) ? p : 'ffprobe';
}

/** Essaie un encodeur sur une seconde d'image de test. */
async function tryEncoder(ffmpegPath, enc) {
  const input = enc.input();
  if (input === null) return { ok: false, error: 'aucun périphérique /dev/dri' };
  const vf = ['scale=1280:720', enc.upload].filter(Boolean).join(',');
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', ...input, '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=25', '-t', '1', '-vf', vf, '-c:v', enc.name, ...enc.options(4000000).map(String), '-f', 'null', '-'];
  const r = await run(ffmpegPath, args, 30000);
  return r.code === 0 ? { ok: true } : { ok: false, error: (r.err.split('\n').map((l) => l.trim()).filter(Boolean).pop() || `code ${r.code}`).slice(0, 200) };
}

/** Detection : FFmpeg present, encodeurs listes puis essayes, filtres utiles (zscale pour le HDR). */
async function detect() {
  const s = config.get().settings;
  const next = { ready: true, ok: false, path: null, probe: null, version: '', encoder: null, tried: [], zscale: false, checkedAt: Date.now(), error: '' };
  for (const p of candidates()) {
    const r = await run(p, ['-hide_banner', '-version'], 10000);
    if (r.code === 0) {
      next.path = p;
      next.version = (r.out.match(/ffmpeg version (\S+)/) || [])[1] || '';
      break;
    }
  }
  if (!next.path) {
    next.error = 'FFmpeg introuvable (installe-le, ou indique son chemin dans les réglages)';
    state = next;
    log(next.error);
    return state;
  }
  next.probe = probeOf(next.path);
  const [encoders, filters] = await Promise.all([run(next.path, ['-hide_banner', '-encoders']), run(next.path, ['-hide_banner', '-filters'])]);
  next.zscale = /\bzscale\b/.test(filters.out) && /\btonemap\b/.test(filters.out);
  const wanted = s.transcodeHw && s.transcodeHw !== 'auto' ? ENCODERS.filter((e) => e.id === s.transcodeHw || e.id === 'software') : ENCODERS;
  for (const enc of wanted) {
    if (!new RegExp(`\\b${enc.name}\\b`).test(encoders.out)) {
      next.tried.push({ id: enc.id, label: enc.label, ok: false, error: 'absent de cette version de FFmpeg' });
      continue;
    }
    const t = await tryEncoder(next.path, enc);
    next.tried.push({ id: enc.id, label: enc.label, ...t });
    if (t.ok) {
      next.encoder = enc.id;
      break;
    }
  }
  next.ok = !!next.encoder;
  if (!next.ok) next.error = 'Aucun encodeur vidéo utilisable';
  state = next;
  log(`${next.path} ${next.version} : ${next.ok ? `encodeur ${ENCODERS.find((e) => e.id === next.encoder).label}` : next.error}${next.zscale ? '' : ' (sans zscale : HDR converti sans correction des couleurs)'}`);
  return state;
}

/** Lance (ou relance) la detection ; une seule a la fois. */
function refresh() {
  if (!pending) pending = detect().finally(() => (pending = null));
  return pending;
}

/** Etat de la detection (pour l'admin et les conversions). */
function status() {
  return state;
}

/** L'encodeur retenu : { name, input(), upload, options(bitrate) }, ou null. */
function encoder() {
  return ENCODERS.find((e) => e.id === state.encoder) || null;
}

/** Duree (s) d'une source d'apres ffprobe, ou 0. */
async function duration(url) {
  if (!state.probe) return 0;
  const r = await run(state.probe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', url], 20000);
  const d = parseFloat(r.out);
  return Number.isFinite(d) && d > 0 ? d : 0;
}

module.exports = { refresh, status, encoder, duration, ENCODERS };
