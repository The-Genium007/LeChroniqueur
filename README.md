# Le Chroniqueur — Bot Discord

Bot Discord autonome de veille, création de contenu IA et publication pour le persona **Le Chroniqueur** (Tumulte).

## Stack

- **TypeScript strict** (Node.js 20+)
- **discord.js v14** — boutons Components V2, commandes slash
- **Claude Sonnet 4.6** — analyse, rédaction, scoring
- **Google AI** — Imagen (images) + Veo 3.1 (vidéos)
- **SearXNG** — veille multi-sources auto-hébergée
- **Postiz** — publication programmée réseaux sociaux
- **SQLite + FTS5** — persistance + recherche full-text
- **Docker** — bot + SearXNG

---

## Guide de déploiement

### Prérequis

- VPS avec Dokploy installé
- Compte GitHub (repo déjà créé)
- Postiz self-hosted fonctionnel (postiz.tumulte.app)
- Token bot Discord
- Clé API Anthropic
- Clé API Google AI (optionnel — nécessaire pour images/vidéos)

### Étape 1 — Créer les channels Discord

Sur le serveur **Power Glove**, crée 6 channels texte :

| Channel | Rôle |
|---------|------|
| `#veille` | Digests quotidiens + rapport hebdomadaire |
| `#idées` | Suggestions de contenu avec boutons Go/Modifier/Skip |
| `#production` | Scripts finaux, visuels, vidéos en cours |
| `#publication` | Validation finale avant publication |
| `#logs` | Logs techniques, alertes budget |
| `#admin` | Administration, `/search`, texte libre |

Pour chaque channel, copie l'ID (clic droit → Copier l'identifiant du salon). Tu en auras besoin à l'étape 3.

### Étape 2 — Créer le bot Discord

