# Spec V2 — Vue d'ensemble

## Contexte

Le bot "Le Chroniqueur" évolue d'un bot mono-instance hardcodé vers une plateforme configurable, multi-instance, avec onboarding assisté par IA et interfaces Discord Components V2.

## Modèle de distribution

**Self-hosted** — L'utilisateur déploie une boîte noire Docker sur son serveur. Un seul `curl | bash` installe tout : le bot, SearXNG, et Postiz pré-configuré. L'onboarding se fait ensuite dans Discord.

## Les 6 niveaux

| Niveau | Nom | Description |
|--------|-----|-------------|
| 1 | Config dynamique | Persona, catégories, thème en DB au lieu de hardcodé |
| 2 | Components V2 + Dashboard | Migration V2, channel #dashboard, channel #recherche |
| 3 | Onboarding automatique | guildCreate → DM → clés API → Postiz → création channels |
| 4 | Wizard IA | Claude génère persona + catégories + keywords avec dry-run SearXNG |
| 5 | Multi-instance | N instances par serveur, routing par channel ID, DB isolées |
| 6 | Publication avancée | Postiz intégré, mode manuel (kit copier-coller), APIs directes (futur) |

Chaque niveau inclut les précédents.

## Phases de développement

### Phase 1 — Fondations (Niveau 1)

- Refactoring config : 3 env vars au lieu de 25
- Système de chiffrement AES-256-GCM pour les secrets per-instance
- Persona en DB (table `persona`), catégories en DB (table `veille_categories`)
- Config overrides en DB avec historique
- Service `PersonaLoader` centralisé avec invalidation de cache
- Templates de prompts (plus de "Le Chroniqueur" hardcodé dans le code)
- Classification des paramètres : hot-reload / warm-reload / cold-reload

### Phase 2 — Components V2 + Dashboard (Niveau 2)

- Upgrade discord.js vers 14.25.1
- Nouveau `component-builder-v2.ts` (remplace `message-builder.ts`)
- Fallback V1 si V2 échoue
- Channel `#dashboard` : message permanent (accueil), sous-pages en éphémère
- Channel `#recherche` : interface permanente + résultats temporaires (nettoyage 12h)
- Auto-refresh du dashboard après chaque job cron
- Budget composants : max 30/40 par message
- Suppression des slash commands (sauf `/onboard` pour le bootstrap)
- Publication Mode 1 : kit copier-coller (caption + médias téléchargeables)

### Phase 3 — Onboarding + Postiz (Niveaux 3 + 6)

- Script d'installation `install.sh` (curl | bash)
- Docker-compose avec bot + SearXNG + Postiz + PostgreSQL + Redis
- Event `guildCreate` → DM admin → wizard de collecte des clés API
- Validation des clés (appel test Anthropic, ping Postiz)
- Guide pas-à-pas pour les clés réseaux sociaux (TikTok, Instagram, X, LinkedIn)
- Écriture dans le `.env` Postiz + restart container via Docker socket proxy
- Vérification des intégrations Postiz connectées
- Détection HTTP vs HTTPS (TikTok bloqué sans HTTPS)
- Création auto catégorie + channels Discord
- README projet public avec une seule commande d'installation

### Phase 4 — Wizard IA (Niveau 4)

- State machine du wizard avec sauvegarde en DB à chaque étape
- Conversation Claude pour générer persona + catégories + keywords
- Dry-run SearXNG pour valider les keywords proposés
- Persona généré section par section (Identité, Ton, Vocabulaire, Direction artistique)
- Max 20 itérations par session, compteur de tokens affiché
- Reprise après crash ("Tu avais un onboarding en cours, reprendre ?")

### Phase 5 — Multi-instance (Niveau 5)

- DB globale `bot.db` (registry, secrets, wizard sessions)
- DB per-instance `data/instances/{id}/database.db`
- Registry d'instances avec routing par channel ID
- `InstanceContext` injecté dans tous les handlers
- Décalage automatique des crons entre instances
- Event `channelDelete` → alerte + auto-healing
- Bouton pause/resume instance dans le dashboard
- Section santé dans le dashboard (ping services)
- Vérification de mise à jour au boot (GitHub Releases)

### Phase 6 — Release system + polish

- GitHub Actions : semantic-release + CHANGELOG auto
- Docker build multi-stage → push GHCR avec tags semver
- Scan de sécurité Trivy
- Script d'installation avec auto-update (Watchtower optionnel)
- Export/import de config d'instance

## Décisions d'architecture (ADR)

| # | Décision | Raison |
|---|----------|--------|
| 014 | Self-hosted, pas bot public | Postiz single-tenant, OAuth réseaux sociaux nécessite browser |
| 015 | 3 env vars au lieu de 25 | Channels créés par le bot, clés API en DB chiffrée |
| 016 | AES-256-GCM pour les secrets | Authentification intégrée, détection de tampering |
| 017 | Sous-pages dashboard en éphémère | Élimine les race conditions multi-admin |
| 018 | Message permanent = accueil lecture seule | Auto-refresh après chaque cron, SPOF mitigé par recréation au boot |
| 019 | Timeout recherche 12h | Confort utilisateur, résultats consultation-only |
| 020 | Docker socket proxy pour restart Postiz | Sécurité (pas d'accès root direct) |
| 021 | Dry-run SearXNG pendant le wizard | Valide les keywords avant de finaliser la config |
| 022 | Décalage auto des crons multi-instance | Évite les pics de charge simultanés |
| 023 | discord.js 14.25.1 | Components V2 GA, dernière stable |
| 024 | Publication Mode 1 par défaut | Kit copier-coller, zéro dépendance, 100% des utilisateurs |
