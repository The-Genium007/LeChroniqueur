# Spec V2 — Architecture

## Vue d'ensemble

```
┌─────────────────────────────────────────────────────────┐
│                    docker-compose                        │
│                                                          │
│  ┌──────────────┐    ┌──────────────┐                   │
│  │  bot          │───▶│   searxng     │                  │
│  │  (Node.js 22) │    │  (port 8080)  │                  │
│  └──────┬────────┘    └──────────────┘                   │
│         │                                                │
│         ├──▶ postiz (port 4007)                          │
│         │     ├── postiz-db (PostgreSQL 17)              │
│         │     └── postiz-redis (Redis 7.2)               │
│         │                                                │
│         └──▶ docker-proxy (socket proxy)                 │
│                                                          │
│  Volumes :                                               │
│    bot_data    → /app/data (DB globale + instances)      │
│    postiz_*    → données Postiz                          │
└─────────────────────────────────────────────────────────┘
          │              │              │
          ▼              ▼              ▼
    Discord API    Anthropic API    Google AI API
```

## Structure du code

```
src/
├── index.ts                  # Boot séquence
├── core/
│   ├── config.ts             # Infra config (3 env vars) + Zod
│   ├── database.ts           # Connexion SQLite (global + instances)
│   ├── logger.ts             # Pino
│   ├── scheduler.ts          # node-cron multi-instance
│   ├── crypto.ts             # AES-256-GCM encrypt/decrypt
│   ├── migrations/
│   │   ├── global.ts         # Migrations DB globale (bot.db)
│   │   └── instance.ts       # Migrations DB instance
│   └── bot.ts                # Client Discord, login
│
├── registry/
│   ├── instance-registry.ts  # Chargement, routing, CRUD
│   ├── instance-context.ts   # Type InstanceContext
│   └── channel-router.ts     # Routing interaction → instance
│
├── services/
│   ├── anthropic.ts          # Client Claude (inchangé)
│   ├── searxng.ts            # Client SearXNG (inchangé)
│   ├── google-ai.ts          # Client Imagen/Veo (inchangé)
│   ├── postiz.ts             # Client Postiz (inchangé)
│   └── docker.ts             # Restart Postiz via docker proxy
│
├── discord/
│   ├── component-builder-v2.ts  # Nouveau — Components V2
│   ├── message-builder.ts       # Ancien — Fallback V1
│   ├── interactions.ts          # Router (mis à jour pour multi-instance)
│   └── permissions.ts           # isOwner → basé sur instance.owner_id
│
├── dashboard/
│   ├── pages/
│   │   ├── home.ts           # Page accueil
│   │   ├── veille.ts         # Page veille
│   │   ├── content.ts        # Page contenu
│   │   ├── budget.ts         # Page budget
│   │   └── config.ts         # Page config
│   ├── dashboard.ts          # Orchestrateur (refresh, recréation)
│   └── search.ts             # Interface de recherche + nettoyage
│
├── onboarding/
│   ├── welcome.ts            # guildCreate handler
│   ├── api-keys.ts           # Collecte clés Anthropic/Google
│   ├── postiz-setup.ts       # Config Postiz + réseaux sociaux
│   ├── wizard/
│   │   ├── state-machine.ts  # Steps, transitions
│   │   ├── describe.ts       # Step : description projet
│   │   ├── categories.ts     # Step : catégories de veille
│   │   ├── dryrun.ts         # Step : dry-run SearXNG
│   │   ├── persona.ts        # Step : génération persona
│   │   ├── platforms.ts      # Step : plateformes + schedule
│   │   └── confirm.ts        # Step : résumé + création
│   └── infrastructure.ts     # Création catégorie + channels Discord
│
├── veille/
│   ├── queries.ts            # Modifié — charge depuis DB
│   ├── collector.ts          # Inchangé
│   ├── analyzer.ts           # Modifié — prompts templatisés
│   └── deep-dive.ts          # Modifié — persona depuis ctx
│
├── content/
│   ├── suggestions.ts        # Modifié — persona + config depuis ctx
│   ├── scripts.ts            # Modifié — persona depuis ctx
│   ├── media-gen.ts          # Inchangé
│   └── video-gen.ts          # Inchangé
│
├── publication/
│   ├── manual.ts             # Nouveau — Mode 1 kit copier-coller
│   └── postiz.ts             # Existant, refactorisé
│
├── feedback/
│   ├── ratings.ts            # Inchangé
│   └── preference-learner.ts # Inchangé
│
├── search/
│   └── engine.ts             # Inchangé
│
├── budget/
│   └── tracker.ts            # Inchangé
│
├── handlers/
│   ├── veille.ts             # Modifié — reçoit InstanceContext
│   ├── suggestions.ts        # Modifié — reçoit InstanceContext
│   ├── conversation.ts       # Modifié — reçoit InstanceContext
│   ├── production.ts         # Modifié — reçoit InstanceContext
│   ├── publication.ts        # Modifié — reçoit InstanceContext
│   └── rapport.ts            # Modifié — reçoit InstanceContext
│
└── dev/
    ├── dry-run.ts            # Mode dev (inchangé)
    ├── cli-runner.ts         # CLI (inchangé)
    └── fixtures.ts           # Mock data (inchangé)

specs/                        # Specs V2 (ce dossier)
config/searxng/               # Config SearXNG (inchangé)
scripts/
├── install.sh                # Script d'installation
└── backup.sh                 # Script de backup

.github/
└── workflows/
    └── release.yml           # CI/CD : test → build → push GHCR → release
```

## PersonaLoader centralisé

Remplace les 3 `loadPersona()` dupliqués dans suggestions.ts, scripts.ts, deep-dive.ts.

```typescript
class PersonaLoader {
  private cache: Map<string, string>;  // instanceId → persona

  load(ctx: InstanceContext): string;
  invalidate(instanceId: string): void;
  invalidateAll(): void;
}
```

Invalidation appelée quand :
- Le dashboard modifie le persona
- Le wizard génère un nouveau persona

## Handlers refactorisés

Avant :
```typescript
await handleVeilleCron({
  db,
  veilleChannel: channels.veille,
  logsChannel: channels.logs,
  adminChannel: channels.admin,
});
```

Après :
```typescript
await handleVeilleCron(ctx: InstanceContext);
```

Le `ctx` contient tout : db, channels, config, persona, secrets.

## Boot séquence V2

```
1. Charger infra config (env vars)
2. Créer le logger
3. Ouvrir la DB globale (bot.db) + migrations
4. Créer le client Discord + login
5. Charger le registry d'instances
6. Pour chaque instance active :
   a. Ouvrir sa DB + migrations
   b. Charger sa config
   c. Résoudre ses channels Discord
   d. Vérifier que le dashboard existe (recréer si besoin)
   e. Démarrer ses crons (avec rattrapage)
7. Écouter les events :
   - InteractionCreate → router vers l'instance
   - MessageCreate → router vers l'instance
   - GuildCreate → onboarding
   - ChannelDelete → alerte + auto-healing
8. Vérifier les mises à jour (GitHub Releases)
9. Log "bot is fully operational"
```

## Graceful shutdown V2

```
1. Arrêter tous les crons (toutes les instances)
2. Attendre la fin des opérations en cours (timeout 30s)
3. Fermer toutes les DB instances
4. Fermer la DB globale
5. Détruire le client Discord
6. Exit 0
```
