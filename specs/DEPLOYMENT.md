# Spec — Déploiement

## Environnements

| Env | Description |
|-----|-------------|
| Local | `npm run dev` (tsx watch) — développement sur la machine de Lucas |
| Production | Docker via Dokploy sur VPS OVHcloud (51.255.195.30) |

## Pipeline de déploiement

```
git push origin main
        │
        ▼
GitHub (repo perso Lucas)
        │
        ▼ Webhook Dokploy
Dokploy (VPS)
        │
        ▼
docker-compose build + up
        │
        ├── tumulte-bot (Node.js)
        ├── tumulte-searxng (SearXNG)
        ├── postiz (social media publishing)
        ├── postiz-db (PostgreSQL)
        ├── postiz-redis (Redis)
        ├── docker-proxy (Docker socket proxy)
        └── caddy (HTTPS reverse proxy, optionnel)
```

## Configuration Dokploy

1. Créer un projet "tumulte-bot" dans Dokploy
2. Source : GitHub repo de Lucas
3. Branch : `main`
4. Build : docker-compose
5. Variables d'environnement : saisies dans l'interface Dokploy
6. Auto-deploy : activé sur push

## HTTPS via Caddy (optionnel)

Pour activer HTTPS (requis pour TikTok OAuth) :

1. Pointer un domaine DNS (A record) vers l'IP du VPS
2. Définir `POSTIZ_DOMAIN=postiz.mondomaine.com` dans `.env`
3. Définir `POSTIZ_URL=https://postiz.mondomaine.com` dans `.env`
4. Lancer avec le profil HTTPS : `docker compose --profile https up -d`

Caddy obtient automatiquement un certificat Let's Encrypt et le renouvelle.

### Architecture réseau (mode HTTPS)

```
Internet → :443 (Caddy, TLS) → postiz:5000 (HTTP interne)
                                     ↑
                              réseau Docker "internal"
```

### Prérequis

- Port 80 et 443 libres sur le VPS (Caddy en a besoin pour le challenge ACME)
- Un enregistrement DNS A pointant vers l'IP du serveur
- Pas d'autre reverse proxy sur les mêmes ports

## Volumes persistants

| Volume | Contenu | Sauvegarde |
|--------|---------|------------|
| `bot_data` | `tumulte.db` (SQLite) + cache médias | À sauvegarder régulièrement |
| `bot_logs` | Logs pino JSON | Rotation automatique |
| `./prompts` | SKILL.md, CHRONIQUEUR.md | Dans le repo Git |
| `./config/searxng` | settings.yml | Dans le repo Git |

## Dockerfile — Build multi-stage

```
Stage 1 (builder) :
  - node:20-alpine
  - npm ci (toutes les deps)
  - tsc (compilation TypeScript)

Stage 2 (production) :
  - node:20-alpine
  - npm ci --omit=dev (deps prod uniquement)
  - COPY dist/ depuis builder
  - USER node (non-root)
  - tini comme init process
```

## Santé

Le bot log au démarrage :
- Version Node.js
- État de la connexion Discord
- État de la connexion SQLite
- État de SearXNG (ping)
- Nombre d'articles en base
- Dernier run de chaque cron job

Si un service critique est down au boot → log erreur + retry 3 fois → exit 1.

Dokploy redémarre automatiquement (restart: unless-stopped).

## Variables d'environnement requises

Voir `.env.example`. Toutes validées par Zod au boot.

Le bot refuse de démarrer si une variable requise manque ou est invalide.

## Backups

La base SQLite est un fichier unique dans le volume `bot_data`.

Recommandation : cron job sur le VPS (hors Docker) qui copie `tumulte.db`
vers un stockage externe (S3, Backblaze, ou simple rsync vers un autre serveur).

```bash
# Exemple de backup cron (sur le VPS, pas dans Docker)
0 3 * * * docker cp tumulte-bot:/app/data/tumulte.db /backups/tumulte-$(date +\%Y\%m\%d).db
```

## Logs

Format : JSON (pino) — facilite le parsing et l'agrégation.

Niveaux :
- `fatal` : bot ne peut pas démarrer
- `error` : erreur rattrapée mais significative
- `warn` : situation anormale non bloquante
- `info` : événements normaux (veille lancée, suggestion créée, etc.)
- `debug` : détails techniques (requêtes SearXNG, tokens utilisés)

En production : `LOG_LEVEL=info`
En développement : `LOG_LEVEL=debug`
