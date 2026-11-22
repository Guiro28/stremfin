// Images des tuiles "Mes medias" generees par Stremfin (1920 x 1080, JPEG), dans le style de
// Polyfin : un mur de jaquettes de la bibliotheque en colonnes decalees, assombri par un degrade
// (plus sombre en bas), et le nom de la bibliotheque en gras blanc, centre, sur une ombre.
// Tout est fait en JavaScript (jpeg-js, pngjs, opentype.js), sans dependance native.
const fs = require('fs');
const path = require('path');
const jpeg = require('jpeg-js');
const { PNG } = require('pngjs');
const opentype = require('opentype.js');

// Formats : large (tuiles des bibliotheques, dossiers paysage) et affiche 2:3 (dossiers affiche).
const WIDE = { w: 1920, h: 1080, sizes: [150, 68], lines: 2 };
const POSTER = { w: 1000, h: 1500, sizes: [132, 60], lines: 3 };
// Dimensions du rendu en cours (le rendu est synchrone : une image a la fois).
let W = WIDE.w;
let H = WIDE.h;
// Fond entre les jaquettes (celui de Polyfin).
const BACKGROUND = [0x14, 0x16, 0x1a];
// Texte (comme Polyfin) : largeur maximale 84 % de l'image, tailles de la plus grande a la plus
// petite (x 0,92 a chaque pas), lignes au plus selon le format.
let TEXT_MAX_WIDTH = W * 0.84;
let SIZES = [];
let MAX_LINES = 2;
function sizes(largest, smallest) {
  const out = [];
  for (let s = largest; s > smallest; s *= 0.92) out.push(Math.round(s));
  return [...out, smallest];
}
// Sur-echantillonnage du texte (anticrenelage 4 x 4).
const SS = 4;

let font = null;
function loadFont() {
  if (!font) {
    const buf = fs.readFileSync(path.join(__dirname, '..', 'assets', 'fonts', 'Montserrat-Bold.woff'));
    font = opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  }
  return font;
}

// ---- Jaquettes ---------------------------------------------------------------------------

/** Image decodee { width, height, data (RGBA) } d'un JPEG ou d'un PNG, sinon null. */
function decode(buf) {
  try {
    if (!Buffer.isBuffer(buf) || buf.length < 8) return null;
    if (buf[0] === 0xff && buf[1] === 0xd8) {
      const img = jpeg.decode(buf, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 1024, maxResolutionInMP: 100 });
      return { width: img.width, height: img.height, data: img.data };
    }
    if (buf[0] === 0x89 && buf.toString('ascii', 1, 4) === 'PNG') {
      const img = PNG.sync.read(buf);
      return { width: img.width, height: img.height, data: img.data };
    }
  } catch {}
  return null;
}

function canvas() {
  const data = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    data[i * 4] = BACKGROUND[0];
    data[i * 4 + 1] = BACKGROUND[1];
    data[i * 4 + 2] = BACKGROUND[2];
    data[i * 4 + 3] = 255;
  }
  return data;
}

/** Reduction par moyenne de blocs f x f : evite le crenelage avant l'interpolation. */
function shrink(img, f) {
  if (f < 2) return img;
  const w = Math.floor(img.width / f);
  const h = Math.floor(img.height / f);
  const data = new Uint8Array(w * h * 4);
  const n = f * f;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let dy = 0; dy < f; dy++) {
        let i = ((y * f + dy) * img.width + x * f) * 4;
        for (let dx = 0; dx < f; dx++, i += 4) {
          r += img.data[i]; g += img.data[i + 1]; b += img.data[i + 2]; a += img.data[i + 3];
        }
      }
      const o = (y * w + x) * 4;
      data[o] = r / n; data[o + 1] = g / n; data[o + 2] = b / n; data[o + 3] = a / n;
    }
  }
  return { width: w, height: h, data };
}

