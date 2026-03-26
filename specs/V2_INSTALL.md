# Spec V2 — Installation et Release

## Installation en une commande

```bash
curl -fsSL https://raw.githubusercontent.com/PowerGlove/LeChroniqueur/main/install.sh | bash
```

### Ce que fait `install.sh`

```bash
#!/bin/bash
set -euo pipefail

# 1. Vérifier les prérequis
#    - Docker >= 24
#    - Docker Compose >= 2.20
#    - curl, openssl

# 2. Créer le répertoire d'installation
mkdir -p lechroniqueur && cd lechroniqueur

# 3. Télécharger docker-compose.yml et .env.example
curl -fsSL https://raw.githubusercontent.com/.../docker-compose.yml -o docker-compose.yml
curl -fsSL https://raw.githubusercontent.com/.../.env.example -o .env.example

# 4. Poser les 3 questions
read -p "Discord Bot Token: " DISCORD_TOKEN
read -p "URL publique de Postiz (ex: https://postiz.mondomaine.com): " POSTIZ_URL

# 5. Générer les secrets automatiquement
MASTER_ENCRYPTION_KEY=$(openssl rand -hex 32)
POSTIZ_JWT_SECRET=$(openssl rand -hex 32)
POSTIZ_DB_PASSWORD=$(openssl rand -hex 16)

# 6. Générer le .env
cat > .env << EOF
DISCORD_TOKEN=${DISCORD_TOKEN}
MASTER_ENCRYPTION_KEY=${MASTER_ENCRYPTION_KEY}
POSTIZ_URL=${POSTIZ_URL}
POSTIZ_JWT_SECRET=${POSTIZ_JWT_SECRET}
POSTIZ_DB_PASSWORD=${POSTIZ_DB_PASSWORD}
EOF

chmod 600 .env

# 7. Créer les répertoires de données
mkdir -p data config/searxng

# 8. Télécharger la config SearXNG par défaut
curl -fsSL https://raw.githubusercontent.com/.../config/searxng/settings.yml \
  -o config/searxng/settings.yml

# 9. Lancer
docker compose up -d

# 10. Afficher le résultat
echo "✅ Le Chroniqueur est installé !"
echo "   Invite le bot sur ton serveur Discord."
echo "   L'onboarding se fera automatiquement en DM."
echo ""
echo "📊 Postiz sera accessible sur : ${POSTIZ_URL}"
echo "📋 Logs : docker compose logs -f bot"
```

## Docker Compose complet

