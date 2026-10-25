# Stremfin

Un serveur auto-hébergé **compatible Jellyfin** qui sert tes **addons Stremio / Nuvio**.
Tu ajoutes tes addons (catalogues, fiches, sources débridées) dans l'admin. Ensuite,
n'importe quelle application Jellyfin (Android TV, Swiftfin, Findroid, Streamyfin, Infuse,
Jellyfin Media Player, web…) s'y connecte comme à un vrai serveur Jellyfin.

```
App Jellyfin  ──►  Stremfin (API Jellyfin)  ──►  addons Stremio (catalog / meta / stream / subtitles)
                        │
                        └──►  vidéo : relayée par le serveur (IP serveur ou WARP), ou lue en direct
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
- **Plateformes** : Netflix, Prime Video, Disney+, Apple TV+, Canal+, HBO Max, Paramount+,
  Crunchyroll, ADN, Arte, M6+, TF1+, MUBI, Hayu (désactivées par défaut, à cocher dans l'admin).
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
SOCKS5. Stremfin y fait passer les addons, TMDB et les vidéos (mode « via le serveur ») dès
le premier démarrage (`UPSTREAM_MODE=socks`, `UPSTREAM_URL=socks5://warp:1080`).

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
  versions proposées, vus masqués, seulement ce qui est sorti, CSS du client web), *Accueil*, *Addons* (activation, ordre, catalogues
  affichés ou masqués, copie depuis un autre profil), *Bibliothèques* (activation,
  renommage, ordre), *Appareils*.
- **Réglages** : serveur, lecture et réseau, métadonnées, plateformes (logo, couleur de
  fond ou image personnalisée de la carte).
- **Maintenance** : vider le cache, recharger les addons, réindexer TMDB.

**Thème du client web** (*Réglages → Client web*) : le client web Jellyfin servi par Stremfin
utilise par défaut le thème [Abyss](https://github.com/AumGupta/abyss-jellyfin) (MIT), avec
sa bannière Spotlight en haut de l'accueil. Fichiers et polices sont servis par Stremfin
(`vendor/abyss`), sans appel à Google Fonts, jsDelivr ni GitHub. On peut revenir au thème
d'origine de Jellyfin ou couper Spotlight.

Par défaut, Spotlight présente les **films tendance du jour sur TMDB**, même absents des
bibliothèques : logo, image, année, note et résumé. Le bouton « i » ouvre la fiche Stremfin
du film, lisible via les addons. L'autre choix (*Réglages → Client web*), « Mes reprises »,
garde le contenu d'origine d'Abyss.

**CSS par profil** : le client web Jellyfin servi par Stremfin (`/web`, aussi utilisé par
Jellyfin Media Player et l'app Android pour téléphone) applique le CSS du profil connecté.
Il suit les connexions et changements de profil ; une modification s'applique au prochain
chargement de la page ou au retour sur l'onglet. Les apps natives n'utilisent pas de CSS.

## Mes médias, plateformes et accueil

- **Mes médias** : Films, Séries TV, Films d'animation, Séries d'animation (et en option
  Animés, Documentaires, Séries documentaires, Jeunesse), triables dans l'app par nom,
  date ou note. Leur rangée « ajouts récents » montre les dernières sorties.
- **Plateformes** : une bibliothèque de cartes larges (logo officiel sur fond de marque),
  puis pour chaque service ses rayons : films / séries populaires, nouveautés, mieux notés.
  Sur l'accueil, elle forme une rangée de cartes larges (« Plateformes, ajouts récents » :
  le suffixe est imposé par l'app).
- **Accueil** (onglet du profil) : ordre des sections (Mes médias, Continuer à regarder,
  rangées des bibliothèques, À suivre) et bibliothèques avec ou sans rangée. Les rangées
  suivent l'ordre des bibliothèques : mets *Plateformes* en tête pour l'avoir juste sous
  « Continuer à regarder ».

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
| `UPSTREAM_MODE` / `UPSTREAM_URL` | Sortie réseau initiale : `direct`, `socks` (WARP) ou `http` |
| `TORRENT_SERVER` | URL d'un serveur de streaming Stremio pour les torrents |
| `SERVER_NAME` | Nom affiché dans les apps (modifiable dans l'admin) |
| `TMDB_API_KEY` | Clé API TMDB v3 (modifiable dans l'admin) |
| `WEB_DIR` | Dossier du client web Jellyfin (fourni dans l'image Docker) |

## Limites actuelles

- Pas de transcodage : l'app lit le fichier tel quel. Les apps natives (Android TV,
  Swiftfin, Infuse, Findroid) lisent presque tout. Le client web dépend du navigateur
  (MKV/HEVC souvent refusés).
- Les infos techniques (résolution, codecs, HDR) sont déduites du nom de la source.
- Saut d'intro : seulement pour les épisodes et films présents dans TheIntroDB.
- Les sagas se limitent à celles des films populaires et les mieux notés du moment.