/** Dessine img dans le rectangle (bx, by, bw, bh), en le couvrant (recadrage centre). Interpolation bilineaire. */
function drawCover(dst, img, bx, by, bw, bh) {
  let scale = Math.max(bw / img.width, bh / img.height);
  const f = Math.floor(1 / scale);
  if (f >= 2) {
    img = shrink(img, f);
    scale = Math.max(bw / img.width, bh / img.height);
  }
  const ox = (bw - img.width * scale) / 2;
  const oy = (bh - img.height * scale) / 2;
  const x0 = Math.max(0, Math.floor(bx));
  const x1 = Math.min(W, Math.ceil(bx + bw));
  const y0 = Math.max(0, Math.floor(by));
  const y1 = Math.min(H, Math.ceil(by + bh));
  const src = img.data;
  const iw = img.width;
  const ih = img.height;
  for (let y = y0; y < y1; y++) {
    const sy = Math.min(ih - 1, Math.max(0, (y - by - oy) / scale - 0.5));
    const yA = Math.floor(sy);
    const yB = Math.min(ih - 1, yA + 1);
    const fy = sy - yA;
    for (let x = x0; x < x1; x++) {
      const sx = Math.min(iw - 1, Math.max(0, (x - bx - ox) / scale - 0.5));
      const xA = Math.floor(sx);
      const xB = Math.min(iw - 1, xA + 1);
      const fx = sx - xA;
      const o = (y * W + x) * 4;
      const a = (yA * iw + xA) * 4;
      const b = (yA * iw + xB) * 4;
      const c = (yB * iw + xA) * 4;
      const d = (yB * iw + xB) * 4;
      const alpha = src[a + 3] / 255;
      for (let k = 0; k < 3; k++) {
        const top = src[a + k] + (src[b + k] - src[a + k]) * fx;
        const bottom = src[c + k] + (src[d + k] - src[c + k]) * fx;
        dst[o + k] = dst[o + k] * (1 - alpha) + (top + (bottom - top) * fy) * alpha;
      }
    }
  }
}

/** Mur de jaquettes (2:3) en colonnes decalees sur toute la largeur. */
function drawPosterWall(dst, posters) {
  const pw = 300;
  const ph = 450;
  const gap = 16;
  // Colonnes centrees : le mur deborde un peu des deux cotes.
  const columns = Math.ceil(W / (pw + gap)) + 1;
  const left = (W - columns * (pw + gap) + gap) / 2;
  const slots = [];
  for (let col = 0; col < columns; col++) {
    const x = left + col * (pw + gap);
    const shift = col % 2 ? -ph / 2 - 60 : -60;
    for (let row = 0, y = shift; y < H; row++, y += ph + gap) slots.push({ x, y, col, row });
  }
  // Assez de jaquettes : chaque case a la sienne. Sinon, ordre melange pour que deux jaquettes
  // voisines (dans la colonne ou d'une colonne a l'autre) different.
  const enough = posters.length >= slots.length;
  slots.forEach((s, i) => {
    const poster = posters[enough ? i : (s.col * 2 + s.row) % posters.length];
    drawCover(dst, poster, s.x, s.y, pw, ph);
  });
}

/** Nombre de cases du mur (jaquettes differentes qu'il peut montrer) selon le format. */
function wallSlots(poster = false) {
  const w = poster ? POSTER.w : WIDE.w;
  const h = poster ? POSTER.h : WIDE.h;
  const columns = Math.ceil(w / 316) + 1;
  let n = 0;
  for (let col = 0; col < columns; col++) for (let y = col % 2 ? -285 : -60; y < h; y += 466) n++;
  return n;
}

/** Degrade de Polyfin : noir de 32 % en haut a 88 % en bas, pour que le nom se lise partout. */
function shade(dst) {
  for (let y = 0; y < H; y++) {
    const a = 0.32 + 0.56 * Math.pow(y / H, 1.4);
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 4;
      dst[o] *= 1 - a;
      dst[o + 1] *= 1 - a;
      dst[o + 2] *= 1 - a;
    }
  }
}

