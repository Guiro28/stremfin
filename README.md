<p align="center"><img src="public/admin/icon.svg" width="112" alt="Stremfin"></p>

# Stremfin

<p align="center"><a href="https://discordapp.com/invite/ZhWvKVmTuh">Discord</a> · <a href="https://github.com/Guiro28/stremfin">GitHub</a></p>

Un serveur auto-hébergé **compatible Jellyfin** qui sert tes **addons Stremio / Nuvio**.
Tu ajoutes tes addons (catalogues, fiches, sources débridées) dans l'admin. Ensuite,
n'importe quelle application Jellyfin (Android TV, Swiftfin, Findroid, Streamyfin, Infuse,
Jellyfin Media Player, web…) s'y connecte comme à un vrai serveur Jellyfin.

```
App Jellyfin  ──►  Stremfin (API Jellyfin)  ──►  addons Stremio (catalog / meta / stream / subtitles)
                        │
                        └──►  vidéo : selon l'addon, relayée par le serveur (son IP ou WARP), ou lue en direct
```

## Ce que ça fait

| Côté Jellyfin | Côté Stremio |
| --- | --- |
| Bibliothèques (« Films », « Séries ») | Catalogues de tes addons (activables, renommables, ordonnables) |
| Rangées « Derniers ajouts » de l'accueil | Première page de chaque catalogue |
| Fiche film / série, saisons, épisodes | Ressource `meta` (Cinemeta, TMDB…) |
| Choix de version à la lecture | Toutes les sources `stream`, langues préférées en premier |
| Sous-titres externes | Ressource `subtitles` (OpenSubtitles…) |
| Recherche, genres | Catalogues avec `search` / `genre` |
| Reprendre, À suivre, Vu, Favoris, J'aime | Stockés par profil, synchronisés entre tous les appareils |
| Connexion | Nom libre + **code du profil** comme mot de passe, ou **Quick Connect** |

### TMDB intégré (recommandé)

Avec une clé API TMDB (gratuite, sur themoviedb.org → Paramètres → API), renseignée dans
l'admin ou via `TMDB_API_KEY` :

- **Fiches dans ta langue** pour tous les identifiants `tt…` et `tmdb:…`, quel que soit
  l'addon d'origine : titre, résumé, accroche, logo, classification (TP, 12, 16…),
  studios, bande-annonce, casting avec photos, et saisons/épisodes traduits.
- **Traduction en arrière-plan** des éléments venant d'addons en anglais (ex. Cinemeta).
- **Catalogues intégrés** : Tendances, Populaires, Les mieux notés, Au cinéma / En cours
  de diffusion, filtrables par genre.
- **Sagas** : collections TMDB (Marvel, Dune, Le Seigneur des anneaux…) déduites des films
  populaires, chacune ouverte comme un dossier avec les films dans l'ordre.
- **Similaires** sur chaque fiche.

Les addons de sources reçoivent automatiquement l'identifiant qu'ils comprennent (IMDb
`tt…` en priorité, sinon `tmdb:…`).

Option du profil **« Masquer ce qui n'est pas encore sorti en VOD, DVD ou à la TV »** :
un film n'apparaît que si TMDB connaît une sortie numérique, physique ou TV déjà passée
(ou, à défaut, une sortie en salle de plus de 6 mois) ; une série, que si sa diffusion a
commencé. S'applique aux bibliothèques, à la recherche, aux sagas et aux Similaires.

### Qualité : 4K, 1080p, 720p

Chaque film et épisode propose trois **versions** dans l'app (sélecteur « Version ») :
4K, 1080p et 720p. Chacune lance la meilleure source de cette qualité, ou à défaut la plus
proche disponible (4K → 1080p → 720p ; 1080p → 720p → 4K ; 720p → 1080p → SD). Les
langues préférées du profil passent avant la qualité : une VF en 1080p est préférée à
une VO en 4K. La qualité lancée par défaut se règle par profil dans l'admin.

Option par profil (*Préférences → Versions proposées*) : au lieu des 3 qualités, la fiche
peut lister les **5 meilleures releases de chaque qualité** trouvées par les addons (jusqu'à
15 versions, qualité par défaut en tête). Si les addons ne répondent pas dans les 8 s,
la fiche affiche les 3 qualités ; les réponses restent en cache pour la prochaine ouverture.

