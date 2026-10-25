// Pistes d'un fichier video (audio, sous-titres integres) lues dans l'en-tete du fichier, sans
// le telecharger : Matroska (.mkv / .webm) d'abord, ou les pistes sont decrites au debut.
// Les apps Jellyfin / Emby ne proposent que les pistes que le serveur leur annonce.
const { request } = require('./http');

const HEAD_BYTES = 1024 * 1024; // en-tete lu (les pistes y sont presque toujours)
// Le premier acces a un lien de debrideur peut attendre que le fichier soit pret.
const TIMEOUT = 12000;

// Identifiants EBML utiles (https://www.matroska.org/technical/elements.html).
const ID = {
  EBML: 0x1a45dfa3,
  Segment: 0x18538067,
  SeekHead: 0x114d9b74,
  Seek: 0x4dbb,
  SeekID: 0x53ab,
  SeekPosition: 0x53ac,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackNumber: 0xd7,
  TrackType: 0x83,
  CodecID: 0x86,
  Language: 0x22b59c,
  LanguageIETF: 0x22b59d,
  Name: 0x536e,
  FlagDefault: 0x88,
  FlagForced: 0x55aa,
  FlagHearingImpaired: 0x55ab,
  Video: 0xe0,
  PixelWidth: 0xb0,
  PixelHeight: 0xba,
  Audio: 0xe1,
  Channels: 0x9f,
  Cluster: 0x1f43b675
};

/** Lit un nombre EBML a taille variable (id : marqueur garde ; taille : marqueur retire). */
function vint(buf, pos, keepMarker) {
  const first = buf[pos];
  if (first === undefined) return null;
  let len = 1;
  while (len <= 8 && !(first & (0x80 >> (len - 1)))) len++;
  if (len > 8 || pos + len > buf.length) return null;
  let value = keepMarker ? first : first & (0xff >> len);
  let unknown = value === (0xff >> len);
  for (let i = 1; i < len; i++) {
    value = value * 256 + buf[pos + i];
    if (buf[pos + i] !== 0xff) unknown = false;
  }
  return { value, len, unknown: !keepMarker && unknown };
}

/** Elements enfants de buf[start, end) : [{ id, start (donnees), size, end }]. */
function children(buf, start, end) {
  const out = [];
  let pos = start;
  while (pos < end) {
    const id = vint(buf, pos, true);
    if (!id) break;
    const size = vint(buf, pos + id.len, false);
    if (!size) break;
    const data = pos + id.len + size.len;
    const stop = size.unknown ? end : data + size.value;
    out.push({ id: id.value, start: data, size: size.unknown ? end - data : size.value, end: stop, unknown: size.unknown });
    if (size.unknown) break;
    pos = stop;
  }
  return out;
}

const uint = (buf, el) => {
  let v = 0;
  for (let i = el.start; i < Math.min(el.end, buf.length); i++) v = v * 256 + buf[i];
  return v;
};
const str = (buf, el) => buf.toString('utf8', el.start, Math.min(el.end, buf.length)).replace(/\0+$/, '');

function parseTrack(buf, entry) {
  const t = { language: 'eng', default: true, forced: false, hearingImpaired: false };
  for (const el of children(buf, entry.start, entry.end)) {
    if (el.id === ID.TrackNumber) t.number = uint(buf, el);
    else if (el.id === ID.TrackType) t.type = { 1: 'video', 2: 'audio', 17: 'subtitle' }[uint(buf, el)];
    else if (el.id === ID.CodecID) t.codecId = str(buf, el);
    else if (el.id === ID.Language) t.language = str(buf, el) || 'eng';
    else if (el.id === ID.LanguageIETF) t.languageIetf = str(buf, el);
    else if (el.id === ID.Name) t.name = str(buf, el);
    else if (el.id === ID.FlagDefault) t.default = uint(buf, el) === 1;
    else if (el.id === ID.FlagForced) t.forced = uint(buf, el) === 1;
    else if (el.id === ID.FlagHearingImpaired) t.hearingImpaired = uint(buf, el) === 1;
    else if (el.id === ID.Video) {
      for (const v of children(buf, el.start, el.end)) {
        if (v.id === ID.PixelWidth) t.width = uint(buf, v);
        else if (v.id === ID.PixelHeight) t.height = uint(buf, v);
      }
    } else if (el.id === ID.Audio) {
      for (const a of children(buf, el.start, el.end)) if (a.id === ID.Channels) t.channels = uint(buf, a);
    }
  }
  return t.type ? t : null;
}

function parseTracks(buf, el) {
  if (el.end > buf.length) return null; // element coupe : il faut lire plus loin
  return children(buf, el.start, el.end)
    .filter((e) => e.id === ID.TrackEntry)
    .map((e) => parseTrack(buf, e))
    .filter(Boolean);
}

/** Octets [from, from + length) du fichier (requete partielle), ou null. */
async function readRange(url, from, length, opts) {
  const { res } = await request(url, {
    upstream: opts.upstream,
    timeout: TIMEOUT,
    headers: { ...(opts.headers || {}), range: `bytes=${from}-${from + length - 1}`, 'user-agent': opts.headers?.['user-agent'] || 'Mozilla/5.0', accept: '*/*' }
  });
  // Serveur sans requetes partielles : on ne lit que le debut, puis on coupe.
  if (res.statusCode !== 206 && !(res.statusCode === 200 && from === 0)) {
    res.destroy();
    throw new Error(`reponse ${res.statusCode}`);
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    const timer = setTimeout(() => done(), TIMEOUT);
    const done = () => {
      clearTimeout(timer);
      res.destroy();
      resolve(Buffer.concat(chunks, Math.min(n, length)));
    };
    res.on('data', (c) => {
      chunks.push(c);
      n += c.length;
      if (n >= length) done();
    });
    res.on('end', done);
    res.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

/**
 * Pistes d'un fichier Matroska : [{ number, type, codecId, language, name, default, forced,
 * hearingImpaired, width, height, channels }] dans l'ordre du fichier, ou null.
 */
async function mkvTracks(url, opts = {}) {
  const head = await readRange(url, 0, HEAD_BYTES, opts);
  if (!head || head.length < 4 || head.readUInt32BE(0) !== ID.EBML) throw new Error('pas un fichier Matroska');
  const top = children(head, 0, head.length);
  const segment = top.find((e) => e.id === ID.Segment);
  if (!segment) return null;
  const parts = children(head, segment.start, Math.min(segment.end, head.length));
  const tracks = parts.find((e) => e.id === ID.Tracks);
  if (tracks) {
    const list = parseTracks(head, tracks);
    if (list) return list;
  }
  // Pistes plus loin dans le fichier : leur position est donnee par l'index (SeekHead).
  const seekHead = parts.find((e) => e.id === ID.SeekHead);
  if (!seekHead) return null;
  for (const seek of children(head, seekHead.start, seekHead.end).filter((e) => e.id === ID.Seek)) {
    const fields = children(head, seek.start, seek.end);
    const sid = fields.find((e) => e.id === ID.SeekID);
    const spos = fields.find((e) => e.id === ID.SeekPosition);
    if (!sid || !spos || uint(head, sid) !== ID.Tracks) continue;
    const at = segment.start + uint(head, spos);
    const chunk = await readRange(url, at, 256 * 1024, opts);
    if (!chunk) return null;
    const [el] = children(chunk, 0, chunk.length);
    return el?.id === ID.Tracks ? parseTracks(chunk, el) : null;
  }
  return null;
}

module.exports = { mkvTracks, _test: { vint, children } };
