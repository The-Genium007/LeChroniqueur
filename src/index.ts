import { Events } from 'discord.js';
import { loadConfig } from './core/config.js';
import { createLogger } from './core/logger.js';
import { createDatabase, closeDatabase } from './core/database.js';
import { createClient, loginBot, resolveChannels, type ChannelMap } from './core/bot.js';
import { createScheduler, type SchedulerJob } from './core/scheduler.js';
import { registerGuildCommands } from './discord/commands.js';
import {
  createInteractionRouter,
  type CommandHandler,
  type ButtonHandler,
} from './discord/interactions.js';
import { handleVeilleCron } from './handlers/veille.js';
import { upsertRating } from './feedback/ratings.js';
import { search, searchCount } from './search/engine.js';
import {
  getDailyTotal,
  getWeeklyTotal,
  getMonthlyTotal,
} from './budget/tracker.js';
import { getProfile } from './feedback/preference-learner.js';
import {
  searchResults as buildSearchResults,
  budgetReport as buildBudgetReport,
  preferenceProfile as buildPreferenceProfile,
  successMessage,
  errorMessage,
  type BudgetPeriodData,
} from './discord/message-builder.js';

async function main(): Promise<void> {
  // ─── 1. Config & Logger ───
  const config = loadConfig();
  const logger = createLogger();

  logger.info({ env: config.NODE_ENV }, 'Starting tumulte-bot');

  // ─── 2. Database ───
  const db = createDatabase();

  // ─── 3. Discord Client ───
  const client = createClient();
  await loginBot(client);

  const channels: ChannelMap = await resolveChannels(client);
  logger.info('All channels resolved');

  // ─── 4. Register Slash Commands ───
  const clientId = client.user?.id;
  if (clientId === undefined) {
    throw new Error('Client user ID not available');
  }
  await registerGuildCommands(clientId);

  // ─── 5. Command Handlers ───
  const commandHandlers = new Map<string, CommandHandler>();

  commandHandlers.set('search', async (interaction) => {
    const query = interaction.options.getString('query', true);
    await interaction.deferReply();

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

    await interaction.editReply({
      embeds: payload.embeds,
      components: payload.components,
    });
  });

  commandHandlers.set('veille', async (interaction) => {
    await interaction.deferReply();
    try {
      await handleVeilleCron({
        db,
        veilleChannel: channels.veille,
        logsChannel: channels.logs,
        adminChannel: channels.admin,
      });
      const payload = successMessage('Veille exécutée avec succès.');
      await interaction.editReply({ embeds: payload.embeds });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      const payload = errorMessage(`Erreur veille : ${msg}`);
      await interaction.editReply({ embeds: payload.embeds });
    }
  });

  commandHandlers.set('budget', async (interaction) => {
    const periods: BudgetPeriodData[] = [
      { label: 'Aujourd\'hui', ...getDailyTotal(db) },
      { label: 'Cette semaine', ...getWeeklyTotal(db) },
      { label: 'Ce mois', ...getMonthlyTotal(db) },
    ];

    const payload = buildBudgetReport(periods);
    await interaction.reply({ embeds: payload.embeds });
  });

  commandHandlers.set('stats', async (interaction) => {
    const profile = getProfile(db).map((p) => ({
      dimension: p.dimension,
      value: p.value,
      score: p.score,
      totalCount: p.totalCount,
    }));

    const payload = buildPreferenceProfile(profile);
    await interaction.reply({ embeds: payload.embeds });
  });

  commandHandlers.set('config', async (interaction) => {
    const key = interaction.options.getString('key', true);
    const value = interaction.options.getString('value', true);

    // For now, config changes are logged but not persisted dynamically
    logger.info({ key, value }, 'Config change requested');
    const payload = successMessage(`Config \`${key}\` = \`${value}\` (note: les changements dynamiques seront implémentés dans une prochaine version).`);
    await interaction.reply({ embeds: payload.embeds });
  });

  // ─── 6. Button Handlers ───
  const buttonHandlers = new Map<string, ButtonHandler>();

  buttonHandlers.set('thumbup', async (interaction, parsed) => {
    upsertRating(db, parsed.targetTable, parsed.targetId, 1, interaction.user.id);
    await interaction.reply({ content: '👍 Noté !', ephemeral: true });
  });

  buttonHandlers.set('thumbdown', async (interaction, parsed) => {
    upsertRating(db, parsed.targetTable, parsed.targetId, -1, interaction.user.id);
    await interaction.reply({ content: '👎 Noté !', ephemeral: true });
  });

  buttonHandlers.set('archive', async (interaction, parsed) => {
    db.prepare('UPDATE veille_articles SET status = ? WHERE id = ?')
      .run('archived', parsed.targetId);
    await interaction.update({ components: [] });
  });

  buttonHandlers.set('transform', async (interaction, _parsed) => {
    await interaction.reply({
      content: '🎯 Transformation en contenu — cette fonctionnalité sera disponible en Phase 2.',
      ephemeral: true,
    });
  });

  buttonHandlers.set('go', async (interaction, parsed) => {
    db.prepare('UPDATE suggestions SET status = ?, decided_at = datetime(\'now\') WHERE id = ?')
      .run('go', parsed.targetId);
    upsertRating(db, 'suggestions', parsed.targetId, 1, interaction.user.id);
    await interaction.update({ components: [] });
  });

  buttonHandlers.set('skip', async (interaction, parsed) => {
    db.prepare('UPDATE suggestions SET status = ?, decided_at = datetime(\'now\') WHERE id = ?')
      .run('skipped', parsed.targetId);
    upsertRating(db, 'suggestions', parsed.targetId, -1, interaction.user.id);
    await interaction.update({ components: [] });
  });

  buttonHandlers.set('modify', async (interaction, _parsed) => {
    await interaction.reply({
      content: 'Qu\'est-ce que tu veux modifier ?',
      ephemeral: true,
    });
  });

  buttonHandlers.set('later', async (interaction, parsed) => {
    db.prepare('UPDATE suggestions SET status = ? WHERE id = ?')
      .run('later', parsed.targetId);
    await interaction.reply({ content: '⏰ Remis à plus tard.', ephemeral: true });
  });

  // ─── 7. Interaction Router ───
  const handleInteraction = createInteractionRouter({
    commandHandlers,
    buttonHandlers,
  });

  client.on(Events.InteractionCreate, (interaction) => {
    void handleInteraction(interaction);
  });

  // ─── 8. Scheduler ───
  const jobs: SchedulerJob[] = [
    {
      name: 'veille',
      cronExpression: config.VEILLE_CRON,
      runOnMissed: true,
      handler: async () => {
        await handleVeilleCron({
          db,
          veilleChannel: channels.veille,
          logsChannel: channels.logs,
          adminChannel: channels.admin,
        });
      },
    },
  ];

  const scheduler = createScheduler(db, jobs);
  scheduler.start();

  // ─── 9. Graceful Shutdown ───
  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'Shutting down');
    scheduler.stop();
    client.destroy();
    closeDatabase();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  // ─── 10. Ready ───
  logger.info('tumulte-bot is fully operational');
}

main().catch((error) => {
  console.error('Fatal error during startup:', error);
  process.exit(1);
});
