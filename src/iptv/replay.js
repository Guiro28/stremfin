// Replay (archive des programmes passes, "catch-up"), sur le modele de Polyfin (docs/iptv-replay.md).
// Adresse d'un programme selon le type d'archive de la chaine :
//   xc        {serveur}/timeshift/{u}/{p}/{minutes}/{AAAA-MM-JJ:HH-MM}/{id}.ts (heure du serveur)
//   default   catchup-source, ses variables remplies
//   append    adresse du flux + catchup-source rempli
//   shift     adresse du flux + ?utc={debut}&lutc={maintenant}
//   flussonic archive-{debut}-{duree}.ts a cote de la liste du flux
// Variables de catchup-source ({nom} ou ${nom}) : utc/start, utcend/end, lutc/now/timestamp,
// duration[:unite], offset[:unite], Y m d H M S, et {utc:Y-m-d H:M:S} (format libre).
const xtream = require('./xtream');

const MAX_DAYS = 7; // fenetre du guide (programmes passes gardes)

/** Jours d'archive d'une chaine (0 = pas de replay). Archive sans duree : un jour. */
function daysOf(ch) {
  const c = ch?.catchup;
  if (!c || !c.mode) return 0;
  if (!['xc', 'default', 'append', 'shift', 'flussonic', 'flussonic-hls', 'flussonic-ts', 'fs'].includes(c.mode)) return 0;
  if ((c.mode === 'default' || c.mode === 'append') && !c.source) return 0;
  return Math.min(MAX_DAYS, Math.max(1, Number(c.days) || Number(ch.archive_days) || 1));
}

function partsIn(ms, timezone) {
  try {
    const f = new Intl.DateTimeFormat('en-CA', { timeZone: timezone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
    const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
    return { Y: p.year, m: p.month, d: p.day, H: p.hour, M: p.minute, S: p.second };
  } catch {
    const d = new Date(ms);
    const z = (n) => String(n).padStart(2, '0');
    return { Y: String(d.getUTCFullYear()), m: z(d.getUTCMonth() + 1), d: z(d.getUTCDate()), H: z(d.getUTCHours()), M: z(d.getUTCMinutes()), S: z(d.getUTCSeconds()) };
  }
}

/** Remplit les variables d'un modele catchup-source. */
function fill(template, { start, stop, now = Date.now(), timezone }) {
  const sec = (ms) => Math.floor(ms / 1000);
  const times = { utc: start, start, utcend: stop, end: stop, lutc: now, now, timestamp: now };
  const base = partsIn(start, timezone);
  return String(template).replace(/\$?\{([a-z]+)(?::([^}]*))?\}/gi, (whole, name, arg) => {
    const n = name.toLowerCase();
    if (n === 'duration' || n === 'offset') {
      const s = n === 'duration' ? sec(stop - start) : sec(now - start);
      const unit = Number(arg) || 1;
      return String(Math.ceil(s / unit));
    }
    if (times[n] !== undefined) {
      if (!arg) return String(sec(times[n]));
      const p = partsIn(times[n], timezone);
      return arg.replace(/[YmdHMS]/g, (k) => p[k]);
    }
    if (/^[YmdHMS]$/.test(name)) return base[name];
    return whole;
  });
}

/** Serveur, identifiants et id d'une adresse de flux Xtream (http://hote/live/u/p/123.ts). */
function xtreamParts(url) {
  try {
    const u = new URL(url);
    const seg = u.pathname.split('/').filter(Boolean);
    const i = seg[0] === 'live' ? 1 : 0;
    if (seg.length - i < 3) return null;
    const id = seg[i + 2].replace(/\.\w+$/, '');
    return { server: `${u.protocol}//${u.host}`, username: decodeURIComponent(seg[i]), password: decodeURIComponent(seg[i + 1]), id };
  } catch {
    return null;
  }
}

/**
 * Adresse d'un programme passe (debut, fin en ms) d'une chaine (ligne effective iptv_channels),
 * ou null si la chaine n'a pas d'archive utilisable. src : la source (fuseau du compte Xtream).
 */
function urlFor(src, ch, start, stop) {
  if (!daysOf(ch)) return null;
  const c = ch.catchup;
  const tz = src.kind === 'xtream' ? src.account?.timezone || 'UTC' : 'UTC';
  const minutes = Math.ceil((stop - start) / 60e3);
  switch (c.mode) {
    case 'xc': {
      const id = String(ch.key).startsWith('x:') ? ch.key.slice(2) : xtreamParts(ch.url)?.id;
      if (src.kind === 'xtream' && id) return xtream.timeshiftUrl(src, id, start, minutes, tz);
      const p = xtreamParts(ch.url);
      return p ? xtream.timeshiftUrl(p, p.id, start, minutes, 'UTC') : null;
    }
    case 'default':
      return fill(c.source, { start, stop, timezone: tz });
    case 'append': {
      let add = fill(c.source, { start, stop, timezone: tz });
      if (add.startsWith('?') && ch.url.includes('?')) add = '&' + add.slice(1);
      return ch.url + add;
    }
    case 'shift':
      return `${ch.url}${ch.url.includes('?') ? '&' : '?'}utc=${Math.floor(start / 1000)}&lutc=${Math.floor(Date.now() / 1000)}`;
    default: {
      // flussonic : archive-<debut>-<duree>.ts a la place de la liste (index.m3u8, mpegts...).
      const name = `archive-${Math.floor(start / 1000)}-${Math.ceil((stop - start) / 1000)}.ts`;
      const u = new URL(ch.url);
      if (/\/(index|mono|video|playlist)[^/]*\.m3u8$|\/mpegts$/i.test(u.pathname)) u.pathname = u.pathname.replace(/\/[^/]+$/, '/' + name);
      else u.pathname = u.pathname.replace(/\/?$/, '/' + name);
      return u.toString();
    }
  }
}

module.exports = { daysOf, urlFor, fill, MAX_DAYS };
