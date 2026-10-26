# ElegantFin (thème du client web)

Copie de [lscambo13/ElegantFin](https://github.com/lscambo13/ElegantFin), thème Jellyfin créé par
**lscambo13**, licence GNU GPL v2 (voir `LICENSE`). Fichier
`Theme/ElegantFin-jellyfin-theme-build-latest-minified.css` (version v26.09.05, commit
`9d43fa9b89` du 9 septembre 2026), celui que recommande son auteur.

Fichier d'origine, non modifié : `elegantfin.css`. Au moment de le servir, `src/elegantfin.js`
remplace Google Fonts par les copies locales de `fonts/`.

Polices (`fonts/`) :

- Inter, SIL Open Font License 1.1, depuis Google Fonts (alphabets latin, latin étendu,
  cyrillique, grec et vietnamien, droit et italique) ;
- Material Symbols Rounded, licence Apache 2.0, depuis Google Fonts (version réduite utilisée
  par le thème et version complète).

Pour mettre à jour le thème : remplacer `elegantfin.css`, puis vérifier au démarrage que le
serveur n'affiche aucun message `[theme] elegantfin.css : …`.