1. Va sur https://discord.com/developers/applications
2. Crée une nouvelle application (ou utilise "Tumulte Agent" existante)
3. Dans **Bot** :
   - Copie le **Token** (tu en auras besoin à l'étape 3)
   - Active **Message Content Intent** (nécessaire pour lire les messages dans #admin)
   - Active **Server Members Intent** (optionnel)
4. Dans **OAuth2 → URL Generator** :
   - Scopes : `bot`, `applications.commands`
   - Permissions : `Send Messages`, `Embed Links`, `Attach Files`, `Read Message History`, `Add Reactions`, `Use Slash Commands`, `Create Public Threads`, `Send Messages in Threads`
5. Copie l'URL générée et invite le bot sur le serveur Power Glove

### Étape 3 — Configurer les variables d'environnement

Copie `.env.example` en `.env` et remplis les valeurs :

```env
# --- Discord ---
DISCORD_TOKEN=ton_token_bot
DISCORD_GUILD_ID=1387804174762377226
DISCORD_OWNER_ID=256867307853316097

# Channel IDs (récupérés à l'étape 1)
CHANNEL_VEILLE=id_du_channel
CHANNEL_IDEES=id_du_channel
CHANNEL_PRODUCTION=id_du_channel
CHANNEL_PUBLICATION=id_du_channel
CHANNEL_LOGS=id_du_channel
CHANNEL_ADMIN=id_du_channel

# Channels existants (lecture seule)
CHANNEL_BUGS=1449809724965912676
CHANNEL_FEEDBACK=1460592398748090489

# --- Anthropic ---
ANTHROPIC_API_KEY=sk-ant-...

# --- Google AI (laisser vide si billing pas activé) ---
GOOGLE_AI_API_KEY=

# --- Postiz (self-hosted — inclus dans le docker-compose) ---
POSTIZ_MAIN_URL=https://postiz.tumulte.app
POSTIZ_JWT=generé_avec_openssl_rand_base64_32
POSTIZ_DB_USER=postiz
POSTIZ_DB_PASS=un_mot_de_passe_fort
POSTIZ_DB_NAME=postiz

# --- Postiz API (réseau Docker interne) ---
POSTIZ_API_URL=http://postiz:5000/public/v1
POSTIZ_API_KEY=recupéré_dans_postiz_settings_developers

# --- Réseaux sociaux (à remplir quand configurés dans Postiz) ---
INSTAGRAM_APP_ID=
INSTAGRAM_APP_SECRET=
TIKTOK_CLIENT_ID=
TIKTOK_CLIENT_SECRET=

# --- SearXNG (réseau Docker interne) ---
SEARXNG_URL=http://searxng:8080

# --- Budget ---
BUDGET_DAILY_CENTS=300
BUDGET_WEEKLY_CENTS=1500
BUDGET_MONTHLY_CENTS=5000

# --- Scheduler ---
VEILLE_CRON=0 7 * * *
SUGGESTIONS_CRON=0 8 * * *
RAPPORT_CRON=0 21 * * 0

# --- Logging ---
LOG_LEVEL=info
NODE_ENV=production
```

> **Note :** Pour générer le `POSTIZ_JWT`, lance : `openssl rand -base64 32`
> La `POSTIZ_API_KEY` se récupère dans l'interface Postiz : Settings > Developers > Public API.

### Étape 4 — Déployer sur Dokploy

1. Ouvre Dokploy sur ton VPS
2. Crée un nouveau projet : **LeChroniqueur**
3. Source : **GitHub** → `The-Genium007/LeChroniqueur`
4. Branche : `main`
5. Type de build : **Docker Compose**
6. Dans les variables d'environnement de Dokploy, colle toutes les variables du `.env`
7. Active **Auto-deploy on push**
8. Clique **Deploy**

Dokploy va :
- Cloner le repo
- Builder l'image Docker du bot (TypeScript → JavaScript)
- Pull les images Postiz, PostgreSQL, Redis, SearXNG
- Lancer 5 containers : `tumulte-bot` + `tumulte-searxng` + `tumulte-postiz` + `tumulte-postiz-db` + `tumulte-postiz-redis`
- Le bot se connecte à Discord et enregistre les commandes slash

### Étape 5 — Configurer Postiz

1. Ouvre `https://postiz.tumulte.app` dans ton navigateur
2. Crée ton compte admin (premier utilisateur)
3. Va dans **Settings > Developers > Public API**
4. Copie la clé API et mets-la dans `POSTIZ_API_KEY` (variables Dokploy)
5. Redéploie depuis Dokploy pour que le bot ait la clé

> `DISABLE_REGISTRATION=true` dans le compose empêche les inscriptions publiques après ton premier compte.

### Étape 6 — Vérifier que tout tourne

Dans Discord, tape `/budget` dans `#admin`. Si le bot répond avec un embed de budget, tout est bon.

Vérifie aussi :
- `#logs` — le bot y log son démarrage
- `https://postiz.tumulte.app` — l'interface Postiz est accessible

### Étape 6 — Activer la génération de médias (optionnel)

Pour les images et vidéos (Phases 3 et 5) :

1. Va sur https://aistudio.google.com
2. Active le billing (carte bancaire requise)
3. Copie la clé API
4. Ajoute `GOOGLE_AI_API_KEY=ta_clé` dans les variables Dokploy
5. Redéploie

### Étape 7 — Connecter les réseaux sociaux à Postiz

**Instagram :**
1. Va sur https://developers.facebook.com
2. Crée une app → type "Other" → "Business"
3. Ajoute le produit "Instagram Business Login"
4. Redirect URI : `https://postiz.tumulte.app/integrations/social/instagram-standalone`
5. Copie App ID et App Secret
6. Ajoute `INSTAGRAM_APP_ID` et `INSTAGRAM_APP_SECRET` dans les variables Dokploy
7. Redéploie
8. Connecte le compte @lechroniqueur.tumulte dans l'interface Postiz

**TikTok :**
1. Va sur https://developers.tiktok.com
2. Crée une app → Login Kit + Content Posting API (Direct Post)
3. Redirect URI : `https://postiz.tumulte.app/integrations/social/tiktok`
4. Copie Client ID et Client Secret
5. Ajoute `TIKTOK_CLIENT_ID` et `TIKTOK_CLIENT_SECRET` dans les variables Dokploy
6. Redéploie
7. Connecte le compte @lechroniqueur.tumulte dans Postiz

### Étape 8 — Fournir le persona

Place les fichiers de persona dans le dossier `prompts/` du repo :
- `prompts/SKILL.md` — déjà en place (persona Le Chroniqueur)
- `prompts/CHRONIQUEUR.md` — optionnel (bible visuelle, si récupéré depuis OpenClaw)

---

## Ce que fait le bot

### Tous les jours à 7h — Veille
- Scanne 9 catégories de sources (TTRPG, memes, streaming, TikTok, influenceurs, VTT, communauté FR, Facebook, concurrence)
- EN + FR, traduit automatiquement
- Analyse et score chaque article via Claude
- Poste un digest dans `#veille` + thread détaillé avec boutons 👍/👎/🎯

### Tous les jours à 8h — Suggestions
- Génère 3 suggestions de contenu basées sur la veille + tes préférences
- Poste dans `#idées` avec boutons Go/Modifier/Skip/Plus tard

### Quand tu cliques Go
- Génère un script final (texte overlay, hashtags, notes de production)
- Poste dans `#production` avec boutons Valider/Retoucher

### Quand tu cliques Valider
- Génère 2 variantes d'images (si Google AI activé)
- Upload dans Postiz
- Programme la publication

### Tous les dimanches à 21h — Rapport
- Top articles de la semaine
- Stats suggestions (taux de Go vs Skip)
- Budget API (jour/semaine/mois)
- Évolution du profil de préférences
- Liste les publications sans métriques (tu les remplis manuellement)

### Commandes slash

| Commande | Description |
|----------|-------------|
| `/search <query>` | Recherche dans toute la base (veille, suggestions, publications) |
| `/veille` | Force une veille immédiate |
| `/budget` | Affiche les coûts API |
| `/stats` | Affiche ton profil de préférences |
| `/config <key> <value>` | Modifie un paramètre |

---

## Développement local

```bash
# Installer les dépendances
npm install

# Lancer en dev (hot reload)
npm run dev

# Typecheck
npm run typecheck

# Tests
npm test

# Build
npm run build
```

---

## Structure du projet

```
src/
├── index.ts              # Entry point
├── core/                 # Bot, DB, scheduler, logger, config
├── services/             # Anthropic, Google AI, SearXNG, Postiz
├── discord/              # Message builder, commandes, interactions
├── veille/               # Collecte, analyse, deep dive
├── content/              # Suggestions, scripts, images, vidéos
├── publication/          # Scheduling Postiz
├── feedback/             # Ratings, preference learner
├── search/               # FTS5 search engine
├── budget/               # Cost tracking, alertes
└── handlers/             # Orchestration (veille, suggestions, production, publication, rapport)

specs/                    # Spécifications techniques
prompts/                  # Persona Le Chroniqueur
config/searxng/           # Configuration SearXNG
```
