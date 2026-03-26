# Spec V2 — Configuration

## Les 3 couches de config

### Couche 1 — Infrastructure (`.env`, le déployeur)

```env
DISCORD_TOKEN=MTIzNDU2Nzg5.xxx
MASTER_ENCRYPTION_KEY=a1b2c3d4...   # openssl rand -hex 32
POSTIZ_URL=https://postiz.mondomaine.com
```

Optionnel dev :
```env
DRY_RUN=true
MOCK_APIS=true
LOG_LEVEL=debug
NODE_ENV=development
```

Variables auto-générées au premier lancement :
```env
POSTIZ_JWT_SECRET=   # Généré par install.sh
```

SearXNG est interne au docker-compose, passé en env via docker-compose.yml (pas configurable par l'utilisateur) :
```
SEARXNG_URL=http://searxng:8080  # Défini dans docker-compose.yml
```

### Couche 2 — Secrets per-instance (DB chiffrée)

Table `instance_secrets` dans la DB globale `bot.db` :

```sql
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
```

Types de clés : `anthropic`, `google_ai`, `postiz_api_key`.

Chiffrement : AES-256-GCM avec `MASTER_ENCRYPTION_KEY`.

### Couche 3 — Config fonctionnelle per-instance (DB instance)

Tables dans la DB de chaque instance :

```sql
-- Persona (singleton)
CREATE TABLE persona (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  content TEXT NOT NULL,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Catégories de veille
CREATE TABLE veille_categories (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  keywords_en TEXT NOT NULL,       -- JSON array
  keywords_fr TEXT NOT NULL,       -- JSON array
  engines TEXT NOT NULL,           -- JSON array
  max_age_hours INTEGER NOT NULL DEFAULT 72,
  is_active BOOLEAN NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0
);

-- Config overrides runtime
CREATE TABLE config_overrides (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_by TEXT
);

-- Historique des changements
CREATE TABLE config_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT NOT NULL,
  changed_by TEXT NOT NULL,
  changed_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

## Schéma Zod pour l'infrastructure

```typescript
const infraSchema = z.object({
  DISCORD_TOKEN: z.string().min(1),
  MASTER_ENCRYPTION_KEY: z.string().length(64),
  POSTIZ_URL: z.string().url(),
  LOG_LEVEL: z.enum(['fatal','error','warn','info','debug','trace']).default('info'),
  NODE_ENV: z.enum(['production','development','test']).default('production'),
  DRY_RUN: z.coerce.boolean().default(false),
  MOCK_APIS: z.coerce.boolean().default(false),
});
```

## Interface TypeScript de la config d'instance

```typescript
interface InstanceConfig {
  name: string;
  persona: string;
  categories: VeilleCategory[];
  scheduler: {
    veilleCron: string;
    suggestionsCron: string;
    rapportCron: string;
  };
  budget: {
    dailyCents: number;
    weeklyCents: number;
    monthlyCents: number;
  };
  content: {
    suggestionsPerCycle: number;
    minScoreToPropose: number;
    platforms: string[];
    formats: string[];
    pillars: string[];
  };
  theme: {
    primary: number;
    success: number;
    warning: number;
    error: number;
    info: number;
    veille: number;
    suggestion: number;
    production: number;
    publication: number;
  };
}
```

## Defaults de la config d'instance

```typescript
const DEFAULT_INSTANCE_CONFIG: Omit<InstanceConfig, 'name' | 'persona' | 'categories'> = {
  scheduler: {
    veilleCron: '0 7 * * *',
    suggestionsCron: '0 8 * * *',
    rapportCron: '0 21 * * 0',
  },
  budget: {
    dailyCents: 300,
    weeklyCents: 1500,
    monthlyCents: 5000,
  },
  content: {
    suggestionsPerCycle: 3,
    minScoreToPropose: 6,
    platforms: ['tiktok', 'instagram'],
    formats: ['reel', 'carousel', 'story', 'post'],
    pillars: ['trend', 'tuto', 'community', 'product'],
  },
  theme: {
    primary: 0xc8a87c,
    success: 0x57f287,
    warning: 0xfee75c,
    error: 0xed4245,
    info: 0x5865f2,
    veille: 0xc8a87c,
    suggestion: 0x5865f2,
    production: 0xeb459e,
    publication: 0x57f287,
  },
};
```

## Classification des paramètres pour le reload

| Type | Paramètres | Comportement |
|------|-----------|--------------|
| **Hot-reload** | crons, seuils budget, nombre de suggestions, score minimum, thème | Appliqués immédiatement |
| **Warm-reload** | persona, catégories de veille | Appliqués au prochain cycle, pas au milieu d'un cycle en cours |
| **Cold-reload** | clés API, URLs de services | Confirmation requise + attente fin des opérations en cours |

## Rollback

- Table `config_history` enregistre chaque modification
- Bouton `[Annuler dernier changement]` dans la page Config du dashboard
- Bouton `[Reset aux défauts]` pour supprimer tous les overrides DB et revenir aux defaults
- Validation des crons : fréquence minimum 1h pour la veille (anti-spam)

## Priorité des valeurs

Règle : **la DB gagne toujours sur les defaults**.

```
1. config_overrides (DB) → si existe, utilisé
2. Valeur par défaut (DEFAULT_INSTANCE_CONFIG) → sinon
```

Le YAML n'existe plus. Tout passe par le wizard ou le dashboard.
