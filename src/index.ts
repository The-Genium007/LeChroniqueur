import {
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder as ModalActionRow,
} from 'discord.js';
import { loadConfig, isLegacyMode } from './core/config.js';
import { createLogger, getLogger } from './core/logger.js';
import { createGlobalDatabase, closeAllDatabases } from './core/database.js';
import { createClient, loginBot } from './core/bot.js';
import { InstanceRegistry } from './registry/instance-registry.js';
import { setupChannelRouter } from './registry/channel-router.js';
import { handleGuildCreate } from './onboarding/welcome.js';
import { ensureDashboardExists, refreshDashboard, cleanDashboardChannelOnBoot } from './dashboard/dashboard.js';
import { cleanSearchChannelOnBoot, registerSearchChannel } from './dashboard/search.js';
import { InstanceScheduler, applyCronOffset, type InstanceJob } from './core/scheduler-multi.js';
import { checkHealth } from './core/health.js';
import { checkForUpdate, CURRENT_VERSION } from './core/update-checker.js';
import { requireInstanceOwner } from './discord/permissions.js';
import { parseButtonCustomId, autoDeleteReply, autoDeleteEditReply } from './discord/interactions.js';
import { handleVeilleCron } from './handlers/veille.js';
import { handleSuggestionsCron } from './handlers/suggestions.js';
import { handleWeeklyRapport } from './handlers/rapport.js';
import { handleAdminMessage, setPendingModification } from './handlers/conversation.js';
import { upsertRating } from './feedback/ratings.js';
import { deepDive } from './veille/deep-dive.js';
// generateFinalScript replaced by derivation master flow
import { recordAnthropicUsage } from './budget/tracker.js';
import {
  deepDiveResult as buildDeepDiveV2,
  errorMessage as buildErrorV2,
} from './discord/component-builder-v2.js';
import { sendSplit, replySplit } from './discord/message-splitter.js';
import { handleGenerateImages } from './handlers/production.js';
import { handlePublish } from './handlers/publication.js';
import {
  handleCreateMaster,
  handleMasterValidation,
  handleDerivationValidation,
  handleDerivationRejection,
  processDerivationJob,
  processMediaJob,
} from './handlers/derivation.js';
import { personaLoader } from './core/persona-loader.js';
import { createQueueProcessor, resetStuckJobs } from './derivation/queue.js';
import { handleWizardInteraction } from './onboarding/wizard/orchestrator.js';
import type { InstanceContext } from './registry/instance-context.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger();

  logger.info({ version: CURRENT_VERSION, env: config.NODE_ENV, dryRun: config.DRY_RUN, mockApis: config.MOCK_APIS }, 'Starting bot');

  if (isLegacyMode()) {
    logger.info('Legacy mode detected (channel IDs in env). Please use: node dist/index.js');
    process.exit(0);
  }

  // ─── 1. Global Database ───
  const globalDb = createGlobalDatabase();

  // ─── 1b. LLM Factory ───
  const { initLlmFactoryFromEnv } = await import('./services/llm-factory.js');
  initLlmFactoryFromEnv();
  logger.info('LLM factory initialized');

  // ─── 2. Discord Client ───
  const client = createClient();
  await loginBot(client);
  logger.info({ tag: client.user?.tag }, 'Bot connected to Discord');

  // ─── 2b. Register slash commands ───
  try {
    const { REST, Routes, SlashCommandBuilder } = await import('discord.js');
    const rest = new REST({ version: '10' }).setToken(config.DISCORD_TOKEN);
    const setupCmd = new SlashCommandBuilder().setName('setup').setDescription('Reçois un DM pour configurer ou créer une instance');
    await rest.put(Routes.applicationCommands(client.user?.id ?? ''), { body: [setupCmd.toJSON()] });
    logger.info('Slash command /setup registered globally');
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.warn({ error: msg }, 'Failed to register slash commands');
  }

  // ─── 3. Instance Registry ───
  const registry = new InstanceRegistry(globalDb, client);
  await registry.loadAll();
  logger.info({ instanceCount: registry.getAll().length }, 'Instances loaded');

  // ─── 4. Per-instance setup ───
  const schedulers = new Map<string, InstanceScheduler>();

  for (const ctx of registry.getAll()) {
    if (ctx.status !== 'active') continue;

    // Set API keys in process.env so services can use them
    if (ctx.secrets.anthropicApiKey.length > 0) {
      process.env['ANTHROPIC_API_KEY'] = ctx.secrets.anthropicApiKey;
    }
    if (ctx.secrets.googleAiApiKey !== undefined && ctx.secrets.googleAiApiKey.length > 0) {
      process.env['GOOGLE_AI_API_KEY'] = ctx.secrets.googleAiApiKey;
    }

    try {
      const dashMsgId = registry.getChannelMessageId(ctx.id, 'dashboard');
      if (dashMsgId !== null) {
        await cleanDashboardChannelOnBoot(ctx.channels.dashboard, dashMsgId);
      }
      await ensureDashboardExists(
        ctx.channels.dashboard, ctx.db, ctx.name, ctx.createdAt, false,
        dashMsgId,
        (newId) => registry.setChannelMessageId(ctx.id, 'dashboard', newId),
      );

      const searchMsgId = registry.getChannelMessageId(ctx.id, 'recherche');
      if (searchMsgId !== null) {
        await cleanSearchChannelOnBoot(ctx.channels.recherche, searchMsgId);
        registerSearchChannel(ctx.channels.recherche, searchMsgId);
      }

      const scheduler = startInstanceScheduler(ctx, registry);
      schedulers.set(ctx.id, scheduler);

      logger.info({ instanceId: ctx.id, name: ctx.name }, 'Instance initialized');
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error({ instanceId: ctx.id, error: msg }, 'Failed to initialize instance');
    }
  }

  // ─── 5. Event routing ───
  setupChannelRouter(client, registry, {
    // ─── Instance interactions (buttons + modals in instance channels) ───
    instanceInteraction: async (interaction, ctx) => {
      // Handle /setup command — forward to global handler (works from any channel)
      if (interaction.isChatInputCommand() && interaction.commandName === 'setup') {
        await handleWizardInteraction(interaction, globalDb, registry);
        return;
      }

      // Handle search modal submission
      if (interaction.isModalSubmit() && interaction.customId === 'search:modal:query') {
        const query = interaction.fields.getTextInputValue('query');
        const { search: ftsSearch, searchCount, enrichResults } = await import('./search/engine.js');
        const { searchResults: buildSearchResultsV2 } = await import('./discord/component-builder-v2.js');
        const { trackTempMessage, setLastQuery } = await import('./dashboard/search.js');

        const results = ftsSearch(ctx.db, query, 8, 0);
        const total = searchCount(ctx.db, query);
        const enriched = enrichResults(ctx.db, results);
        const payload = buildSearchResultsV2(enriched, query, 1, total);

        await interaction.reply({ components: payload.components as never[], flags: payload.flags } as never);
        if (interaction.channelId !== null) {
          trackTempMessage(interaction.channelId, interaction.id);
          setLastQuery(interaction.channelId, query);
        }
        return;
      }

      // Handle config edit modal submissions
      if (interaction.isModalSubmit() && interaction.customId.startsWith('config:modal:')) {
        const section = interaction.customId.replace('config:modal:', '');
        const fields = interaction.fields;

        const saveOverride = (key: string, value: string): void => {
          const old = ctx.db.prepare('SELECT value FROM config_overrides WHERE key = ?').get(key) as { value: string } | undefined;
          ctx.db.prepare(`
            INSERT INTO config_overrides (key, value, updated_at, updated_by)
            VALUES (?, ?, datetime('now'), ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by
          `).run(key, value, interaction.user.id);
          ctx.db.prepare('INSERT INTO config_history (key, old_value, new_value, changed_by) VALUES (?, ?, ?, ?)')
            .run(key, old?.value ?? null, value, interaction.user.id);
        };

        if (section === 'suggestions') {
          const perCycle = fields.getTextInputValue('per_cycle');
          const minScore = fields.getTextInputValue('min_score');
          if (perCycle.length > 0) saveOverride('suggestionsPerCycle', perCycle);
          if (minScore.length > 0) saveOverride('minScoreToPropose', minScore);
          await autoDeleteReply(interaction, '✅ Configuration suggestions mise à jour.');
        } else if (section === 'scheduler') {
          const veille = fields.getTextInputValue('veille_cron');
          const suggestions = fields.getTextInputValue('suggestions_cron');
          const rapport = fields.getTextInputValue('rapport_cron');
          if (veille.length > 0) saveOverride('veilleCron', veille);
          if (suggestions.length > 0) saveOverride('suggestionsCron', suggestions);
          if (rapport.length > 0) saveOverride('rapportCron', rapport);
          await autoDeleteReply(interaction, '✅ Scheduler mis à jour. Redémarre l\'instance pour appliquer les nouveaux crons.', 8_000);
        } else if (section === 'budget') {
          const daily = fields.getTextInputValue('daily_cents');
          const weekly = fields.getTextInputValue('weekly_cents');
          const monthly = fields.getTextInputValue('monthly_cents');
          if (daily.length > 0) saveOverride('dailyCents', daily);
          if (weekly.length > 0) saveOverride('weeklyCents', weekly);
          if (monthly.length > 0) saveOverride('monthlyCents', monthly);
          await autoDeleteReply(interaction, '✅ Budget mis à jour.');
        } else if (section === 'persona') {
          const content = fields.getTextInputValue('persona_content');
          const { personaLoader: pl } = await import('./core/persona-loader.js');
          pl.saveForInstance(ctx.id, ctx.db, content);
          await autoDeleteReply(interaction, '✅ Persona mis à jour.');
        } else if (section === 'apikey:anthropic') {
          const apiKey = fields.getTextInputValue('api_key');
          await interaction.deferReply({ ephemeral: true });
          const { validateAnthropicKey, storeInstanceSecret } = await import('./onboarding/api-keys.js');
          const valid = await validateAnthropicKey(apiKey);
          if (!valid) {
            await interaction.editReply({ content: '❌ Clé Anthropic invalide. Vérifie et réessaie.' });
          } else {
            storeInstanceSecret(globalDb, ctx.id, 'anthropic', apiKey);
            process.env['ANTHROPIC_API_KEY'] = apiKey;
            await interaction.editReply({ content: '✅ Clé Anthropic mise à jour et validée.' });
          }
        } else if (section === 'apikey:google') {
          const apiKey = fields.getTextInputValue('api_key');
          await interaction.deferReply({ ephemeral: true });
          const { validateGoogleAiKey, storeInstanceSecret } = await import('./onboarding/api-keys.js');
          const valid = await validateGoogleAiKey(apiKey);
          if (!valid) {
            await interaction.editReply({ content: '❌ Clé Google AI invalide. Vérifie et réessaie.' });
          } else {
            storeInstanceSecret(globalDb, ctx.id, 'google_ai', apiKey);
            await interaction.editReply({ content: '✅ Clé Google AI mise à jour et validée.' });
          }
        } else if (section.startsWith('postiz:')) {
          const platformId = section.replace('postiz:', '');
          await interaction.deferReply({ ephemeral: true });
          const { PLATFORM_CONFIG: PC, configurePlatform: configPlat } = await import('./onboarding/postiz-setup.js');
          const def = PC[platformId];
          if (def === undefined) { await interaction.editReply({ content: 'Plateforme inconnue.' }); return; }
          const keys: Record<string, string> = {};
          for (const envVar of def.envVars) {
            if (envVar === undefined) continue;
            try { keys[envVar] = fields.getTextInputValue(envVar); } catch { /* field not found */ }
          }
          try {
            await interaction.editReply({ content: `⏳ Configuration de ${def.label}... Redémarrage de Postiz.` });
            await configPlat(platformId as import('./onboarding/postiz-setup.js').PlatformId, keys);
            await interaction.editReply({ content: `✅ ${def.label} configuré ! Postiz redémarré.\n\nVa sur Postiz pour connecter ton compte.` });
          } catch (error) {
            const errMsg = error instanceof Error ? error.message : String(error);
            await interaction.editReply({ content: `⚠️ Erreur : ${errMsg}` });
          }
        }
        return;
      }

      if (!interaction.isButton()) return;

      const allowed = await requireInstanceOwner(interaction, ctx.ownerId);
      if (!allowed) return;

      const parsed = parseButtonCustomId(interaction.customId);
      if (parsed === undefined) return;

      const { action, targetId } = parsed;

      // Veille buttons
      if (action === 'thumbup') {
        upsertRating(ctx.db, parsed.targetTable, targetId, 1, interaction.user.id);
        await autoDeleteReply(interaction, '👍 Noté !');
      } else if (action === 'thumbdown') {
        upsertRating(ctx.db, parsed.targetTable, targetId, -1, interaction.user.id);
        await autoDeleteReply(interaction, '👎 Noté !');
      } else if (action === 'archive') {
        ctx.db.prepare('UPDATE veille_articles SET status = ? WHERE id = ?').run('archived', targetId);
        try { await interaction.message.delete(); } catch { /* already deleted */ }
        if (!interaction.replied && !interaction.deferred) {
          try { await interaction.deferUpdate(); } catch { /* expired */ }
        }
      } else if (action === 'transform') {
        await interaction.deferReply();
        try {
          const result = await deepDive(ctx.db, targetId);
          recordAnthropicUsage(ctx.db, result.tokensUsed.input, result.tokensUsed.output);
          const article = ctx.db.prepare('SELECT title, translated_title FROM veille_articles WHERE id = ?')
            .get(targetId) as { title: string; translated_title: string | null } | undefined;
          const title = article?.translated_title ?? article?.title ?? 'Article';
          const payload = buildDeepDiveV2({ articleTitle: title, analysis: result.analysis, contentSuggestions: result.contentSuggestions, articleId: targetId });
          await replySplit(interaction, payload);
          ctx.db.prepare('UPDATE veille_articles SET status = ? WHERE id = ?').run('transformed', targetId);
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          await replySplit(interaction, buildErrorV2(`Deep dive échoué : ${msg}`));
        }
      } else if (action === 'transform_accept') {
        ctx.db.prepare('UPDATE veille_articles SET status = ? WHERE id = ?').run('proposed', targetId);
        await autoDeleteReply(interaction, '✅ Article marqué pour transformation.');

      // Suggestion buttons
      } else if (action === 'go') {
        await interaction.deferReply({ ephemeral: true });
        ctx.db.prepare("UPDATE suggestions SET status = ?, decided_at = datetime('now') WHERE id = ?").run('go', targetId);
        upsertRating(ctx.db, 'suggestions', targetId, 1, interaction.user.id);
        try { await interaction.message.delete(); } catch { /* already deleted */ }
        try {
          // Create master content (text + image 1:1) and post to #production
          const persona = personaLoader.loadForInstance(ctx.id, ctx.db);
          await handleCreateMaster(targetId, {
            db: ctx.db,
            productionChannel: ctx.channels.production,
            publicationChannel: ctx.channels.publication,
            logsChannel: ctx.channels.logs,
            persona,
            configuredPlatforms: ctx.config.content.platforms,
          });
          await autoDeleteEditReply(interaction, '✅ Suggestion acceptée — master posté en #production.');
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          getLogger().error({ error: msg, suggestionId: targetId }, 'Failed to create master');
          await autoDeleteEditReply(interaction, `❌ Erreur : ${msg}`);
        }
      } else if (action === 'modify') {
        const suggestion = ctx.db.prepare('SELECT content FROM suggestions WHERE id = ?')
          .get(targetId) as { content: string } | undefined;
        if (suggestion === undefined) {
          await interaction.reply({ content: 'Suggestion introuvable.', ephemeral: true });
        } else {
          setPendingModification(interaction.user.id, targetId, suggestion.content);
          await interaction.reply({ content: '✏️ Écris tes instructions de modification dans ce channel. (expire dans 5 min)', ephemeral: true });
        }
      } else if (action === 'skip') {
        ctx.db.prepare("UPDATE suggestions SET status = ?, decided_at = datetime('now') WHERE id = ?").run('skipped', targetId);
        upsertRating(ctx.db, 'suggestions', targetId, -1, interaction.user.id);
        try { await interaction.message.delete(); } catch { /* already deleted */ }
        if (!interaction.replied && !interaction.deferred) {
          try { await interaction.deferUpdate(); } catch { /* expired */ }
        }
      } else if (action === 'later') {
        ctx.db.prepare("UPDATE suggestions SET status = ? WHERE id = ?").run('later', targetId);
        await autoDeleteReply(interaction, '⏰ Remis à plus tard.');

      // Production buttons
      } else if (action === 'validate') {
        await interaction.deferReply();
        try {
          // Generate images if Google AI is configured
          try {
            await handleGenerateImages(interaction, targetId, {
              db: ctx.db, productionChannel: ctx.channels.production,
              logsChannel: ctx.channels.logs, adminChannel: ctx.channels.logs,
            });
          } catch {
            getLogger().debug({ targetId }, 'Image generation skipped or failed');
          }

          // Post publication kit (Mode 1 — copy-paste)
          const { postPublicationKit } = await import('./publication/manual.js');
          await postPublicationKit(ctx.channels.publication, ctx.db, targetId);

          // Also attempt Postiz scheduling if configured
          if (ctx.secrets.postizApiKey !== undefined && ctx.secrets.postizApiKey.length > 0) {
            const tomorrow = new Date();
            tomorrow.setDate(tomorrow.getDate() + 1);
            tomorrow.setHours(19, 0, 0, 0);
            try {
              await handlePublish(targetId, tomorrow, {
                db: ctx.db, publicationChannel: ctx.channels.publication, logsChannel: ctx.channels.logs,
              });
            } catch {
              getLogger().debug({ targetId }, 'Postiz scheduling skipped or failed');
            }
          }

          await autoDeleteEditReply(interaction, '✅ Script validé. Kit de publication posté dans #publication.');
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          await autoDeleteEditReply(interaction, `⚠️ Erreur : ${msg}`, 10_000);
        }
      } else if (action === 'retouch') {
        const suggestion = ctx.db.prepare('SELECT content FROM suggestions WHERE id = ?')
          .get(targetId) as { content: string } | undefined;
        if (suggestion !== undefined) {
          setPendingModification(interaction.user.id, targetId, suggestion.content);
          await autoDeleteReply(interaction, '✏️ Écris tes instructions de retouche. (expire dans 5 min)', 10_000);
        }
      } else if (action === 'select_image') {
        ctx.db.prepare("UPDATE media SET type = ? WHERE id = ?").run('image_selected', targetId);
        try { await interaction.message.delete(); } catch { /* already deleted */ }
        await autoDeleteReply(interaction, '🖼️ Variante sélectionnée.');

      // Master buttons (derivation system)
      } else if (action === 'master') {
        const rawId = interaction.customId;
        const persona = personaLoader.loadForInstance(ctx.id, ctx.db);
        const derivDeps = {
          db: ctx.db,
          productionChannel: ctx.channels.production,
          publicationChannel: ctx.channels.publication,
          logsChannel: ctx.channels.logs,
          persona,
          configuredPlatforms: ctx.config.content.platforms,
        };

        if (rawId.startsWith('master:validate:')) {
          await interaction.deferReply({ ephemeral: true });
          try {
            await handleMasterValidation(interaction, targetId, derivDeps);
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            await autoDeleteEditReply(interaction, `❌ Erreur : ${msg}`);
          }
        } else if (rawId.startsWith('master:modify_text:')) {
          setPendingModification(interaction.user.id, targetId, 'master_text');
          await interaction.reply({ content: '✏️ Écris tes instructions de modification du texte master. (expire dans 5 min)', ephemeral: true });
        } else if (rawId.startsWith('master:regen_image:')) {
          await interaction.deferReply({ ephemeral: true });
          try {
            await handleGenerateImages(interaction, targetId, {
              db: ctx.db, productionChannel: ctx.channels.production,
              logsChannel: ctx.channels.logs, adminChannel: ctx.channels.logs,
            });
            await autoDeleteEditReply(interaction, '🖼️ Image master regénérée.');
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            await autoDeleteEditReply(interaction, `❌ Erreur : ${msg}`);
          }
        }

      // Derivation buttons
      } else if (action === 'deriv') {
        const rawId = interaction.customId;
        const persona = personaLoader.loadForInstance(ctx.id, ctx.db);
        const derivDeps = {
          db: ctx.db,
          productionChannel: ctx.channels.production,
          publicationChannel: ctx.channels.publication,
          logsChannel: ctx.channels.logs,
          persona,
          configuredPlatforms: ctx.config.content.platforms,
        };

        if (rawId.startsWith('deriv:validate:')) {
          await interaction.deferReply({ ephemeral: true });
          try {
            await handleDerivationValidation(interaction, targetId, derivDeps);
            await autoDeleteEditReply(interaction, '✅ Dérivation validée.');
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            await autoDeleteEditReply(interaction, `❌ Erreur : ${msg}`);
          }
        } else if (rawId.startsWith('deriv:reject:')) {
          await interaction.deferReply({ ephemeral: true });
          await handleDerivationRejection(interaction, targetId, derivDeps);
        } else if (rawId.startsWith('deriv:modify:')) {
          setPendingModification(interaction.user.id, targetId, 'deriv_text');
          await interaction.reply({ content: '✏️ Écris tes instructions de modification. (expire dans 5 min)', ephemeral: true });
        } else if (rawId.startsWith('deriv:validate_media:')) {
          const { updateDerivationStatus } = await import('./derivation/tree.js');
          updateDerivationStatus(ctx.db, targetId, 'ready');
          await autoDeleteReply(interaction, '✅ Média validé — dérivation prête.');
        } else if (rawId.startsWith('deriv:regen_media:')) {
          await autoDeleteReply(interaction, '🔄 Regénération du média en file d\'attente.');
        }

      // Publication buttons (includes derivation scheduling)
      } else if (action === 'pub') {
        const rawId = interaction.customId;
        if (rawId.startsWith('pub:copy:')) {
          const suggestion = ctx.db.prepare('SELECT content FROM suggestions WHERE id = ?').get(targetId) as { content: string } | undefined;
          await interaction.reply({ content: suggestion?.content ?? 'Contenu introuvable.', ephemeral: true });
        } else if (rawId.startsWith('pub:done:')) {
          ctx.db.prepare("UPDATE publications SET status = 'published', published_at = datetime('now') WHERE suggestion_id = ?").run(targetId);
          try { await interaction.message.delete(); } catch { /* already deleted */ }
          if (!interaction.replied && !interaction.deferred) {
            try { await interaction.deferUpdate(); } catch { /* expired */ }
          }
        } else if (rawId.startsWith('pub:postpone:')) {
          await autoDeleteReply(interaction, '📅 Reporter la publication. Modifie la date dans le dashboard.', 8_000);
        } else {
          await autoDeleteReply(interaction, 'Action enregistrée.');
        }

      // Search buttons
      } else if (action === 'search') {
        const rawId = interaction.customId;
        if (rawId === 'search:open') {
          const modal = new (await import('discord.js')).ModalBuilder()
            .setCustomId('search:modal:query')
            .setTitle('Recherche')
            .addComponents(
              new (await import('discord.js')).ActionRowBuilder<import('discord.js').TextInputBuilder>().addComponents(
                new (await import('discord.js')).TextInputBuilder()
                  .setCustomId('query')
                  .setLabel('Termes de recherche')
                  .setStyle((await import('discord.js')).TextInputStyle.Short)
                  .setRequired(true),
              ),
            );
          await interaction.showModal(modal);
        } else if (rawId === 'search:clear') {
          const { clearSearchResults } = await import('./dashboard/search.js');
          if (interaction.channel !== null && interaction.channel.isTextBased()) {
            await clearSearchResults(interaction.channel as import('discord.js').TextChannel, interaction.channelId);
          }
          await autoDeleteReply(interaction, '🧹 Résultats effacés.');
        } else if (rawId.startsWith('search:page:')) {
          // Pagination — re-run the last query with offset
          const pageNum = parseInt(rawId.split(':')[2] ?? '1', 10);
          const { getLastQuery, trackTempMessage: trackMsg, setLastQuery: setQ } = await import('./dashboard/search.js');
          const lastQuery = getLastQuery(interaction.channelId);
          if (lastQuery === null) {
            await autoDeleteReply(interaction, '🔍 Pas de recherche en cours. Utilise le bouton Rechercher.');
          } else {
            const { search: ftsSearch, searchCount, enrichResults } = await import('./search/engine.js');
            const { searchResults: buildSearchResultsV2 } = await import('./discord/component-builder-v2.js');
            const offset = (pageNum - 1) * 8;
            const results = ftsSearch(ctx.db, lastQuery, 8, offset);
            const total = searchCount(ctx.db, lastQuery);
            const enriched = enrichResults(ctx.db, results);
            const payload = buildSearchResultsV2(enriched, lastQuery, pageNum, total);
            await interaction.reply({ components: payload.components as never[], flags: payload.flags } as never);
            if (interaction.channelId !== null) {
              trackMsg(interaction.channelId, interaction.id);
              setQ(interaction.channelId, lastQuery);
            }
          }
        } else if (rawId.startsWith('search:suggest:')) {
          // Create a suggestion from a veille article
          const articleId = parseInt(rawId.split(':')[2] ?? '0', 10);
          await interaction.deferReply({ ephemeral: true });
          const article = ctx.db.prepare('SELECT id, title, translated_title, snippet, translated_snippet, url, score, pillar, suggested_angle, status FROM veille_articles WHERE id = ?')
            .get(articleId) as { id: number; title: string; translated_title: string | null; snippet: string; translated_snippet: string | null; url: string; score: number; pillar: string; suggested_angle: string | null; status: string } | undefined;
          if (article === undefined) {
            await autoDeleteEditReply(interaction, '❌ Article introuvable.');
          } else {
            const title = article.translated_title ?? article.title;
            const angle = article.suggested_angle ?? article.snippet.slice(0, 200);
            const content = [
              `**Hook :** ${title}`,
              '',
              `**Script :**`,
              angle,
              '',
              `**Source :** ${article.url}`,
            ].join('\n');
            const result = ctx.db.prepare(`
              INSERT INTO suggestions (veille_article_id, content, pillar, platform, format, status)
              VALUES (?, ?, ?, 'both', 'post', 'pending')
            `).run(article.id, content, article.pillar);
            const suggestionId = Number(result.lastInsertRowid);
            const { indexDocument } = await import('./search/engine.js');
            indexDocument(ctx.db, { title, snippet: angle, content, sourceTable: 'suggestions', sourceId: suggestionId });
            ctx.db.prepare("UPDATE veille_articles SET status = 'proposed' WHERE id = ? AND status = 'new'").run(articleId);
            // Post suggestion to #idées
            const { suggestion: buildSuggV2 } = await import('./discord/component-builder-v2.js');
            const { sendSplit } = await import('./discord/message-splitter.js');
            const payload = buildSuggV2({ id: suggestionId, content, pillar: article.pillar, platform: 'both' });
            await sendSplit(ctx.channels.idees, payload);
            await autoDeleteEditReply(interaction, `✅ Suggestion créée (#${String(suggestionId)}) et postée dans #idées.`);
          }
        } else if (rawId.startsWith('search:reactivate:')) {
          // Reactivate an archived/skipped item
          const parts = rawId.split(':');
          const table = parts[2];
          const itemId = parseInt(parts[3] ?? '0', 10);
          if (table === 'veille_articles') {
            ctx.db.prepare("UPDATE veille_articles SET status = 'new' WHERE id = ?").run(itemId);
            await autoDeleteReply(interaction, '♻️ Article réactivé (status → new).');
          } else if (table === 'suggestions') {
            ctx.db.prepare("UPDATE suggestions SET status = 'pending' WHERE id = ?").run(itemId);
            await autoDeleteReply(interaction, '♻️ Suggestion réactivée (status → pending).');
          } else if (table === 'publications') {
            ctx.db.prepare("UPDATE publications SET status = 'draft' WHERE id = ?").run(itemId);
            await autoDeleteReply(interaction, '♻️ Publication réactivée (status → draft).');
          } else {
            await autoDeleteReply(interaction, '❌ Type inconnu.');
          }
        } else if (rawId.startsWith('search:recent:')) {
          const type = rawId.split(':')[2] ?? 'articles';
          let results;
          const { infoMessage: infoV2 } = await import('./discord/component-builder-v2.js');
          if (type === 'articles') {
            results = ctx.db.prepare("SELECT id, title, translated_title FROM veille_articles ORDER BY collected_at DESC LIMIT 10").all() as Array<{ id: number; title: string; translated_title: string | null }>;
            const lines = results.map((r) => `► ${r.translated_title ?? r.title}`);
            const payload = infoV2(lines.length > 0 ? `**📰 Articles récents :**\n${lines.join('\n')}` : 'Aucun article.');
            await interaction.reply({ components: payload.components as never[], flags: payload.flags, ephemeral: true } as never);
          } else if (type === 'suggestions') {
            results = ctx.db.prepare("SELECT id, content FROM suggestions ORDER BY created_at DESC LIMIT 10").all() as Array<{ id: number; content: string }>;
            const lines = results.map((r) => `► ${r.content.slice(0, 80)}...`);
            const payload = infoV2(lines.length > 0 ? `**💡 Suggestions récentes :**\n${lines.join('\n')}` : 'Aucune suggestion.');
            await interaction.reply({ components: payload.components as never[], flags: payload.flags, ephemeral: true } as never);
          } else {
            results = ctx.db.prepare("SELECT id, content, platform FROM publications ORDER BY created_at DESC LIMIT 10").all() as Array<{ id: number; content: string; platform: string }>;
            const lines = results.map((r) => `► [${r.platform}] ${r.content.slice(0, 60)}...`);
            const payload = infoV2(lines.length > 0 ? `**📤 Publications récentes :**\n${lines.join('\n')}` : 'Aucune publication.');
            await interaction.reply({ components: payload.components as never[], flags: payload.flags, ephemeral: true } as never);
          }
        }

      // Dashboard buttons — route by raw customId for actions, parsed for nav
      } else if (action === 'dash') {
        const rawId = interaction.customId;

        // ── Action buttons (match raw customId first) ──
        if (rawId === 'dash:veille:run') {
          await interaction.deferReply({ ephemeral: true });
          await handleVeilleCron(ctx);
          const dashMsgId = registry.getChannelMessageId(ctx.id, 'dashboard');
          if (dashMsgId !== null) {
            await refreshDashboard(ctx.channels.dashboard, dashMsgId, ctx.db, ctx.name, ctx.createdAt, false);
          }
          await autoDeleteEditReply(interaction, '✅ Veille lancée.');
        } else if (rawId === 'dash:veille:top') {
          const top = ctx.db.prepare("SELECT title, translated_title, score FROM veille_articles WHERE collected_at >= datetime('now', '-7 days') AND score >= 7 ORDER BY score DESC LIMIT 5").all() as Array<{ title: string; translated_title: string | null; score: number }>;
          const lines = top.map((a) => `► ${a.translated_title ?? a.title} (${String(a.score)}/10)`);
          await autoDeleteReply(interaction, lines.length > 0 ? `**📊 Top articles semaine :**\n${lines.join('\n')}` : 'Aucun article score ≥ 7 cette semaine.', 15_000);
        } else if (rawId === 'dash:veille:categories') {
          const cats = ctx.db.prepare('SELECT label, is_active FROM veille_categories ORDER BY sort_order').all() as Array<{ label: string; is_active: number }>;
          const lines = cats.map((c) => `${c.is_active === 1 ? '✅' : '❌'} ${c.label}`);
          await autoDeleteReply(interaction, `**Catégories :**\n${lines.join('\n')}`, 15_000);
        } else if (rawId === 'dash:suggestions:generate') {
          await interaction.deferReply({ ephemeral: true });
          await handleSuggestionsCron(ctx);
          const dashMsgId = registry.getChannelMessageId(ctx.id, 'dashboard');
          if (dashMsgId !== null) {
            await refreshDashboard(ctx.channels.dashboard, dashMsgId, ctx.db, ctx.name, ctx.createdAt, false);
          }
          await autoDeleteEditReply(interaction, '✅ Suggestions générées.');
        } else if (rawId === 'dash:suggestions:pending') {
          const pending = ctx.db.prepare("SELECT COUNT(*) AS cnt FROM suggestions WHERE status = 'pending'").get() as { cnt: number };
          await autoDeleteReply(interaction, `📋 ${String(pending.cnt)} suggestions en attente dans #idées.`, 8_000);
        } else if (rawId === 'dash:pause') {
          const newStatus = ctx.status === 'paused' ? 'active' : 'paused';
          globalDb.prepare('UPDATE instances SET status = ? WHERE id = ?').run(newStatus, ctx.id);
          if (newStatus === 'paused') {
            schedulers.get(ctx.id)?.stop();
            await autoDeleteReply(interaction, '⏸️ Instance en pause. Crons suspendus.');
          } else {
            const scheduler = startInstanceScheduler(ctx, registry);
            schedulers.set(ctx.id, scheduler);
            await autoDeleteReply(interaction, '▶️ Instance reprise. Crons relancés.');
          }
          const dashMsgId = registry.getChannelMessageId(ctx.id, 'dashboard');
          if (dashMsgId !== null) {
            await refreshDashboard(ctx.channels.dashboard, dashMsgId, ctx.db, ctx.name, ctx.createdAt, newStatus === 'paused');
          }
        } else if (rawId === 'dash:config:edit:suggestions') {
          const sugModal = new ModalBuilder().setCustomId('config:modal:suggestions').setTitle('Config Suggestions')
            .addComponents(
              new ModalActionRow<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId('per_cycle').setLabel('Nombre par cycle (défaut: 3)').setStyle(TextInputStyle.Short).setRequired(false).setPlaceholder('3')),
              new ModalActionRow<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId('min_score').setLabel('Score minimum (défaut: 6)').setStyle(TextInputStyle.Short).setRequired(false).setPlaceholder('6')),
            );
          await interaction.showModal(sugModal);
        } else if (rawId === 'dash:config:edit:scheduler') {
          const schedModal = new ModalBuilder().setCustomId('config:modal:scheduler').setTitle('Config Scheduler')
            .addComponents(
              new ModalActionRow<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId('veille_cron').setLabel('Veille cron (défaut: 0 7 * * *)').setStyle(TextInputStyle.Short).setRequired(false).setPlaceholder('0 7 * * *')),
              new ModalActionRow<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId('suggestions_cron').setLabel('Suggestions cron (défaut: 0 8 * * *)').setStyle(TextInputStyle.Short).setRequired(false).setPlaceholder('0 8 * * *')),
              new ModalActionRow<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId('rapport_cron').setLabel('Rapport cron (défaut: 0 21 * * 0)').setStyle(TextInputStyle.Short).setRequired(false).setPlaceholder('0 21 * * 0')),
            );
          await interaction.showModal(schedModal);
        } else if (rawId === 'dash:config:edit:budget') {
          const budgetModal = new ModalBuilder().setCustomId('config:modal:budget').setTitle('Config Budget (en centimes)')
            .addComponents(
              new ModalActionRow<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId('daily_cents').setLabel('Budget jour en centimes (défaut: 300)').setStyle(TextInputStyle.Short).setRequired(false).setPlaceholder('300')),
              new ModalActionRow<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId('weekly_cents').setLabel('Budget semaine (défaut: 1500)').setStyle(TextInputStyle.Short).setRequired(false).setPlaceholder('1500')),
              new ModalActionRow<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId('monthly_cents').setLabel('Budget mois (défaut: 5000)').setStyle(TextInputStyle.Short).setRequired(false).setPlaceholder('5000')),
            );
          await interaction.showModal(budgetModal);
        } else if (rawId === 'dash:config:undo') {
          const lastChange = ctx.db.prepare('SELECT key, old_value FROM config_history ORDER BY changed_at DESC LIMIT 1').get() as { key: string; old_value: string | null } | undefined;
          if (lastChange === undefined) {
            await autoDeleteReply(interaction, 'Aucun changement à annuler.');
          } else if (lastChange.old_value === null) {
            ctx.db.prepare('DELETE FROM config_overrides WHERE key = ?').run(lastChange.key);
            await autoDeleteReply(interaction, `↩️ \`${lastChange.key}\` remis aux défauts.`);
          } else {
            ctx.db.prepare('UPDATE config_overrides SET value = ? WHERE key = ?').run(lastChange.old_value, lastChange.key);
            await autoDeleteReply(interaction, `↩️ \`${lastChange.key}\` = \`${lastChange.old_value}\``);
          }
        } else if (rawId === 'dash:config:reset') {
          ctx.db.prepare('DELETE FROM config_overrides').run();
          await autoDeleteReply(interaction, '🔄 Configuration remise aux défauts.');
        } else if (rawId === 'dash:config:export') {
          await interaction.deferReply({ ephemeral: true });
          const persona = ctx.db.prepare('SELECT content FROM persona WHERE id = 1').get() as { content: string } | undefined;
          const categories = ctx.db.prepare('SELECT * FROM veille_categories ORDER BY sort_order').all();
          const overrides = ctx.db.prepare('SELECT * FROM config_overrides').all();
          const exportData = JSON.stringify({ instanceName: ctx.name, persona: persona?.content ?? '', categories, configOverrides: overrides }, null, 2);
          const { AttachmentBuilder } = await import('discord.js');
          const attachment = new AttachmentBuilder(Buffer.from(exportData, 'utf-8'), { name: `${ctx.id}-export.json` });
          await interaction.editReply({ content: '📤 Export de la configuration :', files: [attachment] });
        } else if (rawId === 'dash:config:persona') {
          const { buildContainer: bc, txt: t, sep: s, btn: b, row: r, v2: v, getColor: gc, ButtonStyle: bs } = await import('./discord/component-builder-v2.js');
          const persona = ctx.db.prepare('SELECT content FROM persona WHERE id = 1').get() as { content: string } | undefined;
          const preview = persona !== undefined ? persona.content.slice(0, 800) : '(pas de persona configuré)';
          const payload = v([bc(gc('info'), (c) => {
            c.addTextDisplayComponents(t(`## 🎭 Persona\n\`\`\`\n${preview}${persona !== undefined && persona.content.length > 800 ? '\n...' : ''}\n\`\`\``));
            c.addSeparatorComponents(s());
            c.addActionRowComponents(r(
              b('persona:edit:modal', 'Modifier (texte)', bs.Primary, '✏️'),
              b('persona:upload', 'Uploader .md', bs.Secondary, '📎'),
            ));
          })]);
          await interaction.reply({ components: payload.components as never[], flags: payload.flags, ephemeral: true } as never);
        } else if (rawId === 'persona:edit:modal') {
          const persona = ctx.db.prepare('SELECT content FROM persona WHERE id = 1').get() as { content: string } | undefined;
          const modal = new ModalBuilder().setCustomId('config:modal:persona').setTitle('Modifier le Persona')
            .addComponents(
              new ModalActionRow<TextInputBuilder>().addComponents(
                new TextInputBuilder().setCustomId('persona_content').setLabel('Contenu du persona').setStyle(TextInputStyle.Paragraph).setRequired(true).setValue(persona?.content.slice(0, 4000) ?? ''),
              ),
            );
          await interaction.showModal(modal);
        } else if (rawId === 'persona:upload') {
          await autoDeleteReply(interaction, '📎 Envoie un fichier `.md` dans ce channel. Le bot le détectera automatiquement.', 10_000);
        } else if (rawId === 'dash:config:new_instance') {
          // Pre-store existing API keys in a new wizard session so user doesn't have to re-enter
          const { createWizardSession, saveWizardSession } = await import('./onboarding/wizard/state-machine.js');
          const newSession = createWizardSession(globalDb, ctx.guildId, interaction.user.id);
          // Copy API keys from current instance's secrets
          (newSession.data as Record<string, unknown>)['_anthropicKey'] = ctx.secrets.anthropicApiKey;
          if (ctx.secrets.googleAiApiKey !== undefined) {
            (newSession.data as Record<string, unknown>)['_googleKey'] = ctx.secrets.googleAiApiKey;
          }
          saveWizardSession(globalDb, newSession);
          // Skip directly to Postiz setup since keys are pre-filled
          const { buildContainer: bc2, txt: t2, sep: s2, btn: b2, row: r2, v2: v22, getColor: gc2, ButtonStyle: bs2 } = await import('./discord/component-builder-v2.js');
          const payload = v22([bc2(gc2('success'), (c) => {
            c.addTextDisplayComponents(t2('## ➕ Nouvelle instance\n\nLes clés API de l\'instance actuelle ont été pré-remplies.\nOn passe directement à la configuration du projet.'));
            c.addSeparatorComponents(s2());
            c.addActionRowComponents(r2(
              b2('onboard:postiz:skip', 'Continuer', bs2.Success, '🚀'),
            ));
          })]);
          await interaction.reply({ components: payload.components as never[], flags: payload.flags, ephemeral: true } as never);

        // ── API key rotation ──
        } else if (rawId === 'dash:config:apikeys') {
          const { buildContainer: bc3, txt: t3, sep: s3, btn: b3, row: r3, v2: v23, getColor: gc3, ButtonStyle: bs3 } = await import('./discord/component-builder-v2.js');
          const apiPayload = v23([bc3(gc3('info'), (c3) => {
            c3.addTextDisplayComponents(t3('## 🔑 Clés API\n\nModifie les clés API de cette instance.\nChaque clé sera validée avant d\'être enregistrée.'));
            c3.addSeparatorComponents(s3());
            c3.addActionRowComponents(r3(
              b3('dash:config:apikey:anthropic', 'Clé Anthropic', bs3.Primary, '🔑'),
              b3('dash:config:apikey:google', 'Clé Google AI', bs3.Primary, '🔑'),
            ));
          })]);
          await interaction.reply({ components: apiPayload.components as never[], flags: apiPayload.flags, ephemeral: true } as never);
        } else if (rawId === 'dash:config:apikey:anthropic') {
          const apiModal = new ModalBuilder().setCustomId('config:modal:apikey:anthropic').setTitle('Modifier clé Anthropic')
            .addComponents(
              new ModalActionRow<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId('api_key').setLabel('Nouvelle clé API Anthropic (sk-ant-...)').setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('sk-ant-api03-...')),
            );
          await interaction.showModal(apiModal);
        } else if (rawId === 'dash:config:apikey:google') {
          const apiModal = new ModalBuilder().setCustomId('config:modal:apikey:google').setTitle('Modifier clé Google AI')
            .addComponents(
              new ModalActionRow<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId('api_key').setLabel('Nouvelle clé API Google AI (AIza...)').setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('AIza...')),
            );
          await interaction.showModal(apiModal);

        // ── Postiz accounts (interactive) ──
        } else if (rawId === 'dash:config:postiz' || rawId === 'dash:postiz:back' || rawId === 'dash:postiz:verify') {
          await interaction.deferReply({ ephemeral: true });
          try {
            const { verifyPostizIntegrations: verifyPostiz, buildPostizScreen: buildScreen } = await import('./onboarding/postiz-setup.js');
            const result = await verifyPostiz();
            const postizPayload = await buildScreen('dash:postiz', result.connected);
            await interaction.editReply({ components: postizPayload.components as never[] } as never);
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            await interaction.editReply({ content: `⚠️ Impossible de charger la config Postiz : ${msg}` });
          }
        } else if (rawId === 'dash:postiz:more') {
          await interaction.deferReply({ ephemeral: true });
          try {
            const { verifyPostizIntegrations: verifyPostiz, getConfiguredPlatforms: getConfigured, buildPostizMoreScreen: buildMore } = await import('./onboarding/postiz-setup.js');
            const result = await verifyPostiz();
            let configured: string[];
            try { configured = await getConfigured(); } catch { configured = []; }
            const morePayload = buildMore('dash:postiz', result.connected, configured as import('./onboarding/postiz-setup.js').PlatformId[]);
            await interaction.editReply({ components: morePayload.components as never[] } as never);
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            await interaction.editReply({ content: `⚠️ Erreur : ${msg}` });
          }
        } else if (rawId.startsWith('dash:postiz:platform:')) {
          const platformId = rawId.replace('dash:postiz:platform:', '');
          await interaction.deferReply({ ephemeral: true });
          try {
            const { verifyPostizIntegrations: verifyPostiz, getConfiguredPlatforms: getConfigured, buildPlatformDetail: buildDetail, PLATFORM_CONFIG: PC } = await import('./onboarding/postiz-setup.js');
            const def = PC[platformId];
            if (def === undefined) { await interaction.editReply({ content: 'Plateforme inconnue.' }); return; }
            const result = await verifyPostiz();
            let configured: string[];
            try { configured = await getConfigured(); } catch { configured = []; }
            const detailPayload = buildDetail('dash:postiz', platformId as import('./onboarding/postiz-setup.js').PlatformId, configured.includes(platformId), result.connected.includes(platformId));
            await interaction.editReply({ components: detailPayload.components as never[] } as never);
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            await interaction.editReply({ content: `⚠️ Erreur : ${msg}` });
          }
        } else if (rawId.startsWith('dash:postiz:keys:')) {
          const platformId = rawId.replace('dash:postiz:keys:', '');
          const { PLATFORM_CONFIG: PC } = await import('./onboarding/postiz-setup.js');
          const def = PC[platformId];
          if (def === undefined) return;
          const keyModal = new ModalBuilder().setCustomId(`config:modal:postiz:${platformId}`).setTitle(`${def.label} — Clés API`);
          for (let i = 0; i < def.envVars.length && i < 5; i++) {
            const envVar = def.envVars[i];
            const label = def.envLabels[i] ?? envVar;
            if (envVar === undefined) continue;
            keyModal.addComponents(
              new ModalActionRow<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId(envVar).setLabel(label ?? envVar).setStyle(TextInputStyle.Short).setRequired(true)),
            );
          }
          await interaction.showModal(keyModal);
        } else if (rawId.startsWith('dash:postiz:remove:')) {
          const platformId = rawId.replace('dash:postiz:remove:', '');
          await interaction.deferReply({ ephemeral: true });
          try {
            const { removePlatform: rmPlatform, PLATFORM_CONFIG: PC } = await import('./onboarding/postiz-setup.js');
            const def = PC[platformId];
            if (def === undefined) { await interaction.editReply({ content: 'Plateforme inconnue.' }); return; }
            await rmPlatform(platformId as import('./onboarding/postiz-setup.js').PlatformId);
            await interaction.editReply({ content: `✅ ${def.label} supprimé. Postiz redémarré.` });
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            await interaction.editReply({ content: `⚠️ Erreur : ${msg}` });
          }

        // ── Delete instance ──
        } else if (rawId === 'dash:config:delete') {
          const { buildContainer: bc5, txt: t5, sep: s5, btn: b5, row: r5, v2: v25, getColor: gc5, ButtonStyle: bs5 } = await import('./discord/component-builder-v2.js');
          const confirmPayload = v25([bc5(gc5('error'), (c5) => {
            c5.addTextDisplayComponents(t5(`## 🗑️ Supprimer l'instance\n\n⚠️ **Cette action est irréversible.**\n\nTous les channels, données et configurations de **${ctx.name}** seront supprimés.`));
            c5.addSeparatorComponents(s5());
            c5.addActionRowComponents(r5(
              b5('dash:config:delete:confirm', 'Confirmer la suppression', bs5.Danger, '🗑️'),
              b5('dash:home', 'Annuler', bs5.Secondary, '◀️'),
            ));
          })]);
          await interaction.reply({ components: confirmPayload.components as never[], flags: confirmPayload.flags, ephemeral: true } as never);
        } else if (rawId === 'dash:config:delete:confirm') {
          await interaction.deferReply({ ephemeral: true });
          const deletedName = ctx.name;
          const ownerId = ctx.ownerId;
          try {
            // 1. Stop scheduler
            schedulers.get(ctx.id)?.stop();
            schedulers.delete(ctx.id);

            // 2. Clean global DB BEFORE deleting channels (so channelDelete events don't trigger errors)
            globalDb.prepare('DELETE FROM instance_secrets WHERE instance_id = ?').run(ctx.id);
            globalDb.prepare('DELETE FROM instance_channels WHERE instance_id = ?').run(ctx.id);
            globalDb.prepare("UPDATE instances SET status = 'deleted' WHERE id = ?").run(ctx.id);

            // 3. Unregister from memory (stops routing events to this instance)
            registry.unregister(ctx.id);

            // 4. Close + delete instance DB
            const { closeInstanceDatabase } = await import('./core/database.js');
            closeInstanceDatabase(ctx.id);
            const { rm } = await import('node:fs/promises');
            await rm(`data/instances/${ctx.id}`, { recursive: true, force: true });

            // 5. Delete Discord channels + category (do this LAST since it kills our interaction context)
            const guild = interaction.guild ?? await interaction.client.guilds.fetch(ctx.guildId);
            const channelMap = ctx.channels as unknown as Record<string, import('discord.js').TextChannel | undefined>;
            for (const channel of Object.values(channelMap)) {
              if (channel !== undefined) {
                try { await channel.delete(); } catch { /* already deleted */ }
              }
            }
            try {
              const category = await guild.channels.fetch(ctx.categoryId);
              if (category !== null) await category.delete();
            } catch { /* category already deleted */ }

            // 6. Send DM to owner + cleanup old bot DMs in DM channel
            try {
              const owner = await interaction.client.users.fetch(ownerId);
              const dmChannel = await owner.createDM();
              // Delete old bot messages in DM (cleanup)
              try {
                const messages = await dmChannel.messages.fetch({ limit: 50 });
                const botMessages = messages.filter((m) => m.author.id === interaction.client.user?.id);
                await Promise.allSettled(botMessages.map((m) => m.delete().catch(() => {})));
              } catch { /* can't fetch DMs */ }

              const { buildContainer: bcDm, txt: tDm, sep: sDm, btn: bDm, row: rDm, v2: vDm, getColor: gcDm, ButtonStyle: bsDm } = await import('./discord/component-builder-v2.js');
              const dmPayload = vDm([bcDm(gcDm('success'), (c) => {
                c.addTextDisplayComponents(tDm([
                  `## ✅ Instance **${deletedName}** supprimée`,
                  '',
                  'Tous les channels et données ont été nettoyés.',
                  '',
                  'Tu peux créer une nouvelle instance à tout moment.',
                ].join('\n')));
                c.addSeparatorComponents(sDm());
                c.addActionRowComponents(rDm(
                  bDm('onboard:start', 'Créer une nouvelle instance', bsDm.Success, '🚀'),
                  bDm('onboard:import', 'Importer une configuration', bsDm.Secondary, '📥'),
                ));
              })]);
              const { sendSplit: splitDm } = await import('./discord/message-splitter.js');
              await splitDm(owner, dmPayload);
            } catch { /* DMs disabled */ }

            // editReply will fail since the channel is deleted — that's expected
            try { await interaction.editReply({ content: '✅' }); } catch { /* channel deleted */ }
            getLogger().info({ instanceId: ctx.id }, 'Instance deleted');
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            getLogger().error({ instanceId: ctx.id, error: msg }, 'Instance deletion failed');
            try { await interaction.editReply({ content: `❌ Erreur lors de la suppression : ${msg}` }); } catch { /* channel may be deleted */ }
          }

        // ── Import config ──
        } else if (rawId === 'dash:config:import') {
          await autoDeleteReply(interaction, '📎 Envoie le fichier JSON exporté en message dans ce channel. (expire dans 2 min)', 15_000);

        // ── Navigation pages (ephemeral, by parsed subAction) ──
        } else {
          const { buildVeillePage } = await import('./dashboard/pages/veille.js');
          const { buildContentPage } = await import('./dashboard/pages/content.js');
          const { buildBudgetPage } = await import('./dashboard/pages/budget.js');
          const { buildConfigPage } = await import('./dashboard/pages/config.js');

          const subAction = parsed.targetTable;
          if (subAction === 'home') {
            const dashMsgId = registry.getChannelMessageId(ctx.id, 'dashboard');
            if (dashMsgId !== null) {
              await refreshDashboard(ctx.channels.dashboard, dashMsgId, ctx.db, ctx.name, ctx.createdAt, ctx.status === 'paused');
            }
            await autoDeleteReply(interaction, '🔄 Dashboard rafraîchi.');
          } else if (subAction === 'veille') {
            const payload = buildVeillePage(ctx.db, ctx.name);
            await interaction.reply({ components: payload.components as never[], flags: payload.flags, ephemeral: true } as never);
          } else if (subAction === 'content') {
            const payload = buildContentPage(ctx.db, ctx.name);
            await interaction.reply({ components: payload.components as never[], flags: payload.flags, ephemeral: true } as never);
          } else if (subAction === 'budget') {
            const payload = buildBudgetPage(ctx.db, ctx.name);
            await interaction.reply({ components: payload.components as never[], flags: payload.flags, ephemeral: true } as never);
          } else if (subAction === 'config') {
            const payload = buildConfigPage(ctx.db, ctx.name);
            await interaction.reply({ components: payload.components as never[], flags: payload.flags, ephemeral: true } as never);
          }
        }
      }
    },

    // ─── Instance messages (text in instance channels) ───
    instanceMessage: async (message, ctx) => {
      // Handle JSON import file in dashboard channel
      if (message.channelId === ctx.channels.dashboard.id && message.author.id === ctx.ownerId) {
        const attachment = message.attachments.find((a) => a.name?.endsWith('.json'));
        if (attachment !== undefined) {
          try {
            const response = await fetch(attachment.url);
            const content = await response.text();
            const { parseImportFile, applyImportToInstance } = await import('./onboarding/import.js');
            const importData = parseImportFile(content);
            applyImportToInstance(ctx.id, ctx.db, importData);
            const dashMsgId = registry.getChannelMessageId(ctx.id, 'dashboard');
            if (dashMsgId !== null) {
              await refreshDashboard(ctx.channels.dashboard, dashMsgId, ctx.db, ctx.name, ctx.createdAt, ctx.status === 'paused');
            }
            await message.reply({ content: `✅ Configuration importée : ${String(importData.categories.length)} catégories, ${String(importData.configOverrides.length)} overrides, persona ${importData.persona.length > 0 ? 'mis à jour' : 'inchangé'}.` });
            try { await message.delete(); } catch { /* can't delete */ }
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            await message.reply({ content: `❌ Import échoué : ${msg}` });
          }
          return;
        }
      }
      await handleAdminMessage(message, ctx);
    },

    // ─── Global interactions (DMs, onboarding) ───
    globalInteraction: async (interaction) => {
      await handleWizardInteraction(interaction, globalDb, registry);
    },

    // ─── DM text messages (wizard free text input) ───
    onDirectMessage: async (message) => {
      const { getActiveWizardSession, saveWizardSession } = await import('./onboarding/wizard/state-machine.js');

      // Find active wizard session for this user across all guilds
      const row = globalDb.prepare(
        "SELECT guild_id FROM wizard_sessions WHERE user_id = ? AND expires_at > datetime('now') ORDER BY created_at DESC LIMIT 1",
      ).get(message.author.id) as { guild_id: string } | undefined;

      if (row === undefined) return; // No active session

      const session = getActiveWizardSession(globalDb, row.guild_id, message.author.id);
      if (session === undefined) return;

      // Restore API key from session (survives hot-reload)
      const storedKey = (session.data as Record<string, unknown>)['_anthropicKey'];
      if (typeof storedKey === 'string' && storedKey.length > 0) {
        process.env['ANTHROPIC_API_KEY'] = storedKey;
      }

      // Handle JSON file import in import mode
      const isImportMode = (session.data as Record<string, unknown>)['_importMode'] === true;
      if (isImportMode && session.step === 'describe_project') {
        const attachment = message.attachments.find((a) => a.name?.endsWith('.json'));
        if (attachment !== undefined) {
          try {
            const response = await fetch(attachment.url);
            const content = await response.text();
            const { parseImportFile } = await import('./onboarding/import.js');
            const importData = parseImportFile(content);
            // Store import data in session for use during confirm
            (session.data as Record<string, unknown>)['_importData'] = importData;
            session.data.instanceName = importData.instanceName;
            session.data.projectName = importData.instanceName;
            saveWizardSession(globalDb, session);

            const { buildContainer: bc, txt: t, sep: s, btn: b, row: r, v2: v, getColor: gc, ButtonStyle: bs } = await import('./discord/component-builder-v2.js');
            const confirmPayload = v([bc(gc('success'), (c) => {
              c.addTextDisplayComponents(t([
                '## ✅ Configuration chargée',
                '',
                `**Instance** : ${importData.instanceName}`,
                `**Catégories** : ${String(importData.categories.length)}`,
                `**Config overrides** : ${String(importData.configOverrides.length)}`,
                `**Persona** : ${importData.persona.length > 0 ? `${String(importData.persona.length)} chars` : 'non défini'}`,
                '',
                'Prêt à créer l\'instance avec cette configuration ?',
              ].join('\n')));
              c.addSeparatorComponents(s());
              c.addActionRowComponents(r(
                b('wizard:confirm', 'Créer l\'instance', bs.Success, '🚀'),
                b('wizard:cancel', 'Annuler', bs.Danger, '✖️'),
              ));
            })]);
            await message.reply({ components: confirmPayload.components as never[], flags: confirmPayload.flags } as never);
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            await message.reply({ content: `❌ Fichier invalide : ${msg}` });
          }
          return;
        }
        // If no attachment, tell the user to send a file
        await message.reply({ content: '📎 Envoie un fichier `.json` exporté depuis le dashboard.' });
        return;
      }

      // Handle text based on current step
      if (session.step === 'describe_project') {
        // Free text fallback — parse into modal fields format
        const { processDescribeModal } = await import('./onboarding/wizard/describe.js');
        const { message: responsePayload } = await processDescribeModal(session, {
          projectName: message.content.split('\n')[0]?.slice(0, 100) ?? 'mon-projet',
          projectUrl: '',
          projectNiche: message.content.slice(0, 200),
          contentTypes: '',
          platforms: 'tiktok, instagram',
        });
        saveWizardSession(globalDb, session);
        await message.reply({ components: responsePayload.components as never[], flags: responsePayload.flags } as never);
        return;
      }

      // Handle refine_project answers (text free response to 6 questions)
      if (session.step === 'refine_project') {
        const { processRefineAnswers } = await import('./onboarding/wizard/refine-project.js');
        const { advanceStep } = await import('./onboarding/wizard/state-machine.js');
        await message.react('⏳');
        try {
          const { message: responsePayload } = await processRefineAnswers(session, message.content);
          // Auto-advance to validate_profile step
          advanceStep(session);
          saveWizardSession(globalDb, session);
          await message.reply({ components: responsePayload.components as never[], flags: responsePayload.flags } as never);
        } catch (error) {
          const errMsg = error instanceof Error ? error.message : String(error);
          getLogger().error({ error: errMsg }, 'Refine answers processing failed');
          await message.reply({ content: `❌ Erreur lors de l'analyse : ${errMsg.slice(0, 200)}. Réessaie.` });
        }
        return;
      }

      // Handle modification text for any step (when wizard:modify was clicked)
      const isModifying = (session.data as Record<string, unknown>)['_awaitingModification'] === true;
      if (!isModifying) return;

      // Clear the modification flag
      (session.data as Record<string, unknown>)['_awaitingModification'] = false;

      await message.react('⏳');

      try {
        if (session.step === 'review_categories') {
          const { buildCategoriesDisplay } = await import('./onboarding/wizard/categories.js');
          const { complete: llmComplete } = await import('./services/anthropic.js');
          const { addToHistory, recordIteration } = await import('./onboarding/wizard/state-machine.js');

          // Build full context of current categories
          const currentCats = session.data.categories ?? [];
          const catJson = JSON.stringify(currentCats.map((c, i) => ({
            index: i + 1,
            id: c.id,
            label: c.label,
            keywords: c.keywords,
            engines: c.engines,
            maxAgeHours: c.maxAgeHours,
          })), null, 2);

          addToHistory(session, 'user', message.content);

          const modResponse = await llmComplete(
            [
              'Tu modifies une liste de catégories de veille selon les instructions de l\'utilisateur.',
              'Applique EXACTEMENT ce que l\'utilisateur demande (retirer, ajouter, modifier).',
              'Ne regénère PAS les catégories — modifie la liste existante.',
              '',
              'Retourne UNIQUEMENT le JSON modifié, sans explication :',
              '{"categories": [{"id": "...", "label": "...", "keywords": {"en": [...], "fr": [...]}, "engines": [...], "maxAgeHours": N}]}',
            ].join('\n'),
            `Catégories actuelles :\n${catJson}\n\nInstruction utilisateur : ${message.content}`,
            { maxTokens: 2048, temperature: 0.2 },
          );

          recordIteration(session, modResponse.tokensIn, modResponse.tokensOut);

          try {
            const { extractJson } = await import('./core/json-extractor.js');
            const jsonText = extractJson(modResponse.text);
            const parsed = JSON.parse(jsonText) as { categories: Array<{ id: string; label: string; keywords: { en: string[]; fr: string[] }; engines: string[]; maxAgeHours: number }> };
            session.data.categories = parsed.categories.map((cat) => ({ ...cat, isActive: true }));
          } catch {
            // Parsing failed — tell the user
            await message.react('❌');
            await message.reply({ content: '⚠️ Je n\'ai pas pu appliquer la modification. Réessaie avec des instructions plus précises.' });
            saveWizardSession(globalDb, session);
            return;
          }

          saveWizardSession(globalDb, session);

          // Display the modified categories (no regeneration)
          const catPayload = buildCategoriesDisplay(session);
          await message.react('✅');
          await message.reply({ components: catPayload.components as never[], flags: catPayload.flags } as never);

        } else if (session.step.startsWith('review_persona_')) {
          // Modify persona section with user instructions (preserves existing content)
          const { modifyPersonaSection } = await import('./onboarding/wizard/persona.js');
          const sectionMap: Record<string, 'identity' | 'tone' | 'vocabulary' | 'art_direction' | 'examples'> = {
            review_persona_identity: 'identity',
            review_persona_tone: 'tone',
            review_persona_vocabulary: 'vocabulary',
            review_persona_art_direction: 'art_direction',
            review_persona_examples: 'examples',
          };
          const section = sectionMap[session.step];
          if (section !== undefined) {
            const payload = await modifyPersonaSection(session, section, message.content);
            saveWizardSession(globalDb, session);
            await message.react('✅');
            await message.reply({ components: payload.components as never[], flags: payload.flags } as never);
          }
        } else {
          await message.reply({ content: '❌ Cette étape n\'accepte pas de modification texte. Utilise les boutons.' });
        }
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        getLogger().error({ error: errMsg, step: session.step }, 'Wizard modification failed');
        await message.react('❌');
        await message.reply({ content: `⚠️ La modification a échoué : ${errMsg.slice(0, 200)}` });
      }

      saveWizardSession(globalDb, session);
    },

    // ─── Channel deleted ───
    onChannelDelete: async (channelId) => {
      const ctx = registry.resolveFromChannel(channelId);
      if (ctx === undefined) return;
      logger.warn({ instanceId: ctx.id, channelId }, 'Instance channel deleted');
      try {
        await sendSplit(ctx.channels.logs, buildErrorV2(`⚠️ Un channel de l'instance a été supprimé (ID: ${channelId}).`));
      } catch { /* logs channel itself may be deleted */ }
    },

    // ─── Bot added to guild ───
    onGuildCreate: async (guild) => {
      await handleGuildCreate(guild);
    },

    // ─── Bot removed from guild ───
    onGuildDelete: async (guild) => {
      const instances = registry.getByGuild(guild.id);
      for (const ctx of instances) {
        logger.info({ instanceId: ctx.id }, 'Bot removed from guild, archiving instance');
        schedulers.get(ctx.id)?.stop();
        schedulers.delete(ctx.id);
        globalDb.prepare("UPDATE instances SET status = 'archived' WHERE id = ?").run(ctx.id);
      }
    },
  });

  // ─── 6. Health + Update ───
  const health = await checkHealth();
  logger.info({ services: health.services }, 'Health check');

  const update = await checkForUpdate();
  if (update?.updateAvailable === true) {
    logger.info({ current: update.currentVersion, latest: update.latestVersion }, 'Update available');
  }

  // ─── 7. Shutdown ───
  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'Shutting down');
    for (const [, scheduler] of schedulers) scheduler.stop();
    closeAllDatabases();
    client.destroy();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  logger.info({ instances: registry.getAll().length, version: CURRENT_VERSION }, 'Bot is fully operational');
}