// ---- Nom ---------------------------------------------------------------------------------

/** Lignes du nom a la taille size : mots regroupes tant que la ligne tient (un mot n'est jamais coupe). */
function wrap(f, words, size) {
  const width = (s) => f.getAdvanceWidth(s, size);
  const lines = [];
  for (const word of words) {
    const last = lines[lines.length - 1];
    if (last && width(`${last} ${word}`) <= TEXT_MAX_WIDTH) lines[lines.length - 1] = `${last} ${word}`;
    else lines.push(word);
  }
  // Coupe a un separateur : il disparait (« Disney Animated » puis « Films »).
  const clean = lines.map((l, i) => (i ? l.replace(/^[·\-–—|] /, '') : l));
  return { lines: clean, fits: clean.length <= MAX_LINES && clean.every((l) => width(l) <= TEXT_MAX_WIDTH) };
}

/** Taille et lignes du nom : la plus grande taille ou tout tient. */
function layout(f, name) {
  // Un separateur seul (« · », « - », « – », « | ») part a la ligne avec le mot qui le suit.
  const words = [];
  for (const w of name.split(/\s+/).filter(Boolean)) {
    const last = words[words.length - 1];
    if (last && /^[·\-–—|]$/.test(last)) words[words.length - 1] = `${last} ${w}`;
    else words.push(w);
  }
  for (const size of SIZES) {
    const w = wrap(f, words, size);
    if (w.fits) return { size, lines: w.lines };
  }
  const size = SIZES[SIZES.length - 1];
  return { size, lines: wrap(f, words, size).lines.slice(0, MAX_LINES) };
}

/** Contours d'un chemin opentype en polygones (courbes aplaties), a l'echelle k. */
function polygons(cmds, k) {
  const polys = [];
  let cur = [];
  let px = 0, py = 0, sx = 0, sy = 0;
  const pt = (x, y) => cur.push([x * k, y * k]);
  for (const c of cmds) {
    if (c.type === 'M') {
      if (cur.length > 2) polys.push(cur);
      cur = [];
      pt(c.x, c.y);
      px = sx = c.x; py = sy = c.y;
    } else if (c.type === 'L') {
      pt(c.x, c.y);
      px = c.x; py = c.y;
    } else if (c.type === 'Q') {
      for (let i = 1; i <= 8; i++) {
        const t = i / 8, u = 1 - t;
        pt(u * u * px + 2 * u * t * c.x1 + t * t * c.x, u * u * py + 2 * u * t * c.y1 + t * t * c.y);
      }
      px = c.x; py = c.y;
    } else if (c.type === 'C') {
      for (let i = 1; i <= 12; i++) {
        const t = i / 12, u = 1 - t;
        pt(u * u * u * px + 3 * u * u * t * c.x1 + 3 * u * t * t * c.x2 + t * t * t * c.x,
          u * u * u * py + 3 * u * u * t * c.y1 + 3 * u * t * t * c.y2 + t * t * t * c.y);
      }
      px = c.x; py = c.y;
    } else if (c.type === 'Z') {
      if (cur.length > 2) polys.push(cur);
      cur = [];
      px = sx; py = sy;
    }
  }
  if (cur.length > 2) polys.push(cur);
  return polys;
}

