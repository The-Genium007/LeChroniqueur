/**
 * Dev CLI — run bot pipelines from the terminal without Discord.
 *
 * Commands:
 *   list                          List all instances
 *   veille <instanceId>           Run veille pipeline (collect + prefilter + score)
 *   suggest <instanceId>          Generate content suggestions
 *   rapport <instanceId>          Generate weekly report
 *   inspect <instanceId>          Show recent articles, scores, sources
 *   search <instanceId> <query>   Run FTS search
 *
 * Usage: npx tsx scripts/dev-cli.ts <command> [args]
 */

import path from 'node:path';
import fs from 'node:fs';

// ─── Load .env.dev ───
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
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

// ─── Imports (after env is loaded) ───
import { createGlobalDatabase, createInstanceDatabase } from '../src/core/database.js';
import { loadConfig } from '../src/core/config.js';
import { createLogger } from '../src/core/logger.js';
import { personaLoader } from '../src/core/persona-loader.js';
import { getProfile, buildFallbackProfile } from '../src/core/instance-profile.js';
import { getCategoriesFromDb } from '../src/veille/queries.js';
import { decrypt, type EncryptedData } from '../src/core/crypto.js';
import type { InstanceContext, InstanceChannelMap, InstanceSecrets } from '../src/registry/instance-context.js';
import type { InstanceConfig } from '../src/core/config.js';
import type { InstanceProfile } from '../src/core/instance-profile.js';

// ─── Stub TextChannel ───
// A fake Discord TextChannel that logs to terminal instead of sending to Discord.

function createStubChannel(name: string): import('discord.js').TextChannel {
  const stub = {
    id: `stub-${name}`,
    name,
    isTextBased: () => true,
    send: async (options: unknown) => {
      // Extract text from V2 components
      const text = extractTextFromPayload(options);
      if (text.length > 0) {
        console.log(`\n📨 #${name}:`);
        // Truncate long messages for terminal readability
        const lines = text.split('\n').slice(0, 20);
        for (const line of lines) {
          console.log(`  ${line}`);
        }
        if (text.split('\n').length > 20) {
          console.log(`  ... (${String(text.split('\n').length - 20)} more lines)`);
        }
      }
      return { id: `msg-${Date.now()}` };
    },
    messages: { fetch: async () => new Map() },
    threads: { create: async (opts: { name: string }) => createStubChannel(`thread-${opts.name}`) },
  };
  return stub as unknown as import('discord.js').TextChannel;
}

function extractTextFromPayload(payload: unknown): string {
  if (payload === null || payload === undefined) return '';
  const obj = payload as Record<string, unknown>;
  const components = obj['components'] as Array<Record<string, unknown>> | undefined;
  if (components === undefined) {
    return typeof obj['content'] === 'string' ? obj['content'] : '';
  }

  const texts: string[] = [];
  for (const container of components) {
    const children = container['components'] as Array<Record<string, unknown>> | undefined;
    if (children === undefined) continue;
    for (const child of children) {
      if (child['type'] === 10 && typeof child['content'] === 'string') {
        texts.push(child['content']);
      }
    }
  }
  return texts.join('\n');
}

// ─── Build InstanceContext without Discord ───

