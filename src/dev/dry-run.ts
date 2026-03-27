/**
 * DRY_RUN boot sequence — replaces Discord with a CLI REPL.
 * All business logic (veille, suggestions, ratings, search, budget) runs for real.
 * Discord is replaced by terminal output. APIs can be mocked via MOCK_APIS=true.
 */

import type { TextChannel } from 'discord.js';
import type { Config } from '../core/config.js';
import type { SqliteDatabase } from '../core/database.js';
import { getLogger } from '../core/logger.js';

interface LegacyChannelMap {
  readonly veille: TextChannel;
  readonly idees: TextChannel;
  readonly production: TextChannel;
  readonly publication: TextChannel;
  readonly logs: TextChannel;
  readonly admin: TextChannel;
  readonly bugs: TextChannel;
  readonly feedback: TextChannel;
}
import { createScheduler, type SchedulerJob } from '../core/scheduler.js';
import { createCliChannel } from './cli-channel.js';
import { startCliRunner } from './cli-runner.js';
import { handleVeilleCron } from '../handlers/veille.js';
import { handleSuggestionsCron } from '../handlers/suggestions.js';
import { handleWeeklyRapport } from '../handlers/rapport.js';
import { upsertRating } from '../feedback/ratings.js';
import { search, searchCount } from '../search/engine.js';
import { getProfile } from '../feedback/preference-learner.js';
import {
  getDailyTotal,
  getWeeklyTotal,
  getMonthlyTotal,
} from '../budget/tracker.js';
import {
  searchResults as buildSearchResults,
  budgetReport as buildBudgetReport,
  preferenceProfile as buildPreferenceProfile,
  type V2BudgetPeriodData as BudgetPeriodData,
} from '../discord/component-builder-v2.js';
import { sendSplit } from '../discord/message-splitter.js';

