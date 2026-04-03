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
  // ─── V2 Phase : Content Derivation ───
  {
    name: '016_create_derivation_trees',
    up: `
      CREATE TABLE IF NOT EXISTS derivation_trees (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        suggestion_id INTEGER NOT NULL REFERENCES suggestions(id),
        master_text TEXT NOT NULL,
        master_image_prompt TEXT,
        master_media_id INTEGER REFERENCES media(id),
        status TEXT NOT NULL DEFAULT 'draft',
        discord_message_id TEXT,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        validated_at DATETIME,
        invalidated_at DATETIME
      );
      CREATE INDEX IF NOT EXISTS idx_derivation_trees_suggestion ON derivation_trees(suggestion_id);
      CREATE INDEX IF NOT EXISTS idx_derivation_trees_status ON derivation_trees(status)
    `,
  },
  {
    name: '017_create_derivations',
    up: `
      CREATE TABLE IF NOT EXISTS derivations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tree_id INTEGER NOT NULL REFERENCES derivation_trees(id),
        platform TEXT NOT NULL,
        format TEXT NOT NULL,
        adapted_text TEXT,
        media_type TEXT,
        media_prompt TEXT,
        media_id INTEGER REFERENCES media(id),
        status TEXT NOT NULL DEFAULT 'pending',
        postiz_post_id TEXT,
        discord_thread_id TEXT,
        discord_message_id TEXT,
        scheduled_at DATETIME,
        published_at DATETIME,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        validated_at DATETIME,
        rejected_at DATETIME,
        modification_notes TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_derivations_tree ON derivations(tree_id);
      CREATE INDEX IF NOT EXISTS idx_derivations_status ON derivations(status);
      CREATE INDEX IF NOT EXISTS idx_derivations_platform ON derivations(platform)
    `,
  },
  {
    name: '018_create_generation_queue',
    up: `
      CREATE TABLE IF NOT EXISTS generation_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        derivation_id INTEGER REFERENCES derivations(id),
        tree_id INTEGER NOT NULL REFERENCES derivation_trees(id),
        priority INTEGER NOT NULL DEFAULT 0,
        payload TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued',
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 3,
        result TEXT,
        error TEXT,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        started_at DATETIME,
        completed_at DATETIME
      );
      CREATE INDEX IF NOT EXISTS idx_queue_status ON generation_queue(status, priority DESC, created_at)
    `,
  },
  {
    name: '019_create_social_metrics',
    up: `
      CREATE TABLE IF NOT EXISTS social_metrics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        publication_id INTEGER REFERENCES publications(id),
        derivation_id INTEGER REFERENCES derivations(id),
        postiz_post_id TEXT NOT NULL,
        platform TEXT NOT NULL,
        metric_name TEXT NOT NULL,
        metric_value INTEGER NOT NULL DEFAULT 0,
        metric_date DATE NOT NULL,
        collected_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_social_metrics_publication ON social_metrics(publication_id);
      CREATE INDEX IF NOT EXISTS idx_social_metrics_platform_date ON social_metrics(platform, metric_date);
      CREATE INDEX IF NOT EXISTS idx_social_metrics_name ON social_metrics(metric_name)
    `,
  },
  {
    name: '020_create_optimal_slots',
    up: `
      CREATE TABLE IF NOT EXISTS optimal_slots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        platform TEXT NOT NULL,
        day_of_week INTEGER NOT NULL,
        hour INTEGER NOT NULL,
        score REAL NOT NULL DEFAULT 0.0,
        sample_size INTEGER NOT NULL DEFAULT 0,
        season_context TEXT,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(platform, day_of_week, hour)
      );
      CREATE INDEX IF NOT EXISTS idx_optimal_slots_platform ON optimal_slots(platform, score DESC)
    `,
  },
  {
    name: '021_add_derivation_refs_to_publications',
    up: `
      ALTER TABLE publications ADD COLUMN derivation_id INTEGER REFERENCES derivations(id);
      ALTER TABLE publications ADD COLUMN tree_id INTEGER REFERENCES derivation_trees(id)
    `,
  },
  // ─── V2 Phase : Multi-provider LLM ───
  {
    name: '022_add_llm_metrics',
    up: `
      ALTER TABLE metrics ADD COLUMN llm_cost_cents INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE metrics ADD COLUMN llm_provider TEXT;
      ALTER TABLE metrics ADD COLUMN llm_model TEXT
    `,
  },
  // ─── V2 Phase : Veille V2 (multi-source, resurfacing, scheduler) ───
  {
    name: '023_create_veille_sources',
    up: `
      CREATE TABLE IF NOT EXISTS veille_sources (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        config TEXT NOT NULL DEFAULT '{}',
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(type)
      )
    `,
  },
  {
    name: '024_create_schedule_config',
    up: `
      CREATE TABLE IF NOT EXISTS schedule_config (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        mode TEXT NOT NULL DEFAULT 'daily',
        veille_day INTEGER,
        veille_hour INTEGER NOT NULL DEFAULT 7,
        publication_days TEXT NOT NULL DEFAULT '[1,2,3,4,5]',
        suggestions_per_cycle INTEGER NOT NULL DEFAULT 3,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `,
  },
  {
    name: '025_add_veille_articles_v2_columns',
    up: `
      ALTER TABLE veille_articles ADD COLUMN skip_count INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE veille_articles ADD COLUMN deep_dive_content TEXT;
      ALTER TABLE veille_articles ADD COLUMN source_type TEXT NOT NULL DEFAULT 'searxng';
      ALTER TABLE veille_articles ADD COLUMN resurfaced_count INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE veille_articles ADD COLUMN last_resurfaced_at DATETIME
    `,
  },
  {
    name: '026_create_instance_profile',
    up: `
      CREATE TABLE IF NOT EXISTS instance_profile (
        id               INTEGER PRIMARY KEY DEFAULT 1,
        project_name     TEXT NOT NULL,
        project_niche    TEXT NOT NULL,
        project_description TEXT NOT NULL DEFAULT '',
        project_language TEXT NOT NULL DEFAULT 'fr',
        project_url      TEXT,
        target_platforms  TEXT NOT NULL DEFAULT '[]',
        target_formats    TEXT NOT NULL DEFAULT '[]',
        content_types     TEXT NOT NULL DEFAULT '[]',
        include_domains   TEXT NOT NULL DEFAULT '[]',
        exclude_domains   TEXT NOT NULL DEFAULT '[]',
        negative_keywords TEXT NOT NULL DEFAULT '[]',
        pillars           TEXT NOT NULL DEFAULT '["trend","tuto","community","product"]',
        onboarding_context TEXT NOT NULL DEFAULT '',
        calibrated_examples TEXT,
        calibrated_at       DATETIME,
        created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `,
  },
  {
    name: '027_add_youtube_reddit_metrics',
    up: `
      ALTER TABLE metrics ADD COLUMN youtube_quota_units INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE metrics ADD COLUMN reddit_requests INTEGER NOT NULL DEFAULT 0
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
