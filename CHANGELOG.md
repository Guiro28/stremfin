# Journal des versions

Numérotation [SemVer](https://semver.org/lang/fr/) : `MAJEUR.MINEUR.CORRECTIF`. Chaque version a son
tag `vX.Y.Z` ; l'image Docker est alors publiée avec les étiquettes `X.Y.Z` et `X.Y`.

## 0.2.10-dev.6 — en développement (branche `dev`, image `ghcr.io/guiro28/stremfin:dev`)

### Ajouts
- **TV en direct (IPTV)** : comptes Xtream Codes et listes M3U, ajoutés par l'admin (attribués
  aux profils) ou par chaque utilisateur (sources privées). Vue « TV en direct » et chaînes dans
  les apps Jellyfin ; une seule connexion par chaîne chez le fournisseur, partagée entre les apps ;
  limite de connexions des comptes Xtream respectée ; client web en HLS (liste du fournisseur
  relayée ou FFmpeg).
- **Gestion des groupes et des chaînes** : renommer, réordonner, activer ou masquer, logo,
  numéro, groupe, actions en lot ; gardée à chaque mise à jour de la liste. Groupes en trois
  onglets (Chaînes TV, Films, Séries) à l'ajout de la source et sur sa page : une catégorie de
  films ou de séries désactivée disparaît de la bibliothèque et de la recherche de secours.
- **Guide des programmes** (XMLTV) : guide du fournisseur et guides ajoutés, association
  automatique et à la main, programme en cours, grille du guide et « En ce moment ».
- **Replay** des chaînes à archive (Xtream timeshift, M3U catchup).
- **Films et séries IPTV** : bibliothèques par source, et recherche de secours dans la VOD quand
  les addons ne trouvent aucune source.
- **Enregistrements** depuis le guide des apps (émission ou série), page « Enregistrements ».

### Changements
- Une version de qualité inconnue s'appelle « Auto » au lieu de « 4K → ? ».
- Conversion HLS : le son n'est recopié que dans un codec que les navigateurs lisent (AAC, MP3,
  AC3, E-AC3, Opus, FLAC) ; le MP2 des chaînes IPTV est converti en AAC (lecture impossible dans
  le navigateur sinon).
- Films et épisodes IPTV : pistes et conteneur réels lus par ffprobe (gardés 7 jours), pour que
  le client web les convertisse quand il le faut ; une seule version « IPTV » au lieu de
  4K / 1080p / 720p ; un titre d'une bibliothèque IPTV reste lu par sa source IPTV, même quand sa
  fiche vient de TMDB.
