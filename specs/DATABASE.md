# Spec — Database (SQLite + FTS5)

## Module

`src/core/database.ts`

## Responsabilités

- Initialiser la connexion SQLite (better-sqlite3)
- Exécuter les migrations au démarrage
- Fournir des méthodes typées pour chaque table
- Gérer l'index FTS5 (insertion, mise à jour, suppression)

## Fichier base de données

`/app/data/tumulte.db` (volume Docker `bot_data`)

## Migrations

Les migrations sont exécutées séquentiellement au boot.
Chaque migration est un fichier dans `src/core/migrations/`.
Une table `_migrations` track celles déjà appliquées.

```sql
CREATE TABLE IF NOT EXISTS _migrations (
    id INTEGER PRIMARY KEY,
    name TEXT UNIQUE NOT NULL,
    applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

## Schéma complet

### veille_articles

Stocke chaque article trouvé par SearXNG et analysé par Claude.

```sql
CREATE TABLE veille_articles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url TEXT UNIQUE NOT NULL,
    title TEXT NOT NULL,
    snippet TEXT,
    source TEXT NOT NULL,
    language TEXT NOT NULL DEFAULT 'en',
    category TEXT NOT NULL,
    score INTEGER NOT NULL DEFAULT 0,
    pillar TEXT,
    suggested_angle TEXT,
    translated_title TEXT,
    translated_snippet TEXT,
    thumbnail_url TEXT,
    collected_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    published_at DATETIME,
    discord_message_id TEXT,
    discord_thread_id TEXT,
    status TEXT NOT NULL DEFAULT 'new'
);

CREATE INDEX idx_veille_status ON veille_articles(status);
CREATE INDEX idx_veille_collected ON veille_articles(collected_at);
CREATE INDEX idx_veille_score ON veille_articles(score DESC);
CREATE INDEX idx_veille_category ON veille_articles(category);
```

**Valeurs `status`** : `new`, `proposed`, `transformed`, `archived`

**Valeurs `category`** : `ttrpg_news`, `ttrpg_memes`, `streaming`, `tiktok_trends`, `influencers`, `vtt_tech`, `community_fr`, `facebook_groups`, `competition`

**Valeurs `pillar`** : `trend`, `tuto`, `community`, `product`

### suggestions

Contenus générés proposés à Lucas dans #idées.

```sql
CREATE TABLE suggestions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    veille_article_id INTEGER REFERENCES veille_articles(id),
    content TEXT NOT NULL,
    pillar TEXT NOT NULL,
    platform TEXT NOT NULL,
    format TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    discord_message_id TEXT,
    modification_notes TEXT,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    decided_at DATETIME
);

CREATE INDEX idx_suggestions_status ON suggestions(status);
```

**Valeurs `status`** : `pending`, `go`, `modified`, `skipped`, `later`

**Valeurs `platform`** : `tiktok`, `instagram`, `both`

**Valeurs `format`** : `carousel`, `reel`, `story`, `post`

### publications

Posts publiés ou programmés via Postiz.

```sql
CREATE TABLE publications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    suggestion_id INTEGER REFERENCES suggestions(id),
    postiz_post_id TEXT,
    platform TEXT NOT NULL,
    scheduled_at DATETIME,
    published_at DATETIME,
    content TEXT NOT NULL,
    media_ids TEXT,
    status TEXT NOT NULL DEFAULT 'draft',
    metrics_views INTEGER,
    metrics_likes INTEGER,
    metrics_comments INTEGER,
    metrics_shares INTEGER,
    metrics_saves INTEGER,
    metrics_updated_at DATETIME,
    discord_message_id TEXT,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_publications_status ON publications(status);
CREATE INDEX idx_publications_scheduled ON publications(scheduled_at);
```

**Valeurs `status`** : `draft`, `scheduled`, `published`, `failed`

### media

Médias générés (images Imagen, segments Veo, uploads manuels).

```sql
CREATE TABLE media (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    generator TEXT NOT NULL,
    prompt TEXT,
    postiz_id TEXT,
    postiz_path TEXT,
    local_path TEXT,
    naming TEXT NOT NULL,
    publication_id INTEGER REFERENCES publications(id),
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

**Valeurs `type`** : `image`, `video_segment`, `video_final`

**Valeurs `generator`** : `imagen`, `veo`, `manual`

### conversations

Historique des échanges avec Claude pour la mémoire contextuelle.

```sql
CREATE TABLE conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    tokens_in INTEGER NOT NULL DEFAULT 0,
    tokens_out INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_conversations_channel ON conversations(channel);
CREATE INDEX idx_conversations_created ON conversations(created_at);
```

### metrics

Coûts API agrégés par jour.

```sql
CREATE TABLE metrics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date DATE UNIQUE NOT NULL,
    anthropic_tokens_in INTEGER NOT NULL DEFAULT 0,
    anthropic_tokens_out INTEGER NOT NULL DEFAULT 0,
    anthropic_cost_cents INTEGER NOT NULL DEFAULT 0,
    google_image_count INTEGER NOT NULL DEFAULT 0,
    google_video_seconds INTEGER NOT NULL DEFAULT 0,
    google_cost_cents INTEGER NOT NULL DEFAULT 0,
    searxng_queries INTEGER NOT NULL DEFAULT 0,
    articles_collected INTEGER NOT NULL DEFAULT 0,
    articles_proposed INTEGER NOT NULL DEFAULT 0,
    publications_count INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

### feedback_ratings

Feedback 👍/👎 de Lucas sur les articles et suggestions.

```sql
CREATE TABLE feedback_ratings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    target_table TEXT NOT NULL,
    target_id INTEGER NOT NULL,
    rating INTEGER NOT NULL,
    discord_user_id TEXT NOT NULL,
    rated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(target_table, target_id, discord_user_id)
);

