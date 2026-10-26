# Journal des versions

Numérotation [SemVer](https://semver.org/lang/fr/) : `MAJEUR.MINEUR.CORRECTIF`. Chaque version a son
tag `vX.Y.Z` ; l'image Docker est alors publiée avec les étiquettes `X.Y.Z` et `X.Y`.

## 0.2.10-dev.2 — en développement (branche `dev`, image `ghcr.io/guiro28/stremfin:dev`)

### Ajouts
- **Index des catalogues** (*Réglages → Index des catalogues*, désactivé par défaut) : chaque liste
  active des profils est lue en entier en arrière-plan. Une seule règle pour toutes les listes :
  mise à jour rapide du début des listes (3, 5 ou 10 pages, toutes les 1 à 6 h) et relecture
  complète chaque nuit ou chaque semaine ; titres maximum par liste, vitesse de lecture, état,
  « Scanner maintenant » et « Vider l'index ». Rien n'est ajouté au cache général ni aux
  sauvegardes.
- Dans les apps, une liste indexée n'a plus de plafond de 2 000 titres, annonce son total exact,
  et les **tris et filtres des apps** s'appliquent à toute la liste : nom, année, note, date
  d'ajout dans la liste, aléatoire ; genres et années présents dans la liste ; vus / non vus.

- **« Seulement ce qui est sorti » avec l'index** : si un profil utilise l'option, le scan vérifie
  aussi la date de sortie en VOD / DVD / TV de chaque titre (une seule fois ; les titres pas encore
  sortis sont revus chaque jour). Le filtre se lit alors dans l'index : total exact dès la 1re
  page et défilement instantané, même au fond d'une liste de 5 000 titres.

### Changements
- « Masquer les vus » et le filtre vu / pas vu des apps s'appliquent avant le découpage en pages
  (pages pleines, défilement juste).

## 0.2.9 — 2026-10-26

### Ajouts
- **« Continuer de regarder » depuis toutes les sources de suivi** : en plus de Nuvio, les
  lectures en cours sont importées de Scrob (*Continue watching*), de Trakt et de Simkl (lectures
  mises en pause, `/sync/playback`), entre 5 et 90 %. Trakt et Simkl ne donnant qu'un
  pourcentage, la position est calculée d'après la durée du titre (fiche, sinon TMDB). Une
  reprise importée n'écrase jamais une lecture plus récente faite dans Stremfin.

### Changements
- Une reprise importée d'un titre déjà vu (revisionnage) le laisse vu, comme une lecture faite
  dans Stremfin.

## 0.2.8 — 2026-10-26

### Changements
- **Sélecteur de version** : le nom de l'addon qui fournit la release s'affiche juste après la
  qualité (« 4K · StreamFusionReborn · 13,0 Go · release »), en mode « releases » comme pour
  la release lancée en mode « qualités ».

## 0.2.7 — 2026-10-26

### Corrections
- **« À suivre » fonctionne comme Jellyfin** :
  - toutes les séries regardées depuis la limite choisie dans l'app (365 jours par défaut dans le
    client web) sont prises en compte, plus seulement les 500 dernières lignes d'historique ;
  - l'épisode proposé suit l'épisode vu le plus avancé (et non le dernier regardé) : une
    nouvelle saison y apparaît d'elle-même ;
  - une série n'en disparaît plus parce qu'un épisode a été ouvert quelques secondes ;
  - les réglages des apps sont respectés (ancienneté, épisode déjà commencé, revisionnage).
- **Revisionnage** : un épisode déjà vu que l'on revoit reste vu ; arrêté en cours, il va dans
  « Reprendre ». Chaque visionnage complet compte.
- **Vu / pas vu partagé entre les deux versions d'un titre** (catalogue d'un addon en IMDb,
  catalogue TMDB) : progression et « vu » sont recopiés sur l'autre version. Au démarrage, une
  fois, les épisodes importés sous un id TMDB sont rangés sous l'id de la fiche, et les vus
  existants sont recopiés.

### Ajouts
- **Affiches de séries** : coche quand tous les épisodes sortis sont vus, pastille du nombre
  d'épisodes restants pour une série commencée.

## 0.2.6 — 2026-10-26

### Corrections
- **Statistiques sans doublons entre sources de suivi** : un même visionnage importé de plusieurs
  sources (Trakt, Simkl, Scrob, Nuvio) ou lu dans Stremfin puis importé ne compte qu'une fois.
  Un titre a désormais la même identité quelle que soit la source (l'id IMDb ou TMDB manquant est
  retrouvé sur TMDB) ; les revisionnages venant d'une même source restent comptés. Les doublons
  déjà enregistrés sont retirés au démarrage.
- **Scrob** : ses heures (UTC sans fuseau) étaient lues comme des heures locales, avec 1 à 2 h
  de décalage. Elles sont lues en UTC ; les lignes déjà importées sont corrigées une fois
  (réimport pour un profil encore associé, remise à l'heure sinon).

## 0.2.5 — 2026-10-26

### Ajouts
- **Scrob** ([ellite/scrob](https://github.com/ellite/scrob), suivi auto-hébergé) comme source de
  suivi, à côté de Trakt, Simkl et Nuvio. L'adresse du serveur se règle dans *Réglages → Suivi* ;
  chaque profil associe son compte par code, validé sur la page `/link` de Scrob.
  - Import de tout l'historique, chaque visionnage avec sa date : les films et épisodes vus
    plusieurs fois comptent plusieurs fois dans les statistiques.
  - Envoi des lectures en direct (début, pause, reprise, fin) et des titres vus ; « pas vu »
    pour les films.
  - Jeton renouvelé tout seul (un seul renouvellement à la fois).

### Changements
- *Profil → Source de suivi* : les quatre services côte à côte, en cartes compactes.
- Simkl : plus d'emplacement pour un Client ID intégré, chaque serveur renseigne le sien.

### Corrections
- Statistiques : deux visionnages rapprochés (moins de 4 h) d'un même titre venant d'un même
  service ne sont plus fusionnés ; seul un même visionnage vu par deux services l'est.

## 0.2.4 — 2026-10-26

### Changements
- **Simkl en AUTH V2** (OAuth 2.0, code appareil) à la place de l'ancien code PIN (AUTH V1), que
  Simkl prévoit d'arrêter. Il faut une application Simkl de type *TV, devices & command line*
  (Client ID seul, *Réglages → Suivi*). Le jeton de chaque profil (7 jours) est renouvelé tout
  seul, une seule fois même si plusieurs envois arrivent en même temps, et l'autorisation est
  révoquée chez Simkl quand on dissocie le compte.
- Les comptes Simkl associés en V1 ne sont plus pris en charge : il faut les associer de nouveau.

## 0.2.3 — 2026-10-26

### Corrections
- **Mise à jour en direct des apps** : après l'arrêt d'une lecture, « Reprendre » et les
  indicateurs vu / pas vu se mettent à jour dans les apps Jellyfin et Emby et le client web,
  sans relancer l'app ni recharger la page (notification `UserDataChanged`). Vaut aussi pour les
  titres importés de Trakt, Simkl ou Nuvio.
- **Statistiques → Lecture en cours** : sans proxy, le débit et la quantité lue ne restent plus à
  zéro ; ils sont estimés d'après la taille du fichier et la progression (affichés avec « ≈ »).

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
