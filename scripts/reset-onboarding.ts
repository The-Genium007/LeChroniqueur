/**
 * Resets onboarding: deletes wizard sessions, instances, channels Discord, and instance DBs.
 * The bot can then be re-onboarded from scratch with /setup.
 *
 * Usage: npx tsx scripts/reset-onboarding.ts
 */

import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';

// ─── Load env for Discord token ───
const envPath = path.join(process.cwd(), '.env.dev');
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf-8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex);
    let value = trimmed.slice(eqIndex + 1);
    // Strip quotes
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

const DISCORD_TOKEN = process.env['DISCORD_TOKEN'] ?? '';
const dbPath = path.join(process.cwd(), 'data', 'bot.db');

if (!fs.existsSync(dbPath)) {
  console.log('❌ Database not found at', dbPath);
  process.exit(1);
}

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

// ─── Delete Discord channels via REST API ───

async function deleteDiscordChannel(channelId: string): Promise<boolean> {
  if (DISCORD_TOKEN.length === 0) return false;

  try {
    const response = await fetch(`https://discord.com/api/v10/channels/${channelId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bot ${DISCORD_TOKEN}` },
    });
    return response.ok || response.status === 404; // 404 = already deleted
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  console.log('🔄 Resetting onboarding...\n');

  // 1. Get all instances
  const instancesExist = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='instances'").get();
  if (instancesExist !== undefined) {
    const instances = db.prepare('SELECT id, name, category_id FROM instances').all() as Array<{
      id: string;
      name: string;
      category_id: string;
    }>;

    console.log(`Found ${String(instances.length)} instance(s).`);

    for (const instance of instances) {
      console.log(`\n📦 Instance: ${instance.name} (${instance.id})`);

      // Get channels for this instance
      const channels = db.prepare('SELECT channel_id, channel_type FROM instance_channels WHERE instance_id = ?')
        .all(instance.id) as Array<{ channel_id: string; channel_type: string }>;

      // Delete each channel via Discord API
      for (const ch of channels) {
        const ok = await deleteDiscordChannel(ch.channel_id);
        console.log(`  ${ok ? '✅' : '❌'} Deleted #${ch.channel_type} (${ch.channel_id})`);
      }

      // Delete the category
      const catOk = await deleteDiscordChannel(instance.category_id);
      console.log(`  ${catOk ? '✅' : '❌'} Deleted category (${instance.category_id})`);

      // Delete instance DB file
      const instanceDbPath = path.join(process.cwd(), 'data', 'instances', instance.id, 'database.db');
      for (const ext of ['', '-wal', '-shm']) {
        const filePath = instanceDbPath + ext;
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
          console.log(`  🗑️  Deleted ${path.relative(process.cwd(), filePath)}`);
        }
      }

      // Clean up empty instance dir
      const instanceDir = path.dirname(instanceDbPath);
      if (fs.existsSync(instanceDir)) {
        try { fs.rmdirSync(instanceDir); } catch { /* not empty */ }
      }
    }

    // Clean up global DB tables
    db.prepare('DELETE FROM instance_channels').run();
    db.prepare('DELETE FROM instance_secrets').run();
    db.prepare('DELETE FROM instances').run();
    console.log('\n🗑️  Cleaned instance records from global DB.');
  }

  // 2. Delete wizard sessions
  const wizardExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='wizard_sessions'").get();
  if (wizardExists !== undefined) {
    const count = db.prepare('SELECT COUNT(*) AS cnt FROM wizard_sessions').get() as { cnt: number };
    if (count.cnt > 0) {
      db.prepare('DELETE FROM wizard_sessions').run();
      console.log(`🗑️  Deleted ${String(count.cnt)} wizard session(s).`);
    }
  }

  db.close();

  console.log('\n✅ Reset complete.');
  console.log('👉 Relance le bot puis tape /setup dans Discord pour recommencer.');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  db.close();
  process.exit(1);
});