function startDerivationQueue(ctx: InstanceContext): void {
  const logger = getLogger();
  resetStuckJobs(ctx.db);

  const persona = personaLoader.loadForInstance(ctx.id, ctx.db);
  const processor = createQueueProcessor(ctx.db, async (job) => {
    const payload = JSON.parse(job.payload) as Record<string, unknown>;

    if (job.type === 'text_adaptation' || job.type === 'thread_generation' || job.type === 'article_generation' || job.type === 'carousel_generation') {
      return processDerivationJob(ctx.db, {
        derivationId: payload['derivationId'] as number,
        platform: payload['platform'] as string,
        format: payload['format'] as string,
        masterText: payload['masterText'] as string,
        masterImagePrompt: (payload['masterImagePrompt'] as string | null) ?? null,
        persona,
      }, ctx.channels.production);
    }

    if (job.type === 'image_crop' || job.type === 'image_generation' || job.type === 'video_generation') {
      const mediaPayload: Parameters<typeof processMediaJob>[1] = {
        derivationId: payload['derivationId'] as number,
        treeId: payload['treeId'] as number,
      };
      if (typeof payload['masterMediaId'] === 'number') {
        mediaPayload.masterMediaId = payload['masterMediaId'];
      }
      if (typeof payload['masterText'] === 'string') {
        mediaPayload.masterText = payload['masterText'];
      }
      return processMediaJob(ctx.db, mediaPayload, job.type, ctx.channels.production);
    }

    throw new Error(`Unknown job type: ${job.type}`);
  });

  processor.start();
  logger.info({ instanceId: ctx.id }, 'Derivation queue processor started');
}

