// Ajouts Stremfin au bandeau Spotlight du theme Abyss (charge dans spotlight.html).
// Mode "tendances" : films tendance TMDB (meme hors bibliotheques), avec leur annee.
// Mode "reprises" : contenu d'origine d'Abyss.
(function () {
  var MODE = '__MODE__';
  var CALENDAR = '<svg xmlns="http://www.w3.org/2000/svg" height="20px" viewBox="0 -960 960 960" width="20px" fill="#e3e3e3"><path d="M216-96q-29.7 0-50.85-21.5Q144-139 144-168v-528q0-29 21.15-50.5T216-768h72v-60q0-15.3 10.29-25.65Q308.58-864 323.79-864t25.71 10.35Q360-843.3 360-828v60h240v-60q0-15.3 10.29-25.65Q620.58-864 635.79-864t25.71 10.35Q672-843.3 672-828v60h72q29.7 0 50.85 21.5Q816-725 816-696v528q0 29-21.15 50.5T744-96H216Zm0-72h528v-360H216v360Z"/></svg>';

  var api = {
    mode: MODE,
    // Les tendances changent peu : un film reste affiche un peu plus longtemps.
    interval: MODE === 'trending' ? 8000 : 5000
  };

  /** Films tendance (vide sans cle TMDB : Spotlight revient alors a son contenu habituel). */
  api.fetchItems = async function (base, headers, signal) {
    var r = await fetch(base + '/Stremfin/Spotlight', { headers: headers, signal: signal });
    if (!r.ok) return [];
    var data = await r.json();
    return (data.Items || []).map(function (item) {
      return Object.assign({}, item, { _source: 'trending' });
    });
  };

  /** Pastille "annee" (avant la duree et la note). */
  api.yearPill = function (item, meta, metaPillWithIcon) {
    if (item._source === 'trending' && item.ProductionYear) meta.appendChild(metaPillWithIcon(CALENDAR, item.ProductionYear));
  };

  window.StremfinSpotlight = api;
})();