Quand aucun addon ne fournit la vidéo, le sélecteur de version affiche « 😕 Aucune source
disponible » et « 🔄 Réessaie un peu plus tard » (dans la langue des libellés du serveur) au
lieu des qualités ou des releases. Une recherche de sources sert à la fiche et à la lecture
pendant 2 min (20 s si elle n'a rien trouvé) ; activer ou couper un addon la relance.

Appuyer sur Lecture dans ce cas lance un **clip « aucune source disponible »** au lieu d'une
erreur (*Réglages → Lecture et réseau*, activable). Un clip de 10 s est fourni ; on peut envoyer
sa propre vidéo (MP4, WebM ou MKV, 50 Mo max.) ou en **créer une depuis une image** : le
navigateur fabrique la vidéo (image, message, durée) et l'envoie au serveur, sans ffmpeg. Ce
clip ne compte jamais comme une lecture (statistiques, suivi Trakt / Simkl, titres vus).

### Pistes audio et sous-titres

Au lancement, Stremfin lit l'en-tête du fichier (MKV, quelques centaines de Ko, sans le
télécharger) pour annoncer aux apps **toutes ses pistes** : audios (VF, VO, commentaires…) et
**sous-titres intégrés** (SRT, ASS, PGS), avec leur langue et leur nom. L'audio par défaut
suit les langues préférées du profil ; des sous-titres « forcés » dans cette langue sont
activés d'office. Les sous-titres des addons de sous-titres (ex. OpenSubtitles) s'ajoutent à la
liste, langues du profil d'abord. Résultat gardé 24 h par fichier ; un lien de débrideur pas
encore prêt est réessayé.

