// Clip lance quand aucun addon ne fournit la video : celui fourni avec Stremfin
// (public/media/no-source.webm), ou celui choisi dans Reglages -> Lecture et reseau (data/).
// Il n'est jamais compte comme une lecture (statistiques, suivi, progression).
const fs = require('fs');
const path = require('path');
const config = require('./config');
const ids = require('./ids');
const { _test: ebml } = require('./probe');

const MAX_BYTES = 50 * 1024 * 1024;
const DEFAULT_FILE = path.join(__dirname, '..', 'public', 'media', 'no-source.webm');
// Description du clip fourni (VP8, 1280x720, sans son).
const DEFAULT_META = { container: 'webm', codec: 'vp8', width: 1280, height: 720, durationMs: 10000, custom: false };
const META_FILE = path.join(config.DATA_DIR, 'no-source.json');
const EXT = { webm: 'webm', mkv: 'mkv', mp4: 'mp4' };

function customMeta() {
  try {
    const m = JSON.parse(fs.readFileSync(META_FILE, 'utf8'));
    const file = path.join(config.DATA_DIR, `no-source.${EXT[m.container]}`);
    return fs.existsSync(file) ? { ...m, file, custom: true } : null;
  } catch {
    return null;
  }
}

/** Clip a lancer : { file, container, codec, width, height, durationMs, custom }. */
function clip() {
  return customMeta() || { ...DEFAULT_META, file: DEFAULT_FILE };
}

function enabled() {
  return config.get().settings.noSourceVideo !== false && fs.existsSync(clip().file);
}

/** Id de "version" du clip (le meme pour tous les titres). */
function sourceId() {
  return ids.register('nosource|clip', 'nosource', {});
}

const isClip = (mediaSourceId) => !!mediaSourceId && ids.norm(mediaSourceId) === sourceId();

/** Type d'un fichier video d'apres ses premiers octets. */
function sniff(buf) {
  if (buf.length > 12 && buf.readUInt32BE(0) === 0x1a45dfa3) return buf.subarray(0, 64).includes(Buffer.from('webm')) ? 'webm' : 'mkv';
  if (buf.length > 12 && buf.toString('ascii', 4, 8) === 'ftyp') return 'mp4';
  return null;
}

/** Element EBML a la position pos : { id, idLen, size, sizeLen, data, end, unknown }. */
function element(buf, pos) {
  const id = ebml.vint(buf, pos, true);
  const size = id && ebml.vint(buf, pos + id.len, false);
  if (!size) return null;
  const data = pos + id.len + size.len;
  return { id: id.value, start: pos, size: size.value, sizeLen: size.len, data, end: size.unknown ? buf.length : data + size.value, unknown: size.unknown };
}

/** Taille EBML sur 8 octets. */
function size8(n) {
  const b = Buffer.alloc(8);
  b[0] = 0x01;
  let v = n;
  for (let i = 7; i >= 1; i--) {
    b[i] = v % 256;
    v = Math.floor(v / 256);
  }
  return b;
}

/**
 * Les videos enregistrees par un navigateur (MediaRecorder) n'indiquent pas leur duree : on
 * l'ajoute dans l'en-tete (element Duration du Segment Info) pour que les apps l'affichent.
 */
function withDuration(buf, durationMs) {
  const head = element(buf, 0);
  const seg = head && element(buf, head.end);
  if (!seg || seg.id !== 0x18538067) return buf;
  let pos = seg.data;
  while (pos < Math.min(seg.end, buf.length)) {
    const el = element(buf, pos);
    if (!el) return buf;
    if (el.id === 0x1549a966) {
      let scale = 1e6;
      for (const c of ebml.children(buf, el.data, el.end)) {
        if (c.id === 0x4489) return buf; // duree deja presente
        if (c.id === 0x2ad7b1) scale = Number(buf.readUIntBE(c.start, Math.min(c.size, 6))) || 1e6;
      }
      const dur = Buffer.alloc(11);
      dur[0] = 0x44;
      dur[1] = 0x89;
      dur[2] = 0x88; // taille : 8 octets
      dur.writeDoubleBE((durationMs * 1e6) / scale, 3);
      const payload = Buffer.concat([buf.subarray(el.data, el.end), dur]);
      const info = Buffer.concat([buf.subarray(el.start, el.start + (el.data - el.start - el.sizeLen)), size8(payload.length), payload]);
      let out = Buffer.concat([buf.subarray(0, el.start), info, buf.subarray(el.end)]);
      // Segment de taille connue : sa taille grandit d'autant.
      if (!seg.unknown) {
        const grown = seg.size + (info.length - (el.end - el.start));
        const idLen = seg.data - seg.start - seg.sizeLen;
        out = Buffer.concat([out.subarray(0, seg.start + idLen), size8(grown), out.subarray(seg.data)]);
      }
      return out;
    }
    if (el.unknown) return buf;
    pos = el.end;
  }
  return buf;
}