- Films et séries IPTV sans id TMDB dans la liste du fournisseur (cas fréquent) : id cherché dans
  TMDB par nom nettoyé (« |FR| After Life 2019 FHD MULTI » → « After Life ») et année, en
  arrière-plan, puis à l'ouverture d'une fiche (fiche du fournisseur d'abord pour un film Xtream).
  Les ids trouvés restent d'une mise à jour à l'autre. Le fournisseur n'est jamais sollicité en
  rafale : la recherche passe par TMDB, ses fiches (`get_vod_info`, `get_series_info`) sont
  demandées une à la fois, 3 s d'écart au moins, et les épisodes des séries IPTV ne sont plus
  comptés depuis les listes.

## 0.2.10-dev.5

### Ajouts
- **Catalogues gardés en base** : le préchauffage charge chaque catalogue (bibliothèques, dossiers des
  collections) jusqu'au nombre de titres réglé et le garde en base ; les titres affichés plus loin ou
  trouvés par une recherche s'y ajoutent (10 000 par liste au plus). Après un redémarrage, les
  bibliothèques s'ouvrent tout de suite ; une liste de plus d'une heure est relue en arrière-plan sur
  la même longueur, et reste telle quelle si l'addon ne répond pas. Réglages › Métadonnées › « Titres
  gardés par catalogue » (1000 par défaut, de 100 à 10 000).
- **Recherches gardées** : une recherche déjà faite (addons et TMDB) est servie depuis la base et mise
  à jour en arrière-plan.

### Changements
- **Badge des épisodes restants refait** (sur le modèle de Polyfin) : épisodes sortis moins épisodes
  vus, sur toutes les séries, même pas commencées, et sur chaque saison. Le nombre d'épisodes sortis
  est gardé par série (sans enregistrer tous les épisodes) et recalculé chaque jour ; une réponse
  attend jusqu'à 1,5 s les séries jamais comptées. Marquer un épisode vu met à jour l'épisode, la
  saison et la série dans l'app, y compris pour l'autre version d'un titre.
- **La base n'est plus jamais nettoyée** : fiches, listes et réponses en cache sont toutes gardées
  (le ménage automatique du cache est retiré). Les nouvelles réponses TMDB des saisons ne gardent que
  ce que Stremfin utilise (numéro, nom, résumé, image, date, durée).

## 0.2.10-dev.4

### Ajouts
- **Conversion vidéo pour le client web** (sur le modèle de Polyfin) : l'app envoie ce qu'elle lit
  (profil de lecture) ; une version qu'elle ne lit pas telle quelle est diffusée en HLS avec FFmpeg,
  en ne convertissant que le nécessaire (le son en AAC, l'image en H.264 en 1080p au plus, couleurs
  corrigées pour le HDR). Une avance rapide relance FFmpeg à l'endroit demandé ; FFmpeg lit la
  source par les mêmes routes que les apps (WARP, proxy) et à deux fois la vitesse de la vidéo au plus.
  Les apps qui n'envoient pas de profil (apps TV) lisent tout en direct, comme avant.
- **Encodeur détecté automatiquement** et vérifié par un essai : NVIDIA (NVENC), Intel (QuickSync,
  VA-API), AMD (VA-API, AMF), Apple (VideoToolbox), sinon le processeur. Réglages › Lecture et réseau
  › Conversion vidéo : mode (son et image, son seulement, désactivée), encodeur, conversions
  simultanées, débit maximal, chemin de FFmpeg.
- **Release compatible d'abord** : à qualité égale, une release que l'app lit telle quelle passe devant.
- **Images des bibliothèques générées** (style Polyfin) : mur de jaquettes de la bibliothèque, dégradé
  sombre et nom en gras blanc, sans jaquette répétée quand il y en a assez. Automatique pour les
  bibliothèques, collections, dossiers et sous-dossiers sans image ; bouton « Générer l'image » dans
  l'admin. Les dossiers en affiche reçoivent une image 2:3.
- **Réglages du client web Jellyfin** pris en compte : changer son mot de passe (les autres appareils
  sont déconnectés) et son avatar, ordre et bibliothèques de « Mes médias », rangées « ajouts
  récents » et titres vus masqués, lecture automatique de l'épisode suivant, épisodes à venir
  affichés grisés. Les mêmes réglages apparaissent dans l'admin (onglets Préférences et Accueil).

### Changements
- **Suivi** : Trakt, Simkl et Scrob reçoivent la lecture en direct, et l'arrêt dès que le titre est
  vu (90 %) ; un double envoi à Simkl (409) n'est plus une erreur. Statistiques : une lecture signalée
  seulement à l'arrêt (lecteur externe) compte, et un long trou entre deux rapports compte si la
  position a avancé d'autant.
- **Docker** : l'image inclut FFmpeg, les pilotes Intel et AMD et la police des images ; le conteneur
  rejoint seul le groupe de la carte graphique donnée (/dev/dri). Exemples NVIDIA, Intel et AMD dans
  `docker-compose.yml`.

## 0.2.10-dev.3

### Changements
- **Index des catalogues retiré** (essayé en 0.2.10-dev.1 et 0.2.10-dev.2) : les catalogues sont de
  nouveau lus à la demande, comme en 0.2.9. Au démarrage, les tables et réglages qu'il avait créés
  sont supprimés.

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