function buildCliContext(instanceId: string): InstanceContext {
  const config = loadConfig();
  const globalDb = createGlobalDatabase();

  // Load instance record
  const row = globalDb.prepare('SELECT * FROM instances WHERE id = ?').get(instanceId) as {
    id: string; guild_id: string; name: string; category_id: string;
    owner_id: string; status: string; cron_offset_minutes: number; created_at: string;
  } | undefined;

  if (row === undefined) {
    console.error(`❌ Instance "${instanceId}" not found.`);
    console.log('\nAvailable instances:');
    const all = globalDb.prepare('SELECT id, name, status FROM instances').all() as Array<{ id: string; name: string; status: string }>;
    for (const inst of all) {
      console.log(`  - ${inst.id} (${inst.name}) [${inst.status}]`);
    }
    process.exit(1);
  }

  // Open instance DB
  const db = createInstanceDatabase(instanceId);

  // Load secrets
  const secretRows = globalDb.prepare(
    'SELECT key_type, encrypted_value, iv, auth_tag FROM instance_secrets WHERE instance_id = ?',
  ).all(instanceId) as Array<{ key_type: string; encrypted_value: string; iv: string; auth_tag: string }>;

  const secrets: Record<string, string> = {};
  for (const sr of secretRows) {
    try {
      const data: EncryptedData = { encrypted: sr.encrypted_value, iv: sr.iv, authTag: sr.auth_tag };
      secrets[sr.key_type] = decrypt(data, config.MASTER_ENCRYPTION_KEY);
    } catch {
      console.warn(`⚠️ Failed to decrypt secret: ${sr.key_type}`);
    }
  }

  const instanceSecrets: InstanceSecrets = {
    anthropicApiKey: secrets['llm'] ?? secrets['anthropic'] ?? '',
    anthropicModel: secrets['anthropic_model'] ?? 'claude-sonnet-4-20250514',
    geminiApiKey: secrets['gemini'] ?? '',
    googleCloudApiKey: secrets['google_cloud'],
    postizApiUrl: secrets['postiz_url'],
    postizApiKey: secrets['postiz_api_key'],
  };

  // Set API keys in process.env for services
  if (instanceSecrets.anthropicApiKey.length > 0) {
    process.env['ANTHROPIC_API_KEY'] = instanceSecrets.anthropicApiKey;
  }
  if (instanceSecrets.geminiApiKey.length > 0) {
    process.env['GEMINI_API_KEY'] = instanceSecrets.geminiApiKey;
  }
  if (instanceSecrets.googleCloudApiKey !== undefined && instanceSecrets.googleCloudApiKey.length > 0) {
    process.env['GOOGLE_CLOUD_API_KEY'] = instanceSecrets.googleCloudApiKey;
  }

  // Load persona, categories, profile
  const persona = personaLoader.loadForInstance(instanceId, db);
  const categories = getCategoriesFromDb(db);
  const profile: InstanceProfile = getProfile(db) ?? buildFallbackProfile(row.name);

  // Build config from DB overrides
  const overrides = new Map<string, string>();
  const overrideRows = db.prepare('SELECT key, value FROM config_overrides').all() as Array<{ key: string; value: string }>;
  for (const or of overrideRows) {
    overrides.set(or.key, or.value);
  }
  const getNum = (key: string, def: number): number => {
    const v = overrides.get(key);
    return v !== undefined ? Number(v) : def;
  };
  const getStr = (key: string, def: string): string => overrides.get(key) ?? def;

  const instanceConfig: InstanceConfig = {
    name: row.name,
    persona,
    categories,
    scheduler: {
      veilleCron: getStr('veilleCron', '0 7 * * *'),
      suggestionsCron: getStr('suggestionsCron', '0 8 * * *'),
      rapportCron: getStr('rapportCron', '0 21 * * 0'),
    },
    budget: {
      dailyCents: getNum('dailyCents', 300),
      weeklyCents: getNum('weeklyCents', 1500),
      monthlyCents: getNum('monthlyCents', 5000),
    },
    content: {
      suggestionsPerCycle: getNum('suggestionsPerCycle', 3),
      minScoreToPropose: getNum('minScoreToPropose', 6),
      platforms: profile.targetPlatforms.length > 0 ? profile.targetPlatforms : ['instagram', 'tiktok'],
      formats: profile.targetFormats.length > 0 ? profile.targetFormats : ['reel', 'post'],
      pillars: profile.pillars.length > 0 ? profile.pillars : ['trend', 'tuto', 'community', 'product'],
    },
    theme: { primary: 0x5865f2, accent: 0x5865f2 },
  };

  // Stub channels
  const channels: InstanceChannelMap = {
    dashboard: createStubChannel('dashboard'),
    recherche: createStubChannel('recherche'),
    veille: createStubChannel('veille'),
    idees: createStubChannel('idees'),
    production: createStubChannel('production'),
    publication: createStubChannel('publication'),
    logs: createStubChannel('logs'),
  };

  return {
    id: instanceId,
    name: row.name,
    guildId: row.guild_id,
    ownerId: row.owner_id,
    categoryId: row.category_id,
    config: instanceConfig,
    profile,
    db,
    channels,
    secrets: instanceSecrets,
    status: row.status as 'active' | 'paused' | 'archived',
    createdAt: row.created_at,
    cronOffsetMinutes: row.cron_offset_minutes,
  };
}

// ─── Commands ───

