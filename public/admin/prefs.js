'use strict';
// Preferences d'affichage de l'interface (propres au navigateur) : langue et theme.
// Traductions : le texte francais sert de cle ; un dictionnaire par langue
// (/stremfin/ui/i18n/<langue>.js) est charge a la demande. Une cle absente reste en francais.
(function () {
  var SUPPORTED = ['fr', 'en', 'es', 'de', 'it'];
  var NAMES = { fr: 'Français', en: 'English', es: 'Español', de: 'Deutsch', it: 'Italiano' };
  var LOCALES = { fr: 'fr-FR', en: 'en-GB', es: 'es-ES', de: 'de-DE', it: 'it-IT' };
  var store = {
    get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  };

  function resolveLang() {
    var stored = store.get('stremfin_lang');
    if (SUPPORTED.indexOf(stored) !== -1) return stored;
    var list = navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || ''];
    for (var i = 0; i < list.length; i++) {
      var code = String(list[i] || '').toLowerCase().slice(0, 2);
      if (SUPPORTED.indexOf(code) !== -1) return code;
    }
    return 'fr';
  }

  var lang = resolveLang();
  var dict = {};
  document.documentElement.lang = lang;

  // Theme applique tout de suite (avant l'affichage) pour eviter un flash.
  var theme = store.get('stremfin_theme') === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = theme;

  var ready = lang === 'fr'
    ? Promise.resolve()
    : new Promise(function (resolve) {
        var s = document.createElement('script');
        s.src = '/stremfin/ui/i18n/' + lang + '.js';
        s.onload = s.onerror = function () { resolve(); };
        document.head.appendChild(s);
      });

  /** Traduit un texte francais ; {nom} est remplace par vars.nom. */
  window.t = function (key, vars) {
    var value = Object.prototype.hasOwnProperty.call(dict, key) ? dict[key] : key;
    if (vars) for (var name in vars) value = value.split('{' + name + '}').join(String(vars[name]));
    return value;
  };

  window.UI = {
    lang: lang,
    locale: LOCALES[lang],
    languages: SUPPORTED.map(function (code) { return { code: code, name: NAMES[code] }; }),
    ready: ready,
    /** Appele par les fichiers de langue. */
    add: function (entries) { for (var k in entries) dict[k] = entries[k]; },
    setLang: function (code) {
      if (SUPPORTED.indexOf(code) === -1 || code === lang) return;
      store.set('stremfin_lang', code);
      location.reload();
    },
    theme: function () { return document.documentElement.dataset.theme; },
    toggleTheme: function () {
      var next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
      document.documentElement.dataset.theme = next;
      store.set('stremfin_theme', next);
      return next;
    },
    /** Selecteur de langue (HTML) ; a brancher avec UI.bindLang(select). */
    langSelect: function (id) {
      return '<select id="' + id + '" aria-label="' + window.t('Langue') + '">' + SUPPORTED.map(function (code) {
        return '<option value="' + code + '"' + (code === lang ? ' selected' : '') + '>' + NAMES[code] + '</option>';
      }).join('') + '</select>';
    },
    bindLang: function (select) {
      if (select) select.onchange = function () { window.UI.setLang(select.value); };
    }
  };
})();
