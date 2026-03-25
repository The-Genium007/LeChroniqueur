# Spec — Modules

Vue d'ensemble de chaque module, son rôle, ses dépendances, et son contrat.
Les modules critiques ont leur propre spec détaillée (DATABASE.md, VEILLE.md, etc.).

## Core

### core/config.ts

Charge et valide les variables d'environnement via Zod.
Exporte un objet `config` typé et immutable.

```typescript
const config: Readonly<Config>;
```

Dépendances : `zod`
Testé : non (validation Zod suffit)

### core/logger.ts

Logger structuré via pino. Exporte une instance unique.

```typescript
const logger: pino.Logger;
```

Dépendances : `pino`, `pino-pretty` (dev)
Testé : non

### core/database.ts

Connexion SQLite + migrations + méthodes typées.
Voir [DATABASE.md](./DATABASE.md) pour le schéma complet.

Dépendances : `better-sqlite3`
Testé : **oui** — migrations, CRUD, FTS5

### core/bot.ts

Client Discord, connexion, résolution des channels.

```typescript
async function createBot(): Promise<{ client: Client; channels: ChannelMap }>;
```

Dépendances : `discord.js`, `core/config`
Testé : non (nécessite un vrai bot Discord)

### core/scheduler.ts

Gestion des cron jobs avec rattrapage au boot.

```typescript
interface SchedulerJob {
  name: string;
  cron: string;
  handler: () => Promise<void>;
  runOnMissed: boolean;
}

function createScheduler(db: Database, jobs: SchedulerJob[]): Scheduler;
```

Au boot : pour chaque job avec `runOnMissed: true`, vérifie `cron_runs`.
Si le dernier run est plus vieux que l'intervalle prévu → exécute immédiatement.

Dépendances : `node-cron`, `core/database`
Testé : **oui** — logique de rattrapage

## Services

### services/searxng.ts

Client HTTP pour SearXNG.

```typescript
interface SearxngResult {
  url: string;
  title: string;
  content: string;
  engine: string;
  publishedDate?: string;
  thumbnail?: string;
}

async function search(query: string, options?: SearxngOptions): Promise<SearxngResult[]>;
```

Options : `engines`, `language`, `timeRange`, `categories`.

Rate limiting : max 2 req/s, pause 500ms entre requêtes.
Timeout : 10s par requête.

Dépendances : `core/config` (URL SearXNG)
Testé : **oui** — parsing réponse, rate limiting

### services/anthropic.ts

Client Claude Sonnet 4.6 pour l'analyse et la génération de contenu.

```typescript
interface AnthropicResponse {
  text: string;
  tokensIn: number;
  tokensOut: number;
}

async function complete(
  systemPrompt: string,
  userMessage: string,
  options?: { maxTokens?: number; temperature?: number }
): Promise<AnthropicResponse>;

async function completeWithSearch(
  systemPrompt: string,
  userMessage: string
): Promise<AnthropicResponse>;
```

- `complete()` : appel standard
- `completeWithSearch()` : active l'outil `web_search` natif

Vérifie `BudgetTracker.isApiAllowed()` avant chaque appel.
Enregistre l'usage via `BudgetTracker.recordAnthropicUsage()` après chaque appel.

Dépendances : `@anthropic-ai/sdk`, `core/config`, `budget/tracker`
Testé : non (mock en intégration)

### services/google-ai.ts

Client Google AI pour Imagen (images) et Veo 3.1 (vidéos).

```typescript
// Phase 3
async function generateImage(prompt: string, options: ImageOptions): Promise<GeneratedImage>;

// Phase 5
async function generateVideo(prompt: string, options: VideoOptions): Promise<GeneratedVideo>;
```

Vérifie `BudgetTracker.isApiAllowed()` avant chaque appel.

Dépendances : `@google/genai`, `core/config`, `budget/tracker`
Testé : non (mock en intégration)

### services/postiz.ts

Client Postiz pour upload de médias et scheduling de publications.

```typescript
async function uploadMedia(buffer: Buffer, filename: string): Promise<PostizMedia>;
async function schedulePost(post: PostizPost): Promise<PostizResult>;
async function listIntegrations(): Promise<PostizIntegration[]>;
async function listPosts(start: Date, end: Date): Promise<PostizPost[]>;
```

Dépendances : `core/config` (URL + API key Postiz)
Testé : non (mock en intégration)

## Discord

### discord/message-builder.ts

Construction d'embeds et de boutons. Module purement fonctionnel (pas d'état).
Voir [DISCORD.md](./DISCORD.md) pour l'interface complète.

Dépendances : `discord.js`
Testé : **oui** — construction d'embeds, boutons, pagination

### discord/commands.ts

Enregistrement des commandes slash au boot (par guilde).

```typescript
async function registerCommands(client: Client, guildId: string): Promise<void>;
```

Dépendances : `discord.js`, `@discordjs/rest`
Testé : non

### discord/interactions.ts

Router des interactions (boutons + commandes).
Parse le customId, vérifie les permissions, route vers le handler.

```typescript
async function handleInteraction(interaction: Interaction, ctx: AppContext): Promise<void>;
```

Dépendances : tous les handlers
Testé : non (testé via les handlers)

### discord/permissions.ts

Vérification que l'utilisateur est le propriétaire.

```typescript
function isOwner(interaction: Interaction): boolean;
function requireOwner(interaction: Interaction): void; // throws si pas owner
```

Dépendances : `core/config`
Testé : **oui**

## Veille

Voir [VEILLE.md](./VEILLE.md) pour les specs détaillées.

- `veille/queries.ts` — Testé : **oui**
- `veille/collector.ts` — Testé : **oui**
- `veille/analyzer.ts` — Testé : **oui** (mock Claude)
- `veille/deep-dive.ts` — Testé : non

## Feedback

Voir [FEEDBACK.md](./FEEDBACK.md) pour les specs détaillées.

- `feedback/ratings.ts` — Testé : **oui**
- `feedback/preference-learner.ts` — Testé : **oui**

## Search

### search/engine.ts

Moteur de recherche interne basé sur FTS5.

```typescript
interface SearchResult {
  sourceTable: string;
  sourceId: number;
  title: string;
  snippet: string;
  rank: number;
}

function search(query: string, limit?: number, offset?: number): SearchResult[];
function indexDocument(doc: SearchDocument): void;
function removeDocument(sourceTable: string, sourceId: number): void;
```

Dépendances : `core/database`
Testé : **oui** — indexation, recherche, ranking, accents

## Budget

Voir [BUDGET.md](./BUDGET.md) pour les specs détaillées.

- `budget/tracker.ts` — Testé : **oui**

## Handlers

Les handlers sont les orchestrateurs. Ils connectent les modules.
Pas testés unitairement (testés en intégration si nécessaire).

### handlers/veille.ts

Orchestre le pipeline de veille complet.

### handlers/suggestions.ts

Orchestre la génération de suggestions et la gestion des boutons Go/Modifier/Skip.

### handlers/validation.ts

Orchestre le flux production → publication.

### handlers/publication.ts

Orchestre la publication via Postiz.

### handlers/conversation.ts

Gère les messages texte libre dans #admin.
Parse les commandes naturelles (modifier config, poser une question au bot, etc.).

## Persona

### config/persona.ts

Charge les fichiers SKILL.md et CHRONIQUEUR.md depuis `/app/prompts/`.
Les combine en un system prompt pour Claude.

```typescript
function loadPersona(): string;
```

Retourne le contenu concaténé des deux fichiers .md.
Utilisé par les handlers qui appellent Claude en mode "Chroniqueur".

Dépendances : filesystem (lecture de fichiers)
Testé : non
