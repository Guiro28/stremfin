// Hachage des mots de passe (scrypt, sel aleatoire) et comparaisons a temps constant.
const crypto = require('crypto');

const KEYLEN = 64;
const COST = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, KEYLEN, COST);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  if (!stored || typeof stored !== 'string') return false;
  const [algo, saltHex, hashHex] = stored.split('$');
  if (algo !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(String(password ?? ''), Buffer.from(saltHex, 'hex'), expected.length, COST);
  return crypto.timingSafeEqual(expected, actual);
}

function sha256(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

/** Regles minimales pour un mot de passe choisi par l'utilisateur. */
function passwordProblem(pw) {
  const s = String(pw || '');
  if (s.length < 8) return 'Le mot de passe doit faire au moins 8 caractères';
  if (s.length > 200) return 'Mot de passe trop long';
  return null;
}

module.exports = { hashPassword, verifyPassword, sha256, passwordProblem };