```yaml
services:
  # ─── Le bot ───
  bot:
    image: ghcr.io/powerglove/lechroniqueur:latest
    environment:
      DISCORD_TOKEN: ${DISCORD_TOKEN}
      MASTER_ENCRYPTION_KEY: ${MASTER_ENCRYPTION_KEY}
      POSTIZ_INTERNAL_URL: http://postiz:4007
      POSTIZ_URL: ${POSTIZ_URL}
      SEARXNG_URL: http://searxng:8080
      NODE_ENV: production
      LOG_LEVEL: info
    volumes:
      - bot_data:/app/data
      - postiz_env:/app/postiz-env    # Volume partagé pour le .env Postiz
    depends_on:
      searxng:
        condition: service_started
      postiz:
        condition: service_healthy
    restart: unless-stopped

  # ─── SearXNG ───
  searxng:
    image: searxng/searxng:latest
    volumes:
      - ./config/searxng:/etc/searxng
    restart: unless-stopped

  # ─── Postiz ───
  postiz:
    image: ghcr.io/gitroomhq/postiz-app:latest
    environment:
      DATABASE_URL: postgresql://postiz:${POSTIZ_DB_PASSWORD}@postiz-db:5432/postiz
      REDIS_URL: redis://postiz-redis:6379
      JWT_SECRET: ${POSTIZ_JWT_SECRET}
      MAIN_URL: ${POSTIZ_URL}
      FRONTEND_URL: ${POSTIZ_URL}
      NEXT_PUBLIC_BACKEND_URL: ${POSTIZ_URL}/api
      BACKEND_INTERNAL_URL: http://localhost:3000
      STORAGE_PROVIDER: local
      UPLOAD_DIRECTORY: /uploads
      NEXT_PUBLIC_UPLOAD_DIRECTORY: /uploads
      DISABLE_REGISTRATION: "false"   # true après premier compte créé
      IS_GENERAL: "true"
      RUN_CRON: "true"
    env_file:
      - ./postiz-social.env           # Clés réseaux sociaux (écrites par le bot)
    volumes:
      - postiz_uploads:/uploads
    ports:
      - "4007:4007"
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:4007"]
      interval: 10s
      timeout: 5s
      retries: 30
      start_period: 60s
    depends_on:
      postiz-db:
        condition: service_healthy
      postiz-redis:
        condition: service_started
    restart: unless-stopped

  postiz-db:
    image: postgres:17-alpine
    environment:
      POSTGRES_USER: postiz
      POSTGRES_PASSWORD: ${POSTIZ_DB_PASSWORD}
      POSTGRES_DB: postiz
    volumes:
      - postiz_pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postiz"]
      interval: 5s
      timeout: 3s
      retries: 10
    restart: unless-stopped

  postiz-redis:
    image: redis:7.2-alpine
    volumes:
      - postiz_redis:/data
    restart: unless-stopped

  # ─── Docker socket proxy (pour restart Postiz depuis le bot) ───
  docker-proxy:
    image: tecnativa/docker-socket-proxy
    environment:
      CONTAINERS: 1
      POST: 1
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
    restart: unless-stopped

volumes:
  bot_data:
  postiz_uploads:
  postiz_pgdata:
  postiz_redis:
  postiz_env:
```

### Fichier `postiz-social.env`

Créé vide par `install.sh`, rempli par le bot pendant l'onboarding :

```env
# Rempli automatiquement par le bot via l'onboarding Discord
X_API_KEY=
X_API_SECRET=
TIKTOK_CLIENT_ID=
TIKTOK_CLIENT_SECRET=
INSTAGRAM_APP_ID=
INSTAGRAM_APP_SECRET=
LINKEDIN_CLIENT_ID=
LINKEDIN_CLIENT_SECRET=
```

## Système de release

### Versioning

Semantic versioning strict basé sur les commits conventionnels :

```
feat: → minor (0.X.0)
fix:  → patch (0.0.X)
BREAKING CHANGE: → major (X.0.0)
```

### GitHub Actions pipeline

Fichier `.github/workflows/release.yml` :

1. **Sur push `main`** :
   - Run `npm run typecheck`
   - Run `npm test`
   - Déterminer la version (analyse des commits)
   - Générer le CHANGELOG
   - Créer le tag Git + GitHub Release
   - Build Docker multi-stage
   - Push vers `ghcr.io/powerglove/lechroniqueur:X.Y.Z` + `:latest`
   - Scan de sécurité Trivy

### Dockerfile multi-stage

```dockerfile
# Stage 1 — Build
FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# Stage 2 — Production
FROM node:22-alpine
RUN apk add --no-cache tini curl
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist
USER node
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]
```

### Vérification de mise à jour au boot

Au démarrage, le bot fetch `https://api.github.com/repos/PowerGlove/LeChroniqueur/releases/latest` et compare avec sa version embarquée. Si une nouvelle version existe, alerte dans le dashboard.

## README du projet public

Le README doit contenir :

1. **Header** : nom, description courte, badges (version, license, Docker pulls)
2. **Screenshot** : capture du dashboard Discord
3. **Installation** : la commande curl unique
4. **Prérequis** : Docker >= 24, un serveur avec 2 Go RAM, un bot Discord créé
5. **Guide rapide** :
   - Créer le bot sur discord.com/developers
   - Lancer l'install
   - Inviter le bot
   - Suivre l'onboarding dans Discord
6. **Architecture** : schéma des containers
7. **Configuration** : tableau des 3 env vars
8. **Mise à jour** : `docker compose pull && docker compose up -d`
9. **Backup** : commande de backup SQLite
10. **License** : à définir
