# Abyss (thème du client web)

Copie de [AumGupta/abyss-jellyfin](https://github.com/AumGupta/abyss-jellyfin), licence MIT
(voir `LICENSE`), commit `2f809171ed` du 5 octobre 2026.

Fichiers d'origine, non modifiés : `abyss.css`, `spotlight.html`, `spotlight.css`,
`spotlight-loader.js`. Au moment de les servir, `src/webTheme.js` :

- remplace Google Fonts et jsDelivr par les copies locales de `fonts/` ;
- coupe la vérification de nouvelle version sur GitHub (Spotlight) ;
- traduit en français les libellés de Spotlight.

Polices (`fonts/`) :

- Google Sans, SIL Open Font License 1.1, depuis Google Fonts (alphabets latin, latin
  étendu, cyrillique, grec, vietnamien et symboles) ;
- Material Icons Round 1.13.12, licence Apache 2.0, depuis le paquet npm `material-icons`.

Pour mettre à jour le thème : remplacer les quatre fichiers, puis vérifier au démarrage que
le serveur n'affiche aucun message `[theme] … passage introuvable`.
