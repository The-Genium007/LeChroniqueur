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
import { handleSuggestionsCron } from './handlers/suggestions.js';
import { handleAdminMessage, setPendingModification } from './handlers/conversation.js';
import { handleGenerateImages } from './handlers/production.js';
import { handlePublish } from './handlers/publication.js';
import { handleWeeklyRapport } from './handlers/rapport.js';
import { upsertRating } from './feedback/ratings.js';
import { search, searchCount } from './search/engine.js';
import { deepDive } from './veille/deep-dive.js';
import { generateFinalScript } from './content/scripts.js';
import {
  recordAnthropicUsage,
  getDailyTotal,
  getWeeklyTotal,
  getMonthlyTotal,
} from './budget/tracker.js';
import { getProfile } from './feedback/preference-learner.js';
import {
  searchResults as buildSearchResults,
  budgetReport as buildBudgetReport,
  preferenceProfile as buildPreferenceProfile,
  deepDiveResult as buildDeepDiveResult,
  production as buildProduction,
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

    logger.info({ key, value }, 'Config change requested');
    const payload = successMessage(`Config \`${key}\` = \`${value}\` (note: les changements dynamiques seront implémentés dans une prochaine version).`);
    await interaction.reply({ embeds: payload.embeds });
  });

  // ─── 6. Button Handlers ───
  const buttonHandlers = new Map<string, ButtonHandler>();

  // Veille feedback
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

  // Deep dive — fetch article, analyze, post results
  buttonHandlers.set('transform', async (interaction, parsed) => {
    await interaction.deferReply();

    try {
      const result = await deepDive(db, parsed.targetId);
      recordAnthropicUsage(db, result.tokensUsed.input, result.tokensUsed.output);

      const article = db.prepare('SELECT title, translated_title FROM veille_articles WHERE id = ?')
        .get(parsed.targetId) as { title: string; translated_title: string | null } | undefined;

      const title = article?.translated_title ?? article?.title ?? 'Article';

      const payload = buildDeepDiveResult({
        articleTitle: title,
        analysis: result.analysis,
        contentSuggestions: result.contentSuggestions,
        articleId: parsed.targetId,
      });

      await interaction.editReply({
        embeds: payload.embeds,
        components: payload.components,
      });

      db.prepare('UPDATE veille_articles SET status = ? WHERE id = ?')
        .run('transformed', parsed.targetId);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      const payload = errorMessage(`Deep dive échoué : ${msg}`);
      await interaction.editReply({ embeds: payload.embeds });
    }
  });

  // Deep dive → accept as suggestion (placeholder — creates a simple suggestion)
  buttonHandlers.set('transform_accept', async (interaction, parsed) => {
    await interaction.reply({
      content: '✅ Article marqué pour transformation. Une suggestion sera générée au prochain cycle.',
      ephemeral: true,
    });
    db.prepare('UPDATE veille_articles SET status = ? WHERE id = ?')
      .run('proposed', parsed.targetId);
  });

  // Suggestion — Go → generate final script → post in #production
  buttonHandlers.set('go', async (interaction, parsed) => {
    await interaction.deferUpdate();

    db.prepare('UPDATE suggestions SET status = ?, decided_at = datetime(\'now\') WHERE id = ?')
      .run('go', parsed.targetId);
    upsertRating(db, 'suggestions', parsed.targetId, 1, interaction.user.id);

    // Remove buttons from the suggestion message
    await interaction.editReply({ components: [] });

    try {
      const suggestion = db.prepare('SELECT content, platform, format FROM suggestions WHERE id = ?')
        .get(parsed.targetId) as { content: string; platform: string; format: string | null } | undefined;

      if (suggestion === undefined) {
        return;
      }

      const script = await generateFinalScript(
        suggestion.content,
        suggestion.platform,
        suggestion.format ?? 'reel',
      );

      const payload = buildProduction({
        id: parsed.targetId,
        textOverlay: script.textOverlay,
        fullScript: script.fullScript,
        hashtags: script.hashtags,
        platform: script.platform,
        suggestedTime: script.suggestedTime,
        notes: script.notes,
      });

      await channels.production.send({
        embeds: payload.embeds,
        components: payload.components,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error({ error: msg, suggestionId: parsed.targetId }, 'Failed to generate final script');
    }
  });

  // Suggestion — Modify → set pending modification, wait for text in #admin
  buttonHandlers.set('modify', async (interaction, parsed) => {
    const suggestion = db.prepare('SELECT content FROM suggestions WHERE id = ?')
      .get(parsed.targetId) as { content: string } | undefined;

    if (suggestion === undefined) {
      await interaction.reply({ content: 'Suggestion introuvable.', ephemeral: true });
      return;
    }

    setPendingModification(interaction.user.id, parsed.targetId, suggestion.content);

    await interaction.reply({
      content: '✏️ Qu\'est-ce que tu veux modifier ? Écris tes instructions dans **#admin**. (expire dans 5 min)',
      ephemeral: true,
    });
  });

  // Suggestion — Skip
  buttonHandlers.set('skip', async (interaction, parsed) => {
    db.prepare('UPDATE suggestions SET status = ?, decided_at = datetime(\'now\') WHERE id = ?')
      .run('skipped', parsed.targetId);
    upsertRating(db, 'suggestions', parsed.targetId, -1, interaction.user.id);
    await interaction.update({ components: [] });
  });

  // Suggestion — Later
  buttonHandlers.set('later', async (interaction, parsed) => {
    db.prepare('UPDATE suggestions SET status = ? WHERE id = ?')
      .run('later', parsed.targetId);
    await interaction.reply({ content: '⏰ Remis à plus tard.', ephemeral: true });
  });

  // Production — Validate → generate images + schedule publication
  buttonHandlers.set('validate', async (interaction, parsed) => {
    await interaction.deferReply();

    // Generate images
    try {
      await handleGenerateImages(interaction, parsed.targetId, {
        db,
        productionChannel: channels.production,
        logsChannel: channels.logs,
        adminChannel: channels.admin,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error({ error: msg }, 'Image generation in validate failed');
    }

    // Schedule publication (default: tomorrow at suggested time or 19h)
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(19, 0, 0, 0);

    try {
      await handlePublish(parsed.targetId, tomorrow, {
        db,
        publicationChannel: channels.publication,
        logsChannel: channels.logs,
      });
      await interaction.editReply({ content: '✅ Script validé, images générées, publication programmée.' });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error({ error: msg }, 'Publication scheduling in validate failed');
      await interaction.editReply({ content: `✅ Script validé, images générées. ⚠️ Publication échouée : ${msg}` });
    }
  });

  // Select image variant from gallery
  buttonHandlers.set('select_image', async (interaction, parsed) => {
    db.prepare('UPDATE media SET type = ? WHERE id = ?')
      .run('image_selected', parsed.targetId);
    await interaction.update({ components: [] });
    await interaction.followUp({ content: `🖼️ Variante sélectionnée (media #${String(parsed.targetId)}).`, ephemeral: true });
  });

  // Production — Retouch
  buttonHandlers.set('retouch', async (interaction, parsed) => {
    const suggestion = db.prepare('SELECT content FROM suggestions WHERE id = ?')
      .get(parsed.targetId) as { content: string } | undefined;

    if (suggestion === undefined) {
      await interaction.reply({ content: 'Contenu introuvable.', ephemeral: true });
      return;
    }

    setPendingModification(interaction.user.id, parsed.targetId, suggestion.content);

    await interaction.reply({
      content: '✏️ Qu\'est-ce que tu veux retoucher ? Écris tes instructions dans **#admin**. (expire dans 5 min)',
      ephemeral: true,
    });
  });

  // ─── 7. Interaction Router ───
  const handleInteraction = createInteractionRouter({
    commandHandlers,
    buttonHandlers,
  });

  client.on(Events.InteractionCreate, (interaction) => {
    void handleInteraction(interaction);
  });

  // ─── 8. Message Listener (#admin — free text for modifications) ───
  client.on(Events.MessageCreate, (message) => {
    if (message.channelId === channels.admin.id) {
      void handleAdminMessage(message, {
        db,
        ideesChannel: channels.idees,
      });
    }
  });

  // ─── 9. Scheduler ───
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
    {
      name: 'suggestions',
      cronExpression: config.SUGGESTIONS_CRON,
      runOnMissed: true,
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

  // ─── 10. Graceful Shutdown ───
  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'Shutting down');
    scheduler.stop();
    client.destroy();
    closeDatabase();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  // ─── 11. Ready ───
  logger.info('tumulte-bot is fully operational');
}

main().catch((error) => {
  console.error('Fatal error during startup:', error);
  process.exit(1);
});
