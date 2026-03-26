import type { Database } from 'better-sqlite3';

interface Migration {
  readonly name: string;
  readonly up: string;
}

const migrations: readonly Migration[] = [
  {
    name: '001_create_veille_articles',
    up: `
      CREATE TABLE IF NOT EXISTS veille_articles (
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
      CREATE INDEX IF NOT EXISTS idx_veille_status ON veille_articles(status);
      CREATE INDEX IF NOT EXISTS idx_veille_collected ON veille_articles(collected_at);
      CREATE INDEX IF NOT EXISTS idx_veille_score ON veille_articles(score DESC);
      CREATE INDEX IF NOT EXISTS idx_veille_category ON veille_articles(category);
    `,
  },
  {
    name: '002_create_suggestions',
    up: `
      CREATE TABLE IF NOT EXISTS suggestions (
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
      CREATE INDEX IF NOT EXISTS idx_suggestions_status ON suggestions(status);
    `,
  },
  {
    name: '003_create_publications',
    up: `
      CREATE TABLE IF NOT EXISTS publications (
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
      CREATE INDEX IF NOT EXISTS idx_publications_status ON publications(status);
      CREATE INDEX IF NOT EXISTS idx_publications_scheduled ON publications(scheduled_at);
    `,
  },
  {
    name: '004_create_media',
    up: `
      CREATE TABLE IF NOT EXISTS media (
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
    `,
  },
  {
    name: '005_create_conversations',
    up: `
      CREATE TABLE IF NOT EXISTS conversations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        tokens_in INTEGER NOT NULL DEFAULT 0,
        tokens_out INTEGER NOT NULL DEFAULT 0,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_conversations_channel ON conversations(channel);
      CREATE INDEX IF NOT EXISTS idx_conversations_created ON conversations(created_at);
    `,
  },
  {
    name: '006_create_metrics',
    up: `
      CREATE TABLE IF NOT EXISTS metrics (
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
    `,
  },
  {
    name: '007_create_feedback_ratings',
    up: `
      CREATE TABLE IF NOT EXISTS feedback_ratings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        target_table TEXT NOT NULL,
        target_id INTEGER NOT NULL,
        rating INTEGER NOT NULL,
        discord_user_id TEXT NOT NULL,
        rated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(target_table, target_id, discord_user_id)
      );
      CREATE INDEX IF NOT EXISTS idx_feedback_target ON feedback_ratings(target_table, target_id);
    `,
  },
  {
    name: '008_create_preference_profiles',
    up: `
      CREATE TABLE IF NOT EXISTS preference_profiles (
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
      CREATE INDEX IF NOT EXISTS idx_preferences_dimension ON preference_profiles(dimension);
      CREATE INDEX IF NOT EXISTS idx_preferences_score ON preference_profiles(score DESC);
    `,
  },
  {
    name: '009_create_search_index',
    up: `
      CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(
        title,
        snippet,
        content,
        source_table,
        source_id UNINDEXED,
        tokenize='unicode61 remove_diacritics 2'
      );
    `,
  },
  {
    name: '010_create_cron_runs',
    up: `
      CREATE TABLE IF NOT EXISTS cron_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_name TEXT UNIQUE NOT NULL,
        last_run_at DATETIME NOT NULL,
        next_run_at DATETIME,
        status TEXT NOT NULL DEFAULT 'success',
        error TEXT
      );
    `,
  },
  {
    name: '011_create_budget_alerts',
    up: `
      CREATE TABLE IF NOT EXISTS budget_alerts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        period TEXT NOT NULL,
        threshold_percent INTEGER NOT NULL,
        cost_cents INTEGER NOT NULL,
        budget_cents INTEGER NOT NULL,
        triggered_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        discord_message_id TEXT
      );
    `,
  },
  // ─── V2 Phase 1 : Config dynamique ───
  {
    name: '012_create_persona',
    up: `
      CREATE TABLE IF NOT EXISTS persona (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        content TEXT NOT NULL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `,
  },
  {
    name: '013_create_veille_categories',
    up: `
      CREATE TABLE IF NOT EXISTS veille_categories (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        keywords_en TEXT NOT NULL DEFAULT '[]',
        keywords_fr TEXT NOT NULL DEFAULT '[]',
        engines TEXT NOT NULL DEFAULT '[]',
        max_age_hours INTEGER NOT NULL DEFAULT 72,
        is_active INTEGER NOT NULL DEFAULT 1,
        sort_order INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_veille_categories_active ON veille_categories(is_active)
    `,
  },
  {
    name: '014_create_config_overrides',
    up: `
      CREATE TABLE IF NOT EXISTS config_overrides (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_by TEXT
      )
    `,
  },
  {
    name: '015_create_config_history',
    up: `
      CREATE TABLE IF NOT EXISTS config_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        key TEXT NOT NULL,
        old_value TEXT,
        new_value TEXT NOT NULL,
        changed_by TEXT NOT NULL,
        changed_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_config_history_key ON config_history(key);
      CREATE INDEX IF NOT EXISTS idx_config_history_date ON config_history(changed_at DESC)
    `,
  },
];

export function runMigrations(db: Database): void {
  db.prepare(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `).run();

  const applied = new Set(
    (db.prepare('SELECT name FROM _migrations').all() as Array<{ name: string }>).map(
      (row) => row.name,
    ),
  );

  const insertMigration = db.prepare('INSERT INTO _migrations (name) VALUES (?)');

  for (const migration of migrations) {
    if (applied.has(migration.name)) {
      continue;
    }

    db.transaction(() => {
      const statements = migration.up
        .split(';')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);

      for (const statement of statements) {
        db.prepare(statement).run();
      }

      insertMigration.run(migration.name);
    })();
  }
}
