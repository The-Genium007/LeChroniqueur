# tumulte-bot

Bot Discord autonome de veille, création de contenu IA et publication
pour le persona "Le Chroniqueur" (Tumulte).

## Stack

- **Langage** : TypeScript strict (ESM)
- **Runtime** : Node.js ≥ 20
- **Discord** : discord.js v14
- **IA texte** : @anthropic-ai/sdk — Claude Sonnet 4.6 (analyse, rédaction, scoring)
- **IA médias** : @google/genai — Imagen/Nano Banana Pro 2 (images) + Veo 3.1 (vidéos)
- **Recherche** : SearXNG auto-hébergé (veille multi-sources)
- **Publication** : Postiz API self-hosted (scheduling réseaux sociaux)
- **BDD** : SQLite via better-sqlite3 + FTS5 (recherche full-text)
- **Scheduler** : node-cron + rattrapage au boot via SQLite
- **Tests** : Vitest
- **Deploy** : Docker + docker-compose → Dokploy (VPS OVHcloud)

## Conventions

- **ESM uniquement** — `import`/`export`, jamais `require`
- **TypeScript strict** — `strict: true` + `noUncheckedIndexedAccess` + toutes les règles strictes du tsconfig.json
- **Une seule branche** : `main`
- **Commits conventionnels** : `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`
- **Specs first** — tout nouveau module DOIT avoir sa spec dans `specs/` AVANT d'être codé
- **Les specs sont la source de vérité** — le code les implémente, pas l'inverse
- **Pas de `any`** — utiliser `unknown` si le type est inconnu, puis narrower
- **Zod pour la validation** — toute donnée externe (API, env, Discord) passe par un schéma Zod
- **Fonctions pures** quand possible — facilite les tests
- **Erreurs explicites** — pas de `catch` silencieux, toujours logger

## Architecture

```
src/
├── index.ts              # Entry point — boot séquence
├── core/                 # Infrastructure (bot, db, scheduler, logger)
├── services/             # Clients API externes (Anthropic, Google, SearXNG, Postiz)
├── discord/              # Messages, boutons, commandes slash, permissions
├── veille/               # Pipeline veille (collecte, analyse, feedback)
├── content/              # Génération de contenu (suggestions, scripts, médias)
├── publication/          # Scheduling et publication via Postiz
├── feedback/             # Ratings 👍/👎 et preference learner
├── search/               # Moteur de recherche interne FTS5
├── budget/               # Tracking coûts API et alertes
└── handlers/             # Orchestration (connecte modules entre eux)

specs/                    # Spécifications de chaque module
prompts/                  # SKILL.md + CHRONIQUEUR.md (persona Le Chroniqueur)
config/searxng/           # Configuration SearXNG
```

## Workflow de développement

1. Lire la spec du module dans `specs/`
2. Implémenter selon la spec
3. Si la spec est ambiguë ou incorrecte → la corriger d'abord
4. Écrire les tests pour les modules critiques
5. Vérifier que `npm run typecheck` et `npm test` passent
6. Commit sur `main`

## Variables d'environnement

Voir `.env.example` pour la liste complète. Jamais de secrets dans le code ou les specs.

Validation via Zod dans `src/core/config.ts`.

## Modules critiques (tests obligatoires)

- `core/database.ts` — migrations, requêtes
- `core/scheduler.ts` — cron, rattrapage jobs manqués
- `veille/collector.ts` — collecte SearXNG, déduplication
- `veille/analyzer.ts` — scoring, classification
- `feedback/ratings.ts` — enregistrement 👍/👎
- `feedback/preference-learner.ts` — agrégation profil
- `search/engine.ts` — FTS5, requêtes, ranking
- `budget/tracker.ts` — comptage, seuils, alertes
- `discord/message-builder.ts` — construction embeds + boutons

## Commandes slash Discord

| Commande | Description |
|----------|-------------|
| `/search <query>` | Recherche full-text dans la base |
| `/veille` | Force une veille immédiate |
| `/budget` | Affiche les coûts jour/semaine/mois |
| `/stats` | Profil de préférences actuel |
| `/config <key> <value>` | Modifie un paramètre dynamique |

## Channels Discord

| Channel | Usage |
|---------|-------|
| `#veille` | Digest quotidien + rapport hebdo |
| `#idées` | Suggestions contenu avec boutons |
| `#production` | Scripts, visuels, vidéos en cours |
| `#publication` | Validation finale avant publish |
| `#logs` | Logs techniques, alertes budget |
| `#admin` | Administration, recherche, config |