**Préférences de lecture** (par profil, onglet *Préférences*, ou dans les paramètres des apps
Jellyfin et Emby, qui les enregistrent sur le serveur) : langue de la piste audio, langue des
sous-titres et sous-titres au lancement : *Par défaut* (pistes forcées ou marquées par défaut),
*Intelligent* (sous-titres complets si l'audio est dans une autre langue), *Toujours*,
*Seulement les forcés* ou *Aucun*.

### Passer l'intro et le générique

Les timestamps viennent de [TheIntroDB](https://theintrodb.org) (base communautaire,
sans clé) et sont exposés comme *media segments* Jellyfin : les apps compatibles (web,
Android TV récentes…) affichent « Passer le générique » et, à la fin d'un épisode,
« Épisode suivant ». Désactivable dans les réglages du serveur.

Pour aller vite, tout est mis en cache (SQLite + mémoire) : un écran déjà vu s'affiche sans
attendre les addons, et les sources sont cherchées **dès l'ouverture de la fiche**. Quand
on appuie sur Lecture, elles sont déjà là.

**Torrents** : les apps Jellyfin ne lisent que du HTTP. Les sources débridées (Torbox,
Real-Debrid… via Torrentio, Comet, MediaFusion, Lumio…) marchent directement. Pour les
torrents bruts, ajoute un serveur de streaming Stremio (`TORRENT_SERVER`, voir le compose).

## Lancer en local

```bash
npm install
npm start
```

- API Jellyfin : `http://localhost:8096` (port par défaut de Jellyfin)
- Connexion Stremfin (admin et utilisateurs) : `http://localhost:8096/`
- Client web Jellyfin : `http://localhost:8096/web`
- Quick Connect : `http://localhost:8096/pin`

Au premier lancement, ouvre la racine du serveur dans un navigateur : l'interface demande
de créer le compte administrateur. Un profil « Moi » est créé avec Cinemeta.

## Déployer (Docker + WARP)

Le [`docker-compose.yml`](docker-compose.yml) démarre Stremfin **et** un conteneur
Cloudflare WARP ([caomingjun/warp](https://github.com/cmj2002/warp-docker)) exposant un
SOCKS5 (le « proxy externe »). Stremfin y fait passer TMDB, les catalogues et les addons en mode
« Proxy externe » dès le premier démarrage (`UPSTREAM_MODE=socks`, `UPSTREAM_URL=socks5://warp:1080`).

```bash
mkdir stremfin && cd stremfin
curl -fsSLO https://raw.githubusercontent.com/Guiro28/stremfin/main/docker-compose.yml
docker compose up -d
```

Puis ouvre `http://IP-du-serveur:8096/` : l'interface demande de créer le compte
administrateur. Tout le reste (clé TMDB, profils, addons, sortie réseau…) se règle dans
l'interface.

- **Image** : `ghcr.io/guiro28/stremfin:latest` (amd64 et arm64), construite par GitHub
  Actions à chaque envoi sur `main`. Pour la construire toi-même, remplace `image:` par
  `build: .` dans le compose.
- **Données** : profils, progression et cache dans `./data` ; identité WARP dans
  `./warp-data`.
- **WARP** : l'hôte doit fournir `/dev/net/tun` (c'est le cas sur la plupart des VPS). Les
  variables `UPSTREAM_*` ne servent qu'au 1er démarrage ; ensuite la sortie réseau se
  change dans *Réglages → Lecture et réseau* (Direct, SOCKS5 ou HTTP). Pour vérifier que
  WARP fonctionne :
  ```bash
  docker exec stremfin-warp curl -s --socks5 localhost:1080 https://cloudflare.com/cdn-cgi/trace | grep warp
  ```
  (doit afficher `warp=on`). Sans WARP, supprime le service `warp`, le `depends_on` et les
  deux variables `UPSTREAM_*`.

L'image embarque le client web officiel de Jellyfin (servi sur `/web`), dont ont besoin
l'app Android « Jellyfin » et Jellyfin Media Player.

Derrière un reverse-proxy HTTPS (recommandé hors du réseau local), renseigne l'**URL
publique** dans l'admin. Exemple Caddy :

```
jelly.mondomaine.com {
    reverse_proxy localhost:8096
}
```

## Interface Stremfin (racine du serveur)

Tout se règle depuis l'interface web, rien n'est à modifier à la main sur le serveur.
L'interface (thème Aurora, sombre ou clair) existe en **français, anglais, espagnol,
allemand et italien** : la langue suit le navigateur et se change en bas de la barre
latérale. Les traductions sont dans `public/admin/i18n/` (le texte français sert de clé).
Une seule page de connexion, à la racine (`https://jelly.mondomaine.com/`) : le compte
administrateur ouvre l'administration, un compte de profil ouvre son espace. Les apps qui
affichent le client web (Jellyfin Media Player, app Android pour téléphone) ouvrent aussi
la racine : elles sont reconnues et envoyées directement sur `/web`.

- **Comptes** : un compte administrateur (créé au premier lancement) et un compte par
  profil (nom d'utilisateur + mot de passe définis par l'admin). Un utilisateur ne
  gère que **son** profil : mot de passe (l'actuel est exigé), avatar,
  préférences, accueil, addons, bibliothèques, appareils, Quick Connect.
- **Sécurité** : mots de passe hachés (scrypt), sessions par cookie `HttpOnly` /
  `SameSite=Strict`, protection CSRF, blocage de 15 min après 10 échecs.
- **Profils** (un onglet par sujet) : *Connexion*, *Préférences* (langues, qualité,
  versions proposées, vus masqués, seulement ce qui est sorti, CSS du client web), *Accueil*, *Addons* (choix dans la bibliothèque,
  activation, ordre, catalogues affichés ou masqués, copie depuis un autre profil ; le mode de
  connexion se règle seulement sur la page *Addons*), *Bibliothèques* (activation,
  renommage, ordre), *Appareils*.
- **Addons** : bibliothèque d'addons du serveur, reprise de Nuvio Manager. Chaque addon est
  ajouté une fois (URL du manifest, nom facultatif), avec les profils qui l'utilisent ; on
  l'attribue à un ou plusieurs profils, ou plusieurs addons d'un coup à un profil (dans l'ordre
  choisi par glisser-déposer). Changer son nom ou son URL met à jour tous les profils ; le
  retirer l'enlève aussi des profils. Un addon ajouté depuis l'onglet d'un profil rejoint la
  bibliothèque. **Mode de connexion**, profil par profil (fenêtre ouverte depuis les avatars) :
  - *Sans proxy* : l'app lit la vidéo directement à la source (redirection) ;
  - *Proxy interne* : la vidéo passe par le serveur, avec son IP ;
  - *Proxy externe* : l'addon et la vidéo passent par le proxy externe (*Réglages → Lecture et
    réseau*, ex. WARP).

  Les sources qui exigent des en-têtes et les torrents (serveur de streaming) passent toujours
  par le serveur. Le mode proposé pour un nouvel addon se règle dans *Lecture et réseau*.
- **Avatar d'un profil** : un clic sur l'avatar ouvre la galerie des avatars Xperience (par
  catégorie, avec recherche, comme dans Nuvio Manager) ; l'avatar choisi est téléchargé par le
  serveur et envoyé aux apps. On peut aussi envoyer sa propre image (3 Mo max.).
- **Collections** : bibliothèque de collections Nuvio partagée par le serveur (voir plus bas).
- **Réglages** : serveur, lecture et réseau, métadonnées (TMDB, identifiant d'app Trakt),
  client web.
- **Maintenance** : vider le cache, recharger les addons, réindexer TMDB.
- **Sauvegardes** : une archive `.tar.gz` par jour dans `data/backups` (base de données sans
  le cache, réglages, avatars, images des tuiles), à l'heure choisie, gardée 7 jours par
  défaut. On peut aussi sauvegarder à la demande, télécharger, envoyer une archive et
  restaurer : les données actuelles sont mises de côté dans `data/backups`, puis le serveur
  redémarre (sous Docker, `restart: unless-stopped` le relance tout seul ; en local, relance
  `npm start`).

**Thème du client web** (*Réglages → Client web*) : le client web Jellyfin servi par Stremfin
utilise par défaut le thème [Abyss](https://github.com/AumGupta/abyss-jellyfin) (MIT), avec
sa bannière Spotlight en haut de l'accueil. Fichiers et polices sont servis par Stremfin
(`vendor/abyss`), sans appel à Google Fonts, jsDelivr ni GitHub. On peut revenir au thème
d'origine de Jellyfin ou couper Spotlight.

Autre choix : [ElegantFin](https://github.com/lscambo13/ElegantFin) de lscambo13 (GPL-2.0),
thème sombre élégant inspiré de Jellyseerr. Fichier et polices servis par Stremfin
(`vendor/elegantfin`, licence et crédits dans le dossier), sans appel externe. Spotlight reste
propre à Abyss.

Par défaut, Spotlight présente les **films tendance du jour sur TMDB**, même absents des
bibliothèques : logo, image, année, note et résumé. Le bouton « i » ouvre la fiche Stremfin
du film, lisible via les addons. L'autre choix (*Réglages → Client web*), « Mes reprises »,
garde le contenu d'origine d'Abyss.

**CSS par profil** : le client web Jellyfin servi par Stremfin (`/web`, aussi utilisé par
Jellyfin Media Player et l'app Android pour téléphone) applique le CSS du profil connecté.
Il suit les connexions et changements de profil ; une modification s'applique au prochain
chargement de la page ou au retour sur l'onglet. Les apps natives n'utilisent pas de CSS.

## Mes médias, collections et accueil

- **Mes médias** : Films, Séries TV, Films d'animation, Séries d'animation (et en option
  Animés, Documentaires, Séries documentaires, Jeunesse), triables dans l'app par nom,
  date ou note. Leur rangée « ajouts récents » montre les dernières sorties.
- **Collections** (page *Collections*) : un fichier `.json` de collections au format
  Nuvio / Xperience (envoyé, ou lu à une adresse) et l'adresse des addons qu'il utilise (ses
  sources ne donnent souvent que l'id de l'addon). On coche les collections du fichier à
  ajouter à la bibliothèque du serveur, puis les profils Stremfin qui les voient, comme pour
  des addons. Les adresses d'addons (qui peuvent contenir un jeton) restent dans
  `data/config.json` et ne sont jamais réaffichées en entier. Dans les apps :
  - chaque collection devient une **bibliothèque** (image de fond de la collection ;
    une collection épinglée passe en tête tant que le profil ne l'a pas placée) ;
  - ses dossiers deviennent des **sous-dossiers** (couverture, fond et logo de la collection) ;
  - GIF animé d'un dossier (`focusGifUrl`, sauf `focusGifEnabled: false`) : en fond dans toutes les
    apps, et en icône dans les apps Jellyfin ; les apps Emby, qui n'affichent pas les GIF, gardent
    la couverture (`coverImageUrl`) en icône. Une image choisie qui est un GIF suit la même règle ;
  - dans un dossier, **un sous-dossier par source** (« Disney+ · Films », « Disney+ · Séries »…) ;
    un dossier qui n'a qu'une source montre directement ses titres. Sources prises en charge :
    catalogues d'addons (même absents du profil),
    découvertes TMDB (tri, genres, année) et listes Trakt (avec un identifiant d'app Trakt,
    *Réglages → Suivi*).
  - images modifiables depuis la page *Collections* (fichier ou adresse) : tuile de la
    collection dans « Mes médias », dossiers et sous-dossiers ; un profil peut toujours
    choisir sa propre image de tuile (onglet *Accueil*).

  Un `.json` donné par adresse est relu toutes les 6 h (ou avec *Mettre à jour*) ; une
  collection qui n'y est plus reste, signalée. Pour un fichier, il suffit de le renvoyer : les
  collections déjà présentes (même id) sont mises à jour, avec leurs profils et leurs images.
  Ordre, nom et activation se règlent dans l'onglet *Bibliothèques* de chaque profil.
- **Accueil** (onglet du profil) : ordre des sections (Mes médias, Continuer à regarder,
  rangées des bibliothèques, À suivre) et bibliothèques avec ou sans rangée. Les rangées
  suivent l'ordre des bibliothèques : mets une collection en tête pour l'avoir juste sous
  « Continuer à regarder ».
- **Ouverture rapide** : les bibliothèques et les dossiers des collections sont préparés en
  arrière-plan (300 premiers titres, une minute après le démarrage puis toutes les 2 h) et
  s'ouvrent en quelques dizaines de millisecondes. Les pages se chargent par lots en
  parallèle et la suite d'une grille se prépare pendant qu'on la parcourt.
- **Tri dans les apps Emby** : elles demandent toujours un tri par nom ; par défaut,
  Stremfin garde l'ordre du catalogue (populaires, tendances…), réglable dans
  *Réglages → Serveur*. Les autres tris choisis dans l'app (date, note) sont respectés.

## Suivi : Trakt, Simkl, Scrob et historique Nuvio

Onglet **Source de suivi** de chaque profil (aussi dans l'espace de l'utilisateur), une carte par
service avec son logo, comme dans Nuvio Manager :

- **Trakt** et **Simkl** : association par code, à saisir sur trakt.tv / simkl.com. Il faut
  d'abord une application de chaque service, créée une fois par l'administrateur
  (*Réglages → Suivi*) :
  - Trakt : adresse de redirection `urn:ietf:wg:oauth:2.0:oob`, Client ID et Client Secret ;
  - Simkl : application **AUTH V2** (OAuth 2.0) de type *TV, devices & command line*, Client ID
    seul. Le jeton de chaque profil (7 jours) est renouvelé tout seul, et l'autorisation est
    révoquée chez Simkl quand on dissocie le compte.
  - *Importer* : l'historique (tout la première fois, puis ce qui est nouveau, toutes les 6 h
    ou avec *Importer maintenant*) marque les titres vus.
  - *Envoyer* : la lecture en cours part vers Trakt (début, pause, fin ; Trakt marque vu
    au-delà de 80 %), les titres vus / « pas vus » vers Trakt et Simkl. Ce qui vient d'un
    import n'est jamais renvoyé.
- **Scrob** ([ellite/scrob](https://github.com/ellite/scrob), suivi auto-hébergé) : l'adresse du
  serveur se règle dans *Réglages → Suivi*, puis chaque profil associe son compte par code, à
  valider sur la page `/link` du serveur Scrob (comme son extension Kodi). Scrob garde chaque
  visionnage avec sa date : l'import reprend aussi les films et épisodes vus plusieurs fois.
  L'envoi passe les lectures en direct (début, pause, reprise, fin ; Scrob marque vu à 90 %) et
  les titres vus ; un « pas vu » n'est envoyé que pour les films. Pour retirer l'accès côté
  Scrob, supprime l'appareil dans *Connections → Connected Apps*. Si Scrob envoie lui-même vers
  Trakt ou Simkl, coupe l'envoi direct de Stremfin vers ces services pour éviter les doublons.
  - L'interface web de Scrob ne relaie, pour un appareil, que les routes de son extension Kodi
    (lectures en direct). Stremfin ajoute un en-tête `X-Api-Key` pour atteindre aussi
    l'historique et les « vu / pas vu » ; c'est le serveur Scrob qui vérifie le jeton. Si une
    version de Scrob refusait un jour cet en-tête, l'import l'indiquerait ; les lectures en
    direct continueraient.
- **Nuvio** : chaque profil associe **son propre compte Nuvio** (code, comme une TV, en
  lecture seule) et choisit le profil Nuvio dont il récupère l'historique : titres vus et
  lectures en cours (reprises entre 5 et 90 %).

Un titre vu ailleurs n'écrase jamais une lecture plus récente ici. Un même titre peut exister
en version IMDb (addons) et TMDB (catalogues TMDB) : les deux sont marqués, et il n'apparaît
qu'une fois dans « Reprendre » et « À suivre ». Les jetons restent dans `data/config.json`.

## Statistiques

Page **Statistiques** (reprise de celle de Nuvio Manager), pour l'administrateur (tous les
profils, ou ceux choisis) et pour chaque utilisateur (son profil) :

- **En ce moment** : lectures en cours (profil, titre, app et appareil, release, progression).
- Chiffres de la période (30 / 90 jours, 1 an, tout, ou un nombre de jours) : lectures,
  titres uniques, temps suivi.
- **Activité quotidienne** (films / séries) : un clic sur un jour ouvre ce qui a été regardé,
  par profil.
- Classements : séries et films les plus regardés et les plus populaires, apps et services,
  profils les plus actifs ; fiches détaillées (TMDB) et derniers visionnages.

Sources : les lectures faites dans les apps (début, fin, temps réellement regardé, release,
app et appareil) et les historiques importés (Trakt, Simkl, Nuvio). Une même lecture envoyée
à Trakt puis réimportée n'est comptée qu'une fois.

## Se connecter depuis une app Jellyfin

1. Adresse du serveur (affichée dans l'admin).
2. Nom d'utilisateur + mot de passe du profil.
3. Ou **Quick Connect** : l'app affiche un code à 6 chiffres, à saisir sur
   `https://ton-domaine/pin` (connexion avec ses identifiants Stremfin) ou dans l'admin.

Sur le réseau local, les apps trouvent aussi le serveur toutes seules (découverte UDP 7359).

## Variables d'environnement

Elles ne servent qu'au **premier démarrage** (valeurs initiales) ; ensuite tout se modifie
dans l'admin. Seuls `PORT` et `DATA_DIR` restent des réglages de déploiement.

| Variable | Rôle |
| --- | --- |
| `PORT` | Port HTTP (défaut 8096) |
| `DATA_DIR` | Dossier des données (défaut `./data`) |
| `AUTH_USER` / `AUTH_PASS` | Compte admin initial (sinon créé depuis l'interface au premier accès) |
| `UPSTREAM_MODE` / `UPSTREAM_URL` | Proxy externe initial : `direct` (aucun), `socks` (WARP) ou `http` |
| `TORRENT_SERVER` | URL d'un serveur de streaming Stremio pour les torrents |
| `SERVER_NAME` | Nom affiché dans les apps (modifiable dans l'admin) |
| `TMDB_API_KEY` | Clé API TMDB v3 (modifiable dans l'admin) |
| `WEB_DIR` | Dossier du client web Jellyfin (fourni dans l'image Docker) |
| `LOG_REQUESTS` | `1` : journal de chaque requête (méthode, adresse, statut, durée, app), jetons masqués. Pour diagnostiquer une app |

## Limites actuelles

- Pas de transcodage : l'app lit le fichier tel quel. Les apps natives (Android TV,
  Swiftfin, Infuse, Findroid) lisent presque tout. Le client web dépend du navigateur
  (MKV/HEVC souvent refusés).
- Les infos techniques (résolution, codecs, HDR) sont déduites du nom de la source.
- Saut d'intro : seulement pour les épisodes et films présents dans TheIntroDB.
- Les sagas se limitent à celles des films populaires et les mieux notés du moment.
