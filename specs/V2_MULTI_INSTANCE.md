# Spec V2 — Multi-instance

## Modèle

Un seul process Node.js, un seul bot Discord, N instances par serveur Discord.
Chaque instance a sa propre catégorie Discord, sa propre DB SQLite, son propre persona, ses propres crons.

## DB globale (`data/bot.db`)

```sql
-- Registre des instances
CREATE TABLE instances (
  id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  name TEXT NOT NULL,
  category_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  cron_offset_minutes INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Channels par instance
CREATE TABLE instance_channels (
  instance_id TEXT NOT NULL,
  channel_type TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message_id TEXT,
  PRIMARY KEY (instance_id, channel_type),
  FOREIGN KEY (instance_id) REFERENCES instances(id)
);

-- Secrets chiffrés
CREATE TABLE instance_secrets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  instance_id TEXT NOT NULL,
  key_type TEXT NOT NULL,
  encrypted_value TEXT NOT NULL,
  iv TEXT NOT NULL,
  auth_tag TEXT NOT NULL,
  validated_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(instance_id, key_type)
);

-- Sessions wizard
CREATE TABLE wizard_sessions (
  id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  step TEXT NOT NULL,
  data TEXT NOT NULL,
  conversation_history TEXT NOT NULL,
  tokens_used INTEGER NOT NULL DEFAULT 0,
  iteration_count INTEGER NOT NULL DEFAULT 0,
  expires_at DATETIME NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

## DB per-instance (`data/instances/{id}/database.db`)

Contient les 11 tables actuelles (veille_articles, suggestions, publications, media, conversations, metrics, feedback_ratings, preference_profiles, search_index, cron_runs, budget_alerts) PLUS :

- `persona` (singleton)
- `veille_categories`
- `config_overrides`
- `config_history`

## InstanceContext

Objet central injecté dans tous les handlers :

```typescript
interface InstanceContext {
  readonly id: string;
  readonly name: string;
  readonly config: InstanceConfig;
  readonly db: SqliteDatabase;
  readonly persona: string;
  readonly channels: InstanceChannelMap;
  readonly secrets: InstanceSecrets;
}

interface InstanceChannelMap {
  readonly dashboard: TextChannel;
  readonly recherche: TextChannel;
  readonly veille: TextChannel;
  readonly idees: TextChannel;
  readonly production: TextChannel;
  readonly publication: TextChannel;
  readonly logs: TextChannel;
}
```

## InstanceRegistry

Le registry charge toutes les instances au boot et maintient un index de routing.

```typescript
class InstanceRegistry {
  private instances: Map<string, InstanceContext>;
  private channelIndex: Map<string, string>;  // channelId → instanceId

  // Chargement au boot
  async loadAll(): Promise<void>;

  // Routing
  resolveFromChannel(channelId: string): InstanceContext | undefined;
  resolveFromInteraction(interaction: Interaction): InstanceContext | undefined;

  // CRUD
  async create(data: CreateInstanceData): Promise<InstanceContext>;
  async pause(id: string): Promise<void>;
  async resume(id: string): Promise<void>;
  async delete(id: string): Promise<void>;

  // Liste
  getAll(): InstanceContext[];
  getByGuild(guildId: string): InstanceContext[];
}
```

## Routing

Quand une interaction arrive :
1. Extraire le `channelId` de l'interaction
2. Chercher dans `channelIndex` → obtenir l'`instanceId`
3. Charger l'`InstanceContext` correspondant
4. Exécuter le handler avec le context

Si le channel n'appartient à aucune instance → ignorer (pas une erreur).

Pour les DMs (onboarding) : le context est déterminé par la session wizard en cours.

## Scheduler multi-instance

Chaque instance a ses propres crons. Au boot :

```typescript
for (const ctx of registry.getAll()) {
  if (ctx.config.status === 'active') {
    startInstanceScheduler(ctx);
  }
}
```

Les crons sont décalés automatiquement via `cron_offset_minutes`.

## Gestion des événements Discord

### channelDelete

Si un channel d'une instance est supprimé :
1. Mettre à jour `instance_channels` (retirer l'entrée)
2. Poster une alerte dans `#dashboard` (si celui-ci existe encore)
3. Proposer [Recréer le channel] ou [Mettre en pause l'instance]

### guildDelete

Si le bot est éjecté d'un serveur :
1. Mettre toutes les instances de ce guild en status `archived`
2. Arrêter les crons
3. Ne PAS supprimer les données (l'utilisateur pourrait réinviter le bot)

## Limites

- Max ~8 instances par serveur (500 channels / 7 channels par instance ≈ 70, mais les catégories sont limitées à 50)
- Mémoire : chaque instance = 1 connexion SQLite + 1 scheduler = ~5-10 MB
- Rate limits Discord : 50 req/s partagées entre toutes les instances → queue globale
- Rate limits Anthropic : RPM/TPM partagés → fair scheduling entre instances

## Pause / Resume

- **Pause** : arrête tous les crons, le routing continue (boutons déjà postés restent fonctionnels), bandeau "⏸️ En pause" sur le dashboard
- **Resume** : redémarre les crons, vérifie le rattrapage des jobs manqués