CREATE INDEX idx_feedback_target ON feedback_ratings(target_table, target_id);
```

**Valeurs `target_table`** : `veille_articles`, `suggestions`

**Valeurs `rating`** : `1` (👍) ou `-1` (👎)

### preference_profiles

Profil de préférences agrégé, recalculé quotidiennement.

```sql
CREATE TABLE preference_profiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dimension TEXT NOT NULL,
    value TEXT NOT NULL,
    positive_count INTEGER NOT NULL DEFAULT 0,
    negative_count INTEGER NOT NULL DEFAULT 0,
    total_count INTEGER NOT NULL DEFAULT 0,
    score REAL NOT NULL DEFAULT 0.0,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(dimension, value)
);

CREATE INDEX idx_preferences_dimension ON preference_profiles(dimension);
CREATE INDEX idx_preferences_score ON preference_profiles(score DESC);
```

**Valeurs `dimension`** : `source`, `category`, `keyword`, `pillar`

**Valeurs `score`** : entre -1.0 et +1.0

### search_index (FTS5)

Index full-text pour la recherche interne via `/search`.

```sql
CREATE VIRTUAL TABLE search_index USING fts5(
    title,
    snippet,
    content,
    source_table,
    source_id UNINDEXED,
    tokenize='unicode61 remove_diacritics 2'
);
```

`remove_diacritics 2` permet de chercher "éléphant" avec "elephant" et vice-versa.

### cron_runs

Dernier run de chaque job cron, pour le rattrapage au boot.

```sql
CREATE TABLE cron_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_name TEXT UNIQUE NOT NULL,
    last_run_at DATETIME NOT NULL,
    next_run_at DATETIME,
    status TEXT NOT NULL DEFAULT 'success',
    error TEXT
);
```

### budget_alerts

Historique des alertes budget déclenchées.

```sql
CREATE TABLE budget_alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    period TEXT NOT NULL,
    threshold_percent INTEGER NOT NULL,
    cost_cents INTEGER NOT NULL,
    budget_cents INTEGER NOT NULL,
    triggered_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    discord_message_id TEXT
);
```

## Interface TypeScript

```typescript
interface Database {
  // ─── Veille ───
  insertArticle(article: NewVeilleArticle): VeilleArticle;
  getArticleByUrl(url: string): VeilleArticle | undefined;
  getRecentArticles(since: Date): VeilleArticle[];
  updateArticleStatus(id: number, status: ArticleStatus): void;

  // ─── Suggestions ───
  insertSuggestion(suggestion: NewSuggestion): Suggestion;
  updateSuggestionStatus(id: number, status: SuggestionStatus): void;
  getPendingSuggestions(): Suggestion[];

  // ─── Publications ───
  insertPublication(pub: NewPublication): Publication;
  updatePublicationMetrics(id: number, metrics: PublicationMetrics): void;
  getPublicationsForWeek(weekStart: Date): Publication[];

  // ─── Feedback ───
  upsertRating(targetTable: string, targetId: number, rating: number, userId: string): void;
  getRatingsForTarget(targetTable: string, targetId: number): FeedbackRating[];

  // ─── Preferences ───
  recalculatePreferences(): void;
  getPreferenceProfile(): PreferenceProfile[];

  // ─── Search ───
  indexDocument(doc: SearchDocument): void;
  search(query: string, limit?: number, offset?: number): SearchResult[];

  // ─── Cron ───
  recordCronRun(jobName: string, status: string, error?: string): void;
  getLastCronRun(jobName: string): CronRun | undefined;

  // ─── Metrics ───
  incrementMetrics(date: Date, deltas: Partial<MetricsRow>): void;
  getMetricsForPeriod(start: Date, end: Date): MetricsRow[];

  // ─── Budget ───
  recordBudgetAlert(alert: NewBudgetAlert): void;
}
```

## Pragmas SQLite

Appliqués à l'ouverture de la connexion :

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
```

- **WAL** : meilleure performance en lecture concurrente
- **NORMAL** : bon compromis performance/sécurité
- **foreign_keys** : intégrité référentielle
- **busy_timeout** : évite les erreurs SQLITE_BUSY
