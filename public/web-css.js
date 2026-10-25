// Ajoute au client web Jellyfin (servi par Stremfin) le CSS du profil connecte.
// Jellyfin web demande son CSS serveur sans jeton : il ne peut donc pas dependre du profil.
// Ce script lit le jeton du profil connecte et suit les connexions / changements de profil.
(function () {
  var SERVER_ID = '__SERVER_ID__';
  var last = null;

  function token() {
    try {
      var creds = JSON.parse(localStorage.getItem('jellyfin_credentials') || '{}');
      var s = (creds.Servers || []).filter(function (x) { return x.Id === SERVER_ID && x.AccessToken && x.UserId; })[0];
      return s ? s.AccessToken : '';
    } catch (e) {
      return '';
    }
  }

  function apply(css) {
    var el = document.getElementById('stremfin-profile-css');
    if (!el) {
      el = document.createElement('style');
      el.id = 'stremfin-profile-css';
      // En fin de page : passe apres les feuilles de style de Jellyfin web.
      document.body.appendChild(el);
    }
    if (el.textContent !== css) el.textContent = css;
  }

  function refresh(force) {
    var t = token();
    if (t === last && !force) return;
    last = t;
    if (!t) return apply('');
    fetch('/Branding/Css', { headers: { Authorization: 'MediaBrowser Token="' + t + '"' }, cache: 'no-store' })
      .then(function (r) { return r.ok ? r.text() : ''; })
      .then(apply)
      .catch(function () {});
  }

  refresh(true);
  setInterval(refresh, 2000);
  // Retour sur l'onglet : on reprend le CSS, il a pu changer dans l'interface Stremfin.
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) refresh(true);
  });
})();