async function cmdList(): Promise<void> {
  const globalDb = createGlobalDatabase();
  const instances = globalDb.prepare('SELECT id, name, status, created_at FROM instances ORDER BY created_at').all() as Array<{
    id: string; name: string; status: string; created_at: string;
  }>;

  if (instances.length === 0) {
    console.log('Aucune instance. Lance le bot et utilise /setup pour en créer une.');
    return;
  }

  console.log(`\n📋 ${String(instances.length)} instance(s) :\n`);
  for (const inst of instances) {
    const statusEmoji = inst.status === 'active' ? '✅' : inst.status === 'paused' ? '⏸️' : '📦';
    console.log(`  ${statusEmoji} ${inst.id} — ${inst.name} (${inst.status}) — créé le ${inst.created_at.split('T')[0] ?? inst.created_at}`);
  }
}

async function cmdVeille(instanceId: string): Promise<void> {
  console.log(`\n🔍 Lancement de la veille pour "${instanceId}"...\n`);
  const ctx = buildCliContext(instanceId);

  const { handleVeilleCron } = await import('../src/handlers/veille.js');
  await handleVeilleCron(ctx);

  // Summary from DB
  const stats = ctx.db.prepare(`
    SELECT COUNT(*) AS total,
           SUM(CASE WHEN score >= 7 THEN 1 ELSE 0 END) AS top,
           ROUND(AVG(score), 1) AS avg_score
    FROM veille_articles
    WHERE collected_at >= datetime('now', '-1 hour')
  `).get() as { total: number; top: number; avg_score: number | null };

  console.log(`\n✅ Veille terminée.`);
  console.log(`   Articles ajoutés : ${String(stats.total)}`);
  console.log(`   Score moyen : ${String(stats.avg_score ?? 'N/A')}`);
  console.log(`   Top articles (≥7) : ${String(stats.top)}`);
}

async function cmdSuggest(instanceId: string): Promise<void> {
  console.log(`\n💡 Génération de suggestions pour "${instanceId}"...\n`);
  const ctx = buildCliContext(instanceId);

  const { handleSuggestionsCron } = await import('../src/handlers/suggestions.js');
  await handleSuggestionsCron(ctx);

  const pending = ctx.db.prepare("SELECT COUNT(*) AS cnt FROM suggestions WHERE status = 'pending'").get() as { cnt: number };
  console.log(`\n✅ Suggestions générées. ${String(pending.cnt)} en attente.`);
}

async function cmdRapport(instanceId: string): Promise<void> {
  console.log(`\n📊 Génération du rapport pour "${instanceId}"...\n`);
  const ctx = buildCliContext(instanceId);

  const { handleWeeklyRapport } = await import('../src/handlers/rapport.js');
  await handleWeeklyRapport(ctx);

  console.log(`\n✅ Rapport généré.`);
}

async function cmdInspect(instanceId: string): Promise<void> {
  const ctx = buildCliContext(instanceId);

  // Sources
  const sources = ctx.db.prepare('SELECT type, enabled FROM veille_sources ORDER BY type').all() as Array<{ type: string; enabled: number }>;
  console.log(`\n📦 Sources :`);
  for (const s of sources) {
    console.log(`  ${s.enabled === 1 ? '✅' : '❌'} ${s.type}`);
  }

  // Categories
  const cats = ctx.db.prepare('SELECT id, label, is_active FROM veille_categories ORDER BY sort_order').all() as Array<{ id: string; label: string; is_active: number }>;
  console.log(`\n📂 Catégories (${String(cats.length)}) :`);
  for (const c of cats) {
    console.log(`  ${c.is_active === 1 ? '✅' : '❌'} ${c.label} (${c.id})`);
  }

  // Recent articles
  const articles = ctx.db.prepare(`
    SELECT title, translated_title, score, source, status, pillar, collected_at
    FROM veille_articles
    ORDER BY collected_at DESC
    LIMIT 20
  `).all() as Array<{
    title: string; translated_title: string | null; score: number;
    source: string; status: string; pillar: string | null; collected_at: string;
  }>;

  console.log(`\n📰 Derniers articles (${String(articles.length)}) :`);
  for (const a of articles) {
    const title = (a.translated_title ?? a.title).slice(0, 70);
    console.log(`  [${String(a.score).padStart(2)}/10] ${a.status.padEnd(10)} ${a.source.padEnd(20).slice(0, 20)} ${title}`);
  }

  // Score distribution
  const dist = ctx.db.prepare(`
    SELECT
      SUM(CASE WHEN score <= 3 THEN 1 ELSE 0 END) AS low,
      SUM(CASE WHEN score BETWEEN 4 AND 6 THEN 1 ELSE 0 END) AS mid,
      SUM(CASE WHEN score BETWEEN 7 AND 8 THEN 1 ELSE 0 END) AS high,
      SUM(CASE WHEN score >= 9 THEN 1 ELSE 0 END) AS top,
      COUNT(*) AS total,
      ROUND(AVG(score), 1) AS avg
    FROM veille_articles
  `).get() as { low: number; mid: number; high: number; top: number; total: number; avg: number | null };

  console.log(`\n📊 Distribution des scores (${String(dist.total)} total, moy: ${String(dist.avg ?? 'N/A')}) :`);
  console.log(`  0-3: ${String(dist.low)} | 4-6: ${String(dist.mid)} | 7-8: ${String(dist.high)} | 9-10: ${String(dist.top)}`);

  // Pending suggestions
  const sugg = ctx.db.prepare("SELECT COUNT(*) AS cnt FROM suggestions WHERE status = 'pending'").get() as { cnt: number };
  console.log(`\n💡 Suggestions en attente : ${String(sugg.cnt)}`);
}

