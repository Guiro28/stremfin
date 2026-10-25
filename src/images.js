// Cartes larges (16:9) des plateformes : le logo officiel (icone carree TMDB) centre sur un
// fond de la couleur de ses bords, comme une vignette "Netflix", "Canal+"... Generees une fois,
// puis gardees sur disque. JavaScript pur (pngjs / jpeg-js), aucune dependance native.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { PNG } = require('pngjs');
const jpeg = require('jpeg-js');
const config = require('./config');
const tmdb = require('./tmdb');
const { request, readAll } = require('./http');

const DIR = path.join(config.DATA_DIR, 'images');
const W = 640;
const H = 360;

async function download(url) {
  const { res } = await request(url, { timeout: 15000, headers: { 'user-agent': 'Stremfin/0.1' } });
  const buf = await readAll(res);
  if ((res.statusCode || 0) >= 400) throw new Error(`HTTP ${res.statusCode}`);
  return buf;
}

/** Image -> { width, height, data (RGBA) }. */
function decode(buf) {
  if (buf[0] === 0x89 && buf.toString('ascii', 1, 4) === 'PNG') return PNG.sync.read(buf);
  if (buf[0] === 0xff && buf[1] === 0xd8) return jpeg.decode(buf, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 256 });
  throw new Error('Format de logo non pris en charge');
}

function hexToRgb(hex) {
  const m = String(hex || '').match(/^#?([0-9a-f]{6})$/i);
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Couleur moyenne des colonnes de bord : le fond se prolonge sans raccord visible. */
function edgeColor(img) {
  let r = 0, g = 0, b = 0, n = 0;
  const band = Math.max(1, Math.round(img.width * 0.03));
  for (let y = 0; y < img.height; y++) {
    for (const x0 of [0, img.width - band]) {
      for (let x = x0; x < x0 + band; x++) {
        const i = (y * img.width + x) * 4;
        if (img.data[i + 3] < 128) continue;
        r += img.data[i]; g += img.data[i + 1]; b += img.data[i + 2]; n++;
      }
    }
  }
  return n ? [r / n, g / n, b / n].map(Math.round) : [0, 0, 0];
}

/** Redimensionnement bilineaire de src dans dst (RGBA), en position (ox, oy), taille size x size. */
function drawScaled(src, dst, ox, oy, size, bg) {
  for (let y = 0; y < size; y++) {
    const sy = ((y + 0.5) * src.height) / size - 0.5;
    const y0 = Math.max(0, Math.floor(sy));
    const y1 = Math.min(src.height - 1, y0 + 1);
    const fy = Math.min(1, Math.max(0, sy - y0));
    for (let x = 0; x < size; x++) {
      const sx = ((x + 0.5) * src.width) / size - 0.5;
      const x0 = Math.max(0, Math.floor(sx));
      const x1 = Math.min(src.width - 1, x0 + 1);
      const fx = Math.min(1, Math.max(0, sx - x0));
      const di = ((oy + y) * W + (ox + x)) * 4;
      const px = [0, 0, 0, 0];
      for (let c = 0; c < 4; c++) {
        const a = src.data[(y0 * src.width + x0) * 4 + c] * (1 - fx) + src.data[(y0 * src.width + x1) * 4 + c] * fx;
        const b = src.data[(y1 * src.width + x0) * 4 + c] * (1 - fx) + src.data[(y1 * src.width + x1) * 4 + c] * fx;
        px[c] = a * (1 - fy) + b * fy;
      }
      const alpha = px[3] / 255;
      for (let c = 0; c < 3; c++) dst.data[di + c] = Math.round(px[c] * alpha + bg[c] * (1 - alpha));
      dst.data[di + 3] = 255;
    }
  }
}

/** Remplit a gauche et a droite de l'icone avec la couleur de son bord, ligne par ligne. */
function extendEdges(img, left, right) {
  const at = (x, y) => (y * W + x) * 4;
  for (let y = 0; y < H; y++) {
    const avg = (x0) => {
      const c = [0, 0, 0];
      for (let x = x0; x < x0 + 2; x++) for (let k = 0; k < 3; k++) c[k] += img.data[at(x, y) + k] / 2;
      return c.map(Math.round);
    };
    const l = avg(left + 1);
    const r = avg(right - 2);
    for (let x = 0; x <= left; x++) img.data.set([l[0], l[1], l[2], 255], at(x, y));
    for (let x = right; x < W; x++) img.data.set([r[0], r[1], r[2], 255], at(x, y));
  }
}

const pending = new Map();

/**
 * Chemin du PNG de la carte d'une plateforme (genere si besoin), ou { redirect } si l'admin a
 * fourni sa propre image, ou null si la plateforme est inconnue.
 */
async function platformCard(id) {
  const provider = (config.get().settings.providers || []).find((p) => p.id === id);
  if (!provider) return null;
  if (provider.card) return { redirect: provider.card };
  const info = await tmdb.providerInfo(id);
  if (!info?.logoLarge) return null;
  const key = crypto.createHash('sha1').update(`${info.logoLarge}|${provider.color || ''}|v2`).digest('hex').slice(0, 12);
  const file = path.join(DIR, `platform-${id}-${key}.png`);
  if (fs.existsSync(file)) return file;
  if (pending.has(file)) return pending.get(file);
  const job = (async () => {
    const logo = decode(await download(info.logoLarge));
    const fixed = hexToRgb(provider.color);
    const bg = fixed || edgeColor(logo);
    const out = new PNG({ width: W, height: H });
    for (let i = 0; i < W * H; i++) out.data.set([bg[0], bg[1], bg[2], 255], i * 4);
    const ox = Math.round((W - H) / 2);
    drawScaled(logo, out, ox, 0, H, bg);
    // Sans couleur imposee : chaque ligne prolonge le bord de l'icone (degrades sans raccord).
    if (!fixed) extendEdges(out, ox, ox + H - 1);
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(file, PNG.sync.write(out));
    // Les anciennes versions de cette carte ne servent plus.
    for (const f of fs.readdirSync(DIR)) if (f.startsWith(`platform-${id}-`) && f !== path.basename(file)) fs.rmSync(path.join(DIR, f), { force: true });
    return file;
  })().finally(() => pending.delete(file));
  pending.set(file, job);
  return job;
}

/** URL (relative au serveur) de la carte, avec une etiquette qui change quand elle change. */
function platformCardUrl(provider) {
  const v = crypto.createHash('sha1').update(`${provider.card || ''}|${provider.color || ''}`).digest('hex').slice(0, 8);
  return `/stremfin/platform/${provider.id}.png?v=${v}`;
}

module.exports = { platformCard, platformCardUrl };