/** Masque de couverture (0..1) des polygones, regle non nulle, sur-echantillonne SS x SS. */
function rasterize(polys, top, bottom) {
  const mask = new Float32Array(W * H);
  const edges = [];
  for (const p of polys) {
    for (let i = 0; i < p.length; i++) {
      const [x1, y1] = p[i];
      const [x2, y2] = p[(i + 1) % p.length];
      if (y1 === y2) continue;
      edges.push(y1 < y2 ? [x1, y1, x2, y2, 1] : [x2, y2, x1, y1, -1]);
    }
  }
  const y0 = Math.max(0, Math.floor(top * SS));
  const y1 = Math.min(H * SS, Math.ceil(bottom * SS));
  const add = 1 / (SS * SS);
  const xs = [];
  for (let sy = y0; sy < y1; sy++) {
    const y = sy + 0.5;
    xs.length = 0;
    for (const e of edges) {
      if (y < e[1] || y >= e[3]) continue;
      xs.push([e[0] + ((y - e[1]) * (e[2] - e[0])) / (e[3] - e[1]), e[4]]);
    }
    if (!xs.length) continue;
    xs.sort((a, b) => a[0] - b[0]);
    const row = Math.floor(sy / SS) * W;
    let wind = 0;
    for (let i = 0; i < xs.length - 1; i++) {
      wind += xs[i][1];
      if (!wind) continue;
      const a = Math.max(0, Math.ceil(xs[i][0] - 0.5));
      const b = Math.min(W * SS, Math.floor(xs[i + 1][0] - 0.5) + 1);
      for (let sx = a; sx < b; sx++) mask[row + ((sx / SS) | 0)] += add;
    }
  }
  return mask;
}

/** Ecrit le nom au milieu de l'image, centre, en blanc sur une ombre decalee (comme Polyfin). */
function drawName(dst, name) {
  const f = loadFont();
  const text = String(name || '').replace(/\s+/g, ' ').trim().replace(/'/g, '’');
  if (!text) return;
  const { size, lines } = layout(f, text);
  const ascent = (f.ascender / f.unitsPerEm) * size;
  const descent = (-f.descender / f.unitsPerEm) * size;
  const lineHeight = (ascent + descent) * 1.08;
  const top = (H - lineHeight * lines.length) / 2;
  const offset = Math.max(2, size * 0.035);
  const polys = [];
  const shadowPolys = [];
  lines.forEach((line, i) => {
    const x = (W - f.getAdvanceWidth(line, size)) / 2;
    const baseline = top + i * lineHeight + (lineHeight - ascent - descent) / 2 + ascent;
    polys.push(...polygons(f.getPath(line, x, baseline, size).commands, SS));
    shadowPolys.push(...polygons(f.getPath(line, x + offset, baseline + offset, size).commands, SS));
  });
  const y0 = Math.floor(top - size * 0.2);
  const y1 = Math.ceil(top + lineHeight * lines.length + offset + size * 0.2);
  const mask = rasterize(polys, y0, y1);
  const shadow = rasterize(shadowPolys, y0, y1);
  for (let y = Math.max(0, y0); y < Math.min(H, y1); y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const s = Math.min(1, shadow[i]) * (150 / 255);
      const m = Math.min(1, mask[i]);
      if (!s && !m) continue;
      const o = i * 4;
      for (let k = 0; k < 3; k++) dst[o + k] = dst[o + k] * (1 - s) * (1 - m) + 255 * m;
    }
  }
}

// ---- Rendu -------------------------------------------------------------------------------

/**
 * Image d'une bibliotheque ou d'un dossier : posters (Buffers JPEG/PNG des jaquettes), nom, et
 * format (poster : true pour une affiche 2:3, sinon large 16:9). Renvoie un JPEG.
 */
function render({ posters, title, poster = false }) {
  const decoded = (posters || []).map(decode).filter(Boolean);
  if (!decoded.length) throw new Error('Aucune jaquette utilisable');
  const fmt = poster ? POSTER : WIDE;
  W = fmt.w;
  H = fmt.h;
  TEXT_MAX_WIDTH = W * 0.84;
  SIZES = sizes(fmt.sizes[0], fmt.sizes[1]);
  MAX_LINES = fmt.lines;
  const dst = canvas();
  drawPosterWall(dst, decoded);
  shade(dst);
  drawName(dst, title);
  return jpeg.encode({ data: dst, width: W, height: H }, 88).data;
}

module.exports = { render, wallSlots };