/** Enregistre le clip choisi (video envoyee, ou creee dans le navigateur depuis une image). */
function save(buf, info = {}) {
  if (!Buffer.isBuffer(buf) || !buf.length) throw new Error('Vidéo vide');
  if (buf.length > MAX_BYTES) throw new Error('Vidéo trop lourde (50 Mo max.)');
  const container = sniff(buf);
  if (!container) throw new Error('Format non pris en charge (MP4, WebM ou MKV)');
  const durationMs = Math.max(0, Math.min(10 * 60e3, Math.round(Number(info.durationMs) || 0)));
  const data = container === 'mp4' || !durationMs ? buf : withDuration(buf, durationMs);
  remove();
  fs.writeFileSync(path.join(config.DATA_DIR, `no-source.${EXT[container]}`), data);
  const codec = /^(vp8|vp9|av1|h264|hevc)$/.test(info.codec) ? info.codec : container === 'mp4' ? 'h264' : 'vp8';
  const meta = { container, codec, width: Number(info.width) || 1280, height: Number(info.height) || 720, durationMs, updatedAt: Date.now() };
  fs.writeFileSync(META_FILE, JSON.stringify(meta));
  return describe();
}

/** Retour au clip fourni avec Stremfin. */
function remove() {
  for (const ext of Object.values(EXT)) fs.rmSync(path.join(config.DATA_DIR, `no-source.${ext}`), { force: true });
  fs.rmSync(META_FILE, { force: true });
}

function describe() {
  const c = clip();
  return { enabled: config.get().settings.noSourceVideo !== false, custom: !!c.custom, container: c.container, durationMs: c.durationMs, updatedAt: c.updatedAt || null, size: fs.existsSync(c.file) ? fs.statSync(c.file).size : 0 };
}

/** "Version" annoncee aux apps : le clip, a la place d'une source introuvable. */
function mediaSource(itemUuid, token, name) {
  const c = clip();
  const id = sourceId();
  return {
    Protocol: 'File',
    Id: id,
    Path: `${id}.${c.container}`,
    Type: 'Default',
    Container: c.container,
    Size: fs.statSync(c.file).size,
    Name: name,
    IsRemote: false,
    ETag: `${id}-${c.updatedAt || 0}`,
    RunTimeTicks: c.durationMs ? c.durationMs * 1e4 : undefined,
    SupportsTranscoding: false,
    SupportsDirectStream: true,
    SupportsDirectPlay: true,
    IsInfiniteStream: false,
    RequiresOpening: false,
    RequiresClosing: false,
    RequiresLooping: false,
    SupportsProbing: false,
    VideoType: 'VideoFile',
    MediaStreams: [{ Codec: c.codec, Type: 'Video', Index: 0, Width: c.width, Height: c.height, IsDefault: true, IsForced: false, IsExternal: false, IsInterlaced: false, IsTextSubtitleStream: false, SupportsExternalStream: false, VideoRange: 'SDR', VideoRangeType: 'SDR', Level: 0, DisplayTitle: `${c.height}p ${c.codec.toUpperCase()}` }],
    MediaAttachments: [],
    Formats: [],
    RequiredHttpHeaders: {},
    DefaultAudioStreamIndex: -1,
    DirectStreamUrl: `/Videos/${itemUuid}/stream.${c.container}?static=true&mediaSourceId=${id}&api_key=${token}`
  };
}

module.exports = { clip, enabled, isClip, sourceId, save, remove, describe, mediaSource, MAX_BYTES, _test: { withDuration, sniff } };
