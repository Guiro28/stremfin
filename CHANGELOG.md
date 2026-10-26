# Journal des versions

Numérotation [SemVer](https://semver.org/lang/fr/) : `MAJEUR.MINEUR.CORRECTIF`. Chaque version a son
tag `vX.Y.Z` ; l'image Docker est alors publiée avec les étiquettes `X.Y.Z` et `X.Y`.

## 0.2.2 — 2026-10-26

Regroupe les versions publiées un temps sous les numéros 0.3.0, 0.4.0 et 0.4.1 (retirées).

### Ajouts
- **Pistes audio et sous-titres intégrés** : Stremfin lit l'en-tête des fichiers MKV (sans les
  télécharger) et annonce aux apps toutes leurs pistes audio (VF, VO, commentaires…) et leurs
  sous-titres intégrés (SRT, ASS, PGS), avec langue et nom. Un lien de débrideur pas encore
  prêt est réessayé.
- **Préférences de lecture** par profil : langue audio, langue des sous-titres et sous-titres au
  lancement (Par défaut, Intelligent, Toujours, Seulement les forcés, Aucun). Réglables dans
  l'onglet *Préférences* et dans les paramètres des apps Jellyfin et Emby, qui les enregistrent
  sur le serveur ; la liste des langues leur est fournie.
- **Aucune source** : le sélecteur de version affiche « 😕 Aucune source disponible », et la
  lecture lance un court clip au lieu d'une erreur (activable dans *Réglages → Lecture et
  réseau*). Un clip de 10 s est fourni ; on peut envoyer sa propre vidéo (MP4, WebM, MKV) ou en
  créer une depuis une image, dans le navigateur. Le clip ne compte jamais comme une lecture.
- **Thème ElegantFin** (lscambo13, GPL-2.0) pour le client web, au choix avec Abyss : fichier et
  polices servis par Stremfin (`vendor/elegantfin`), sans appel externe.
- **Icône de Stremfin** (les flux des addons arrivent dans le bouton lecture) : logo de
  l'interface et de Quick Connect, favicon, icônes d'écran d'accueil, README.

### Changements
- **Disposition reprise de Nuvio Manager** : barre du haut avec fil d'Ariane, menu des langues
  (drapeaux), bouton mode clair / sombre et déconnexion ; en bas de la barre latérale, liens
  Discord et GitHub et numéro de version (lien vers le commit, fourni par la CI dans l'image
  Docker).
- Le mode de connexion des addons (proxy) ne se règle plus que sur la page *Addons*, plus depuis
  la page d'un profil.
- *Réglages → Client web* : les réglages de Spotlight n'apparaissent qu'avec le thème Abyss.
- Sous-titres des addons (OpenSubtitles…) : langues du profil en premier, noms de langue lisibles.
- Une seule recherche de sources pour la fiche, son préchargement et la lecture ; activer ou
  couper un addon la relance.

## 0.2.1 — 2026-10-26

### Changements
- **Collections** : le GIF animé d'un dossier (`focusGifUrl`) sert de fond dans toutes les apps et
  d'icône dans les apps Jellyfin. Les apps Emby, qui n'affichent pas les GIF, gardent la
  couverture (`coverImageUrl`) en icône. Une image choisie qui est un GIF suit la même règle.

## 0.2.0 — 2026-10-25

### Ajouts
- **Interface** : thème Aurora (clair et sombre) et 5 langues (français, anglais, espagnol,
  allemand, italien).
- **Sauvegardes** : archive quotidienne (base, réglages, avatars, images), téléchargement,
  envoi et restauration.
- **Collections** : collections Nuvio / Xperience depuis un fichier `.json` et les addons
  qu'elles utilisent, une bibliothèque par collection dans les apps (remplacent les
  « Plateformes »).
- **Suivi** : Trakt et Simkl dans les deux sens, historique d'un profil Nuvio en lecture seule.
- **Statistiques** : page reprise de Nuvio Manager, avec le panneau « Lecture en cours » et les
  addons les plus actifs.
- **Bibliothèque d'addons** : addons ajoutés une fois au serveur puis attribués aux profils, avec
  un mode de connexion par profil (sans proxy, proxy interne, proxy externe).
- **Tableau de bord** : statut des proxys interne et externe.
- **Profils** : avatars Xperience (galerie par catégorie) ou image envoyée ; onglet « Source de
  suivi » avec les logos des services.

### Changements
- Réglages → Lecture et réseau : « Mode de connexion par défaut » remplace « Lecture des
  vidéos » ; les addons existants sont migrés vers la bibliothèque.
- Réglages → Suivi : Trakt et Simkl séparés.

## 0.1.0

Première version : serveur compatible Jellyfin / Emby au-dessus des addons Stremio.
