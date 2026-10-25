// Avatars des profils : stockes dans data/avatars, servis aux apps via /Users/{id}/Images/Primary.
const fs = require('fs');
const path = require('path');
const config = require('./config');

const DIR = path.join(config.DATA_DIR, 'avatars');
const MAX_BYTES = 3 * 1024 * 1024;

const TYPES = {
  png: 'image/png',
  jpg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif'
};

/** Type reel de l'image d'apres ses premiers octets (on ne se fie pas a l'en-tete HTTP). */
function sniff(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0x89 && buf.toString('ascii', 1, 4) === 'PNG') return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  if (buf.toString('ascii', 0, 3) === 'GIF') return 'gif';
  return null;
}

function remove(profile) {
  if (profile.avatar) {
    try { fs.unlinkSync(path.join(DIR, path.basename(profile.avatar))); } catch {}
  }
  profile.avatar = null;
  profile.avatarAt = null;
  config.save();
}

function save(profile, buf) {
  if (!Buffer.isBuffer(buf) || !buf.length) throw new Error('Image vide');
  if (buf.length > MAX_BYTES) throw new Error('Image trop lourde (3 Mo max.)');
  const ext = sniff(buf);
  if (!ext) throw new Error('Format non pris en charge (PNG, JPEG, WebP ou GIF)');
  fs.mkdirSync(DIR, { recursive: true });
  if (profile.avatar) {
    try { fs.unlinkSync(path.join(DIR, path.basename(profile.avatar))); } catch {}
  }
  const file = `${profile.id}.${ext}`;
  fs.writeFileSync(path.join(DIR, file), buf);
  profile.avatar = file;
  profile.avatarAt = Date.now();
  config.save();
}

/** { file, type } de l'avatar d'un profil, ou null. */
function get(profile) {
  if (!profile?.avatar) return null;
  const file = path.join(DIR, path.basename(profile.avatar));
  if (!fs.existsSync(file)) return null;
  return { file, type: TYPES[path.extname(file).slice(1)] || 'application/octet-stream' };
}

function tag(profile) {
  return profile?.avatar && profile.avatarAt ? String(profile.avatarAt) : undefined;
}

module.exports = { save, remove, get, tag, sniff, TYPES, MAX_BYTES };