export function bootDryRun(config: Config, db: SqliteDatabase): void {
  const logger = getLogger();

  logger.info('╔══════════════════════════════════════╗');
  logger.info('║  DRY RUN MODE — No Discord connection ║');
  logger.info('╚══════════════════════════════════════╝');

  // ─── Fake channels ───
  const channels: LegacyChannelMap = {
    veille: createCliChannel('veille'),
    idees: createCliChannel('idées'),
    production: createCliChannel('production'),
    publication: createCliChannel('publication'),
    logs: createCliChannel('logs'),
    admin: createCliChannel('admin'),
    bugs: createCliChannel('bugs'),
    feedback: createCliChannel('feedback'),
  };

  // ─── Scheduler (real cron, just outputs to CLI channels) ───
  const jobs: SchedulerJob[] = [
    {
      name: 'veille',
      cronExpression: config.VEILLE_CRON,
      runOnMissed: false, // Don't auto-fire missed jobs in dev
      handler: async () => {
        await handleVeilleCron({
          db,
          veilleChannel: channels.veille,
          logsChannel: channels.logs,
          adminChannel: channels.admin,
        });
      },
    },
    {
      name: 'suggestions',
      cronExpression: config.SUGGESTIONS_CRON,
      runOnMissed: false,
      handler: async () => {
        await handleSuggestionsCron({
          db,
          ideesChannel: channels.idees,
          logsChannel: channels.logs,
          adminChannel: channels.admin,
        });
      },
    },
    {
      name: 'rapport',
      cronExpression: config.RAPPORT_CRON,
      runOnMissed: false,
      handler: async () => {
        await handleWeeklyRapport({
          db,
          veilleChannel: channels.veille,
          adminChannel: channels.admin,
        });
      },
    },
  ];

  const scheduler = createScheduler(db, jobs);
  scheduler.start();

  // ─── CLI command handlers (simplified — no Discord interaction objects) ───
  const commandHandlers = new Map<string, (args: string[]) => Promise<void>>();

  commandHandlers.set('veille', async () => {
    logger.info('Running veille pipeline...');
    await scheduler.runJob('veille');
  });

  commandHandlers.set('suggestions', async () => {
    logger.info('Running suggestions pipeline...');
    await scheduler.runJob('suggestions');
  });

  commandHandlers.set('rapport', async () => {
    logger.info('Running weekly report...');
    await scheduler.runJob('rapport');
  });

  commandHandlers.set('search', async (args) => {
    const query = args.join(' ');
    if (query.length === 0) {
      logger.warn('Usage: /search <query>');
      return;
    }

    const results = search(db, query, 10, 0);
    const total = searchCount(db, query);

    const payload = buildSearchResults(
      results.map((r) => ({
        sourceTable: r.sourceTable,
        sourceId: r.sourceId,
        title: r.title,
        snippet: r.snippet,
      })),
      query,
      1,
      total,
    );

    await sendSplit(channels.admin, payload);
  });

  commandHandlers.set('budget', async () => {
    const periods: BudgetPeriodData[] = [
      { label: "Aujourd'hui", ...getDailyTotal(db) },
      { label: 'Cette semaine', ...getWeeklyTotal(db) },
      { label: 'Ce mois', ...getMonthlyTotal(db) },
    ];

    const payload = buildBudgetReport(periods);
    await sendSplit(channels.admin, payload);
  });

  commandHandlers.set('stats', async () => {
    const profile = getProfile(db).map((p) => ({
      dimension: p.dimension,
      value: p.value,
      score: p.score,
      totalCount: p.totalCount,
    }));

    const payload = buildPreferenceProfile(profile);
    await sendSplit(channels.admin, payload);
  });

  // ─── CLI button handlers (simplified — no interaction objects) ───
  const buttonHandlers = new Map<string, (action: string, targetTable: string, targetId: number) => Promise<void>>();

  buttonHandlers.set('thumbup', async (_action, targetTable, targetId) => {
    upsertRating(db, targetTable, targetId, 1, config.DISCORD_OWNER_ID);
    logger.info(`👍 Rated ${targetTable}:${String(targetId)} = +1`);
  });

  buttonHandlers.set('thumbdown', async (_action, targetTable, targetId) => {
    upsertRating(db, targetTable, targetId, -1, config.DISCORD_OWNER_ID);
    logger.info(`👎 Rated ${targetTable}:${String(targetId)} = -1`);
  });

  buttonHandlers.set('archive', async (_action, _targetTable, targetId) => {
    db.prepare('UPDATE veille_articles SET status = ? WHERE id = ?').run('archived', targetId);
    logger.info(`⏭️ Archived article #${String(targetId)}`);
  });

  buttonHandlers.set('go', async (_action, _targetTable, targetId) => {
    db.prepare("UPDATE suggestions SET status = ?, decided_at = datetime('now') WHERE id = ?").run('go', targetId);
    upsertRating(db, 'suggestions', targetId, 1, config.DISCORD_OWNER_ID);
    logger.info(`✅ Go on suggestion #${String(targetId)}`);
  });

  buttonHandlers.set('skip', async (_action, _targetTable, targetId) => {
    db.prepare("UPDATE suggestions SET status = ?, decided_at = datetime('now') WHERE id = ?").run('skipped', targetId);
    upsertRating(db, 'suggestions', targetId, -1, config.DISCORD_OWNER_ID);
    logger.info(`⏭️ Skipped suggestion #${String(targetId)}`);
  });

  buttonHandlers.set('later', async (_action, _targetTable, targetId) => {
    db.prepare('UPDATE suggestions SET status = ? WHERE id = ?').run('later', targetId);
    logger.info(`⏰ Deferred suggestion #${String(targetId)}`);
  });

  // ─── Start REPL ───
  startCliRunner({
    db,
    channels: channels as unknown as Record<string, { id: string }>,
    scheduler,
    commandHandlers,
    buttonHandlers,
  });
}
