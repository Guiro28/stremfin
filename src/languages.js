// Codes de langue : 2 lettres dans Stremfin (fr, en...), 3 lettres ISO 639-2 "bibliographiques"
// dans les apps Jellyfin / Emby et les fichiers Matroska (fre, eng, ger...).
const TO2 = { fre: 'fr', fra: 'fr', eng: 'en', spa: 'es', ger: 'de', deu: 'de', ita: 'it', por: 'pt', dut: 'nl', nld: 'nl', jpn: 'ja', chi: 'zh', zho: 'zh', kor: 'ko', rus: 'ru', ara: 'ar', pol: 'pl', swe: 'sv', dan: 'da', nor: 'no', nob: 'no', fin: 'fi', tur: 'tr', gre: 'el', ell: 'el', heb: 'he', hin: 'hi', cze: 'cs', ces: 'cs', hun: 'hu', rum: 'ro', ron: 'ro', ukr: 'uk', tha: 'th', vie: 'vi', ind: 'id', may: 'ms', msa: 'ms', per: 'fa', fas: 'fa', cat: 'ca', bul: 'bg', hrv: 'hr', srp: 'sr', slo: 'sk', slk: 'sk', slv: 'sl', ice: 'is', isl: 'is', est: 'et', lav: 'lv', lit: 'lt', baq: 'eu', eus: 'eu', glg: 'gl', wel: 'cy', cym: 'cy' };
// Code a 3 lettres prefere par les apps (forme bibliographique : fre plutot que fra).
const TO3 = {};
for (const [three, two] of Object.entries(TO2)) if (!TO3[two]) TO3[two] = three;

/** "fre", "fra", "fr-FR", "FR" -> "fr" ; code inconnu garde tel quel (en minuscules). */
function to2(code) {
  const c = String(code || '').trim().toLowerCase().split(/[-_]/)[0];
  if (!c) return '';
  return TO2[c] || c;
}

/** "fr" -> "fre" (pour les apps) ; vide si inconnu. */
function to3(code) {
  const two = to2(code);
  return TO3[two] || (two.length === 3 ? two : '');
}

/** Codes acceptes pour une langue (2 lettres et ses formes a 3 lettres). */
function variants(code) {
  const two = to2(code);
  return [two, ...Object.keys(TO2).filter((k) => TO2[k] === two)];
}

/**
 * Langues proposees par les apps (reglages audio / sous-titres), au format Jellyfin / Emby
 * (/Localization/Cultures). Noms affiches dans la langue des libelles du serveur.
 */
function cultures(locale = 'fr') {
  const label = (two, lang) => {
    try {
      const name = new Intl.DisplayNames([lang], { type: 'language' }).of(two);
      return name && name !== two ? name[0].toUpperCase() + name.slice(1) : two;
    } catch {
      return two;
    }
  };
  return Object.keys(TO3)
    .map((two) => ({
      Name: label(two, 'en'),
      DisplayName: label(two, locale),
      TwoLetterISOLanguageName: two,
      ThreeLetterISOLanguageName: TO3[two],
      ThreeLetterISOLanguageNames: Object.keys(TO2).filter((k) => TO2[k] === two)
    }))
    .sort((a, b) => a.DisplayName.localeCompare(b.DisplayName, locale));
}

module.exports = { to2, to3, variants, cultures };
