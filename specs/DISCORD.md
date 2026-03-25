# Spec — Discord (bot, commandes, boutons, messages)

## Modules

- `src/core/bot.ts` — Client Discord, intents, connexion
- `src/discord/commands.ts` — Registration des commandes slash (par guilde)
- `src/discord/interactions.ts` — Router des interactions (boutons, commandes)
- `src/discord/permissions.ts` — Vérification Lucas-only
- `src/discord/message-builder.ts` — Construction d'embeds + boutons réutilisable

## Bot — Intents requis

```typescript
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});
```

`MessageContent` est nécessaire pour lire les messages texte libre dans #admin.

## Permissions

Toutes les interactions (boutons, commandes, messages dans #admin) sont
restreintes à `DISCORD_OWNER_ID` (Lucas : `256867307853316097`).

```typescript
function isOwner(interaction: Interaction): boolean;
```

Si un autre utilisateur clique un bouton → réponse éphémère "Ces boutons sont réservés au propriétaire."

## Commandes slash (par guilde)

Enregistrées au boot via `REST.put(Routes.applicationGuildCommands(...))`.

| Commande | Options | Description |
|----------|---------|-------------|
| `/search` | `query: string` (required) | Recherche full-text interne |
| `/veille` | — | Force une veille immédiate |
| `/budget` | `period: daily\|weekly\|monthly` (optional, default: all) | Coûts API |
| `/stats` | — | Profil de préférences |
| `/config` | `key: string`, `value: string` | Modifie un paramètre |

## Boutons — Custom IDs

Le custom ID encode l'action et le contexte :

```
{action}:{targetTable}:{targetId}
```

Exemples :
- `thumbup:veille_articles:42` — 👍 sur l'article de veille #42
- `thumbdown:veille_articles:42` — 👎 sur l'article de veille #42
- `transform:veille_articles:42` — 🎯 Transformer en contenu
- `archive:veille_articles:42` — ⏭️ Archiver
- `go:suggestions:15` — ✅ Go sur la suggestion #15
- `modify:suggestions:15` — ✏️ Modifier
- `skip:suggestions:15` — ⏭️ Skip
- `later:suggestions:15` — ⏰ Plus tard
- `validate:publications:8` — ✅ Valider
- `retouch:publications:8` — ✏️ Retoucher
- `publish:publications:8` — 📤 Publier
- `postpone:publications:8` — ⏰ Reporter
- `page:search:{page}` — Pagination recherche

## interactions.ts — Router

```typescript
async function handleInteraction(interaction: Interaction): Promise<void>;
```

1. Si `interaction.isButton()` → parser le customId → router vers le handler
2. Si `interaction.isChatInputCommand()` → router vers la commande
3. Toujours vérifier `isOwner()` en premier

### Réponses aux boutons

| Action | Réponse |
|--------|---------|
| `thumbup` / `thumbdown` | `interaction.update()` — met à jour le message (bouton pressé visuellement) |
| `transform` | `interaction.deferReply()` — traitement long (deep dive + Claude) |
| `archive` | `interaction.update()` — retire les boutons, ajoute "Archivé" |
| `go` | `interaction.deferReply()` — génère le script via Claude |
| `modify` | `interaction.reply()` éphémère — "Qu'est-ce que tu veux modifier ?" |
| `skip` | `interaction.update()` — retire les boutons, ajoute "Skippé" |
| `later` | `interaction.update()` — change le statut |
| `publish` | `interaction.deferReply()` — appel Postiz |
| `postpone` | `interaction.reply()` éphémère — "À quelle date ?" |

## message-builder.ts — Interface

```typescript
interface MessagePayload {
  embeds: EmbedBuilder[];
  components: ActionRowBuilder<ButtonBuilder>[];
}

class MessageBuilder {
  // ─── Veille ───
  static veilleDigest(articles: AnalyzedArticle[], stats: CollectorStats): MessagePayload;
  static veilleArticle(article: AnalyzedArticle): MessagePayload;

  // ─── Suggestions ───
  static suggestion(suggestion: Suggestion): MessagePayload;

  // ─── Production ───
  static production(content: ProductionContent): MessagePayload;

  // ─── Publication ───
  static publication(pub: Publication): MessagePayload;

  // ─── Recherche ───
  static searchResults(results: SearchResult[], query: string, page: number, total: number): MessagePayload;

  // ─── Budget ───
  static budgetReport(metrics: BudgetMetrics): MessagePayload;
  static budgetAlert(alert: BudgetAlert): MessagePayload;

  // ─── Stats ───
  static preferenceProfile(profile: PreferenceEntry[]): MessagePayload;

  // ─── Rapport hebdo ───
  static weeklyReport(data: WeeklyReportData): MessagePayload;

  // ─── Utilitaire ───
  static error(message: string): MessagePayload;
  static success(message: string): MessagePayload;
  static info(message: string): MessagePayload;
}
```

## Palette de couleurs (embeds)

Issue de la DA Tumulte :

```typescript
const COLORS = {
  PRIMARY: 0xC8A87C,    // Doré — messages principaux
  SUCCESS: 0x57F287,    // Vert Discord — confirmations
  WARNING: 0xFEE75C,    // Jaune — alertes budget
  ERROR: 0xED4245,      // Rouge — erreurs
  INFO: 0x5865F2,       // Blurple Discord — info
  VEILLE: 0xC8A87C,     // Doré — digests veille
  SUGGESTION: 0x5865F2, // Blurple — suggestions
  PRODUCTION: 0xEB459E, // Rose — production
  PUBLICATION: 0x57F287, // Vert — publication
} as const;
```

## Channels — Résolution

Les channel IDs sont chargés depuis les variables d'environnement.
Validés au boot — si un channel est introuvable, le bot refuse de démarrer.

```typescript
interface ChannelMap {
  veille: TextChannel;
  idees: TextChannel;
  production: TextChannel;
  publication: TextChannel;
  logs: TextChannel;
  admin: TextChannel;
  bugs: TextChannel;      // Lecture seule
  feedback: TextChannel;  // Lecture seule
}

async function resolveChannels(client: Client): Promise<ChannelMap>;
```

## Graceful shutdown

```typescript
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

async function shutdown(): Promise<void> {
  // 1. Arrêter les cron jobs
  // 2. Fermer la connexion SQLite
  // 3. Détruire le client Discord
  // 4. process.exit(0)
}
```