function startInstanceScheduler(ctx: InstanceContext, registry: InstanceRegistry): InstanceScheduler {
  const scheduler = new InstanceScheduler(ctx.id, ctx.db);
  startDerivationQueue(ctx);

  const jobs: InstanceJob[] = [
    {
      name: 'veille',
      cronExpression: applyCronOffset(ctx.config.scheduler.veilleCron, ctx.cronOffsetMinutes),
      runOnMissed: true,
      handler: async () => {
        await handleVeilleCron(ctx);
        const dashMsgId = registry.getChannelMessageId(ctx.id, 'dashboard');
        if (dashMsgId !== null) {
          await refreshDashboard(ctx.channels.dashboard, dashMsgId, ctx.db, ctx.name, ctx.createdAt, false);
        }
      },
    },
    {
      name: 'suggestions',
      cronExpression: applyCronOffset(ctx.config.scheduler.suggestionsCron, ctx.cronOffsetMinutes),
      runOnMissed: true,
      handler: async () => {
        await handleSuggestionsCron(ctx);
        const dashMsgId = registry.getChannelMessageId(ctx.id, 'dashboard');
        if (dashMsgId !== null) {
          await refreshDashboard(ctx.channels.dashboard, dashMsgId, ctx.db, ctx.name, ctx.createdAt, false);
        }
      },
    },
    {
      name: 'rapport',
      cronExpression: applyCronOffset(ctx.config.scheduler.rapportCron, ctx.cronOffsetMinutes),
      runOnMissed: false,
      handler: async () => {
        await handleWeeklyRapport(ctx);
      },
    },
  ];

  scheduler.start(jobs);
  return scheduler;
}

main().catch((error) => {
  console.error('Fatal error during V2 startup:', error);
  process.exit(1);
});
