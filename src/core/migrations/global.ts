import type { Database } from 'better-sqlite3';

interface Migration {
  readonly name: string;
  readonly up: string;
}

const globalMigrations: readonly Migration[] = [
  {
    name: 'g001_create_instances',
    up: `
      CREATE TABLE IF NOT EXISTS instances (
        id TEXT PRIMARY KEY,
        guild_id TEXT NOT NULL,
        name TEXT NOT NULL,
        category_id TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        cron_offset_minutes INTEGER NOT NULL DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_instances_guild ON instances(guild_id);
      CREATE INDEX IF NOT EXISTS idx_instances_status ON instances(status)
    `,
  },
  {
    name: 'g002_create_instance_channels',
    up: `
      CREATE TABLE IF NOT EXISTS instance_channels (
        instance_id TEXT NOT NULL,
        channel_type TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        message_id TEXT,
        PRIMARY KEY (instance_id, channel_type),
        FOREIGN KEY (instance_id) REFERENCES instances(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_instance_channels_channel ON instance_channels(channel_id)
    `,
  },
  {
    name: 'g003_create_instance_secrets',
    up: `
      CREATE TABLE IF NOT EXISTS instance_secrets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        instance_id TEXT NOT NULL,
        key_type TEXT NOT NULL,
        encrypted_value TEXT NOT NULL,
        iv TEXT NOT NULL,
        auth_tag TEXT NOT NULL,
        validated_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(instance_id, key_type),
        FOREIGN KEY (instance_id) REFERENCES instances(id) ON DELETE CASCADE
      )
    `,
  },
  {
    name: 'g004_create_wizard_sessions',
    up: `
      CREATE TABLE IF NOT EXISTS wizard_sessions (
        id TEXT PRIMARY KEY,
        guild_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        step TEXT NOT NULL,
        data TEXT NOT NULL DEFAULT '{}',
        conversation_history TEXT NOT NULL DEFAULT '[]',
        tokens_used INTEGER NOT NULL DEFAULT 0,
        iteration_count INTEGER NOT NULL DEFAULT 0,
        expires_at DATETIME NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_wizard_guild ON wizard_sessions(guild_id);
      CREATE INDEX IF NOT EXISTS idx_wizard_user ON wizard_sessions(user_id)
    `,
  },
];

export function runGlobalMigrations(db: Database): void {
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

  for (const migration of globalMigrations) {
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
