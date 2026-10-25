# Journal des versions

Numérotation [SemVer](https://semver.org/lang/fr/) : `MAJEUR.MINEUR.CORRECTIF`. Chaque version a son
tag `vX.Y.Z` ; l'image Docker est alors publiée avec les étiquettes `X.Y.Z` et `X.Y`.

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
