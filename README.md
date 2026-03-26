# Le Chroniqueur

Bot Discord autonome de veille, creation de contenu IA et publication pour les reseaux sociaux.

Un seul bot, plusieurs instances independantes. Chaque instance a son propre persona, ses sujets de veille, et ses channels dedies. Un wizard IA guide la configuration de A a Z.

## Fonctionnalites

- **Veille automatique** : SearXNG collecte des articles, Claude les analyse et les classe
- **Suggestions de contenu** : Claude genere des idees de posts adaptes a votre persona
- **Production** : Scripts finaux, generation d'images, hashtags, notes de production
- **Publication** : Kit copier-coller pret a publier, ou publication via Postiz
- **Dashboard Discord** : Interface Components V2 pour tout controler depuis Discord
- **Feedback learning** : Le bot apprend vos preferences via les reactions
- **Multi-instance** : Plusieurs personas/projets sur un meme serveur Discord
- **Budget tracking** : Suivi des couts API avec alertes automatiques

## Installation rapide

### Prerequis

- Docker >= 24 et Docker Compose v2
- Un serveur avec 2 Go de RAM minimum
- Un bot Discord cree sur [discord.com/developers](https://discord.com/developers/applications)

### Une seule commande

```bash
curl -fsSL https://raw.githubusercontent.com/PowerGlove/LeChroniqueur/main/scripts/install.sh | bash
```

Le script pose 3 questions (token Discord, URL Postiz, port), genere les cles de chiffrement, et lance les 6 containers.

### Installation manuelle

```bash
git clone https://github.com/PowerGlove/LeChroniqueur.git
cd LeChroniqueur
cp env.production.example .env
# Remplir DISCORD_TOKEN, MASTER_ENCRYPTION_KEY, POSTIZ_URL
docker compose -f docker-compose.prod.yml up -d
```

## Configuration

| Variable | Description | Obligatoire |
|----------|-------------|-------------|
| `DISCORD_TOKEN` | Token du bot Discord | Oui |
| `MASTER_ENCRYPTION_KEY` | Cle de chiffrement AES-256 (64 hex chars) | Oui |
| `POSTIZ_URL` | URL publique de Postiz | Oui |

Tout le reste (cles API, persona, categories de veille, reseaux sociaux) est configure via l'onboarding Discord.

## Architecture

```
docker compose
  |
  +-- bot (Node.js 22) ------- Discord API
  |                        \--- Anthropic API (Claude)
  |                         \-- Google AI API (Imagen/Veo)
  |
  +-- searxng (recherche web, port 8080 interne)
  |
  +-- postiz (publication reseaux sociaux)
  |     +-- postiz-db (PostgreSQL 17)
  |     +-- postiz-redis (Redis 7.2)
  |
  +-- docker-proxy (socket proxy pour restart Postiz)
```

## Onboarding

Quand le bot rejoint un serveur Discord :

1. DM au proprietaire avec un bouton "Creer ma premiere instance"
2. Collecte des cles API (Anthropic, Google AI) — validation automatique
3. Configuration Postiz (cles reseaux sociaux, guide pas a pas)
4. Wizard IA : Claude genere le persona et les categories de veille
5. Dry-run SearXNG : validation des keywords avec de vrais resultats
6. Creation automatique de la categorie + 7 channels Discord
7. Premiere veille lancee immediatement

## Channels par instance

```
[Nom de l'instance]
  +-- dashboard    (interface de controle)
  +-- recherche    (recherche dans l'historique)
  +-- veille       (articles quotidiens)
  +-- idees        (suggestions de contenu)
  +-- production   (scripts finaux + visuels)
  +-- publication  (kits prets a publier)
  +-- logs         (logs techniques + alertes)
```

## Stack technique

- **Runtime** : Node.js 22, TypeScript strict (ESM)
- **Discord** : discord.js 14.25 avec Components V2
- **IA texte** : Anthropic Claude Sonnet (analyse, redaction, scoring)
- **IA medias** : Google AI Imagen + Veo
- **Recherche** : SearXNG auto-heberge
- **Publication** : Postiz self-hosted
- **BDD** : SQLite + FTS5 (1 DB globale + 1 DB par instance)
- **Chiffrement** : AES-256-GCM pour les cles API
- **Scheduler** : node-cron avec rattrapage au boot et decalage multi-instance

## Mise a jour

```bash
docker compose pull && docker compose up -d
```

Le bot verifie automatiquement les mises a jour au demarrage.

## Backup

```bash
docker cp lechroniqueur-bot:/app/data ./backup-$(date +%Y%m%d)
```

## Developpement

```bash
npm install
cp .env.dev.example .env.dev
docker compose -f docker-compose.dev.yml up -d
npm run dev
```

```bash
npm run typecheck    # Verification types
npm test             # Tests unitaires
npm run build        # Build TypeScript
```

## Structure du projet

```
src/
  index.ts              # Entry point legacy
  index-v2.ts           # Entry point V2 (multi-instance)
  core/                 # Config, DB, scheduler, crypto, logger, health
  registry/             # Instance registry, channel router, context
  onboarding/           # Welcome, API keys, Postiz setup, wizard IA
  dashboard/            # Dashboard pages, search interface
  discord/              # Components V2 builder, message builder V1, interactions
  services/             # Anthropic, Google AI, SearXNG, Postiz, Docker
  veille/               # Collecte, analyse, deep dive, queries
  content/              # Suggestions, scripts, media
  publication/          # Manual kit, Postiz integration
  feedback/             # Ratings, preference learner
  search/               # FTS5 search engine
  budget/               # Cost tracking, alertes
  handlers/             # Orchestration

specs/                  # Specifications V2
scripts/                # Install script
ci/                     # GitHub Actions (move to .github/workflows/)
config/searxng/         # SearXNG configuration
```

## License

MIT — voir [LICENSE](LICENSE).