async function cmdSearch(instanceId: string, query: string): Promise<void> {
  const ctx = buildCliContext(instanceId);

  const { search: ftsSearch } = await import('../src/search/engine.js');
  const results = ftsSearch(ctx.db, query, 20, 0);

  if (results.length === 0) {
    console.log(`\n🔍 Aucun résultat pour "${query}".`);
    return;
  }

  console.log(`\n🔍 ${String(results.length)} résultats pour "${query}" :\n`);
  for (const r of results) {
    console.log(`  [${r.sourceTable}] ${r.title.slice(0, 70)}`);
    console.log(`    ${r.snippet.slice(0, 100)}`);
    console.log('');
  }
}

// ─── Main ───

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  // Initialize config + logger
  loadConfig();
  createLogger();

  if (command === undefined || command === 'help') {
    console.log(`
Dev CLI — Lance les pipelines du bot sans Discord.

Commandes :
  list                          Liste les instances
  veille <instanceId>           Lance la veille (collecte + prefilter + scoring)
  suggest <instanceId>          Génère des suggestions de contenu
  rapport <instanceId>          Génère le rapport hebdomadaire
  inspect <instanceId>          Affiche articles, scores, sources
  search <instanceId> <query>   Recherche FTS dans la base

Usage : npx tsx scripts/dev-cli.ts <commande> [args]
`);
    return;
  }

  try {
    switch (command) {
      case 'list':
        await cmdList();
        break;
      case 'veille': {
        const id = args[1];
        if (id === undefined) { console.error('Usage: dev-cli.ts veille <instanceId>'); process.exit(1); }
        await cmdVeille(id);
        break;
      }
      case 'suggest': {
        const id = args[1];
        if (id === undefined) { console.error('Usage: dev-cli.ts suggest <instanceId>'); process.exit(1); }
        await cmdSuggest(id);
        break;
      }
      case 'rapport': {
        const id = args[1];
        if (id === undefined) { console.error('Usage: dev-cli.ts rapport <instanceId>'); process.exit(1); }
        await cmdRapport(id);
        break;
      }
      case 'inspect': {
        const id = args[1];
        if (id === undefined) { console.error('Usage: dev-cli.ts inspect <instanceId>'); process.exit(1); }
        await cmdInspect(id);
        break;
      }
      case 'search': {
        const id = args[1];
        const query = args.slice(2).join(' ');
        if (id === undefined || query.length === 0) { console.error('Usage: dev-cli.ts search <instanceId> <query>'); process.exit(1); }
        await cmdSearch(id, query);
        break;
      }
      default:
        console.error(`Commande inconnue : "${command}". Lance "dev-cli.ts help" pour voir les commandes.`);
        process.exit(1);
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`\n❌ Erreur : ${msg}`);
    if (error instanceof Error && error.stack !== undefined) {
      console.error(error.stack);
    }
    process.exit(1);
  }
}

void main();
