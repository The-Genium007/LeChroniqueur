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
import { handleVeilleCronV2 } from './handlers/veille.js';
import { handleSuggestionsCronV2 } from './handlers/suggestions.js';
import { handleWeeklyRapportV2 } from './handlers/rapport.js';
import { handleAdminMessageV2 } from './handlers/conversation.js';
import { setPendingModification } from './handlers/conversation.js';
import { upsertRating } from './feedback/ratings.js';
import { deepDive } from './veille/deep-dive.js';
import { generateFinalScript } from './content/scripts.js';
import { recordAnthropicUsage } from './budget/tracker.js';
import {
  production as buildProductionV1,
  deepDiveResult as buildDeepDiveV1,
  errorMessage as buildErrorV1,
} from './discord/message-builder.js';
import { handleGenerateImages } from './handlers/production.js';
import { handlePublish } from './handlers/publication.js';
import { handleWizardInteraction } from './onboarding/wizard/orchestrator.js';
import type { InstanceContext } from './registry/instance-context.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger();

  logger.info({ version: CURRENT_VERSION, env: config.NODE_ENV, dryRun: config.DRY_RUN, mockApis: config.MOCK_APIS }, 'Starting Le Chroniqueur V2');

  if (isLegacyMode()) {
    logger.info('Legacy mode detected (channel IDs in env). Please use: node dist/index.js');
    process.exit(0);
  }

  // ─── 1. Global Database ───
  const globalDb = createGlobalDatabase();

  // ─── 2. Discord Client ───
  const client = createClient();
  await loginBot(client);
  logger.info({ tag: client.user?.tag }, 'Bot connected to Discord');

  // ─── 3. Instance Registry ───
  const registry = new InstanceRegistry(globalDb, client);
  await registry.loadAll();
  logger.info({ instanceCount: registry.getAll().length }, 'Instances loaded');

  // ─── 4. Per-instance setup ───
  const schedulers = new Map<string, InstanceScheduler>();

  for (const ctx of registry.getAll()) {
    if (ctx.status !== 'active') continue;

    // Set API key in process.env so the Anthropic service can use it
    if (ctx.secrets.anthropicApiKey.length > 0) {
      process.env['ANTHROPIC_API_KEY'] = ctx.secrets.anthropicApiKey;
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
      // Handle search modal submission
      if (interaction.isModalSubmit() && interaction.customId === 'search:modal:query') {
        const query = interaction.fields.getTextInputValue('query');
        const { search: ftsSearch, searchCount } = await import('./search/engine.js');
        const { searchResults: buildSearchResultsV2 } = await import('./discord/component-builder-v2.js');
        const { trackTempMessage } = await import('./dashboard/search.js');

        const results = ftsSearch(ctx.db, query, 10, 0);
        const total = searchCount(ctx.db, query);
        const mapped = results.map((r) => ({ sourceTable: r.sourceTable, sourceId: r.sourceId, title: r.title, snippet: r.snippet }));
        const payload = buildSearchResultsV2(mapped, query, 1, total);

        await interaction.reply({ components: payload.components as never[], flags: payload.flags } as never);
        if (interaction.channelId !== null) {
          trackTempMessage(interaction.channelId, interaction.id);
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
        await interaction.update({ components: [] });
      } else if (action === 'transform') {
        await interaction.deferReply();
        try {
          const result = await deepDive(ctx.db, targetId);
          recordAnthropicUsage(ctx.db, result.tokensUsed.input, result.tokensUsed.output);
          const article = ctx.db.prepare('SELECT title, translated_title FROM veille_articles WHERE id = ?')
            .get(targetId) as { title: string; translated_title: string | null } | undefined;
          const title = article?.translated_title ?? article?.title ?? 'Article';
          const payload = buildDeepDiveV1({ articleTitle: title, analysis: result.analysis, contentSuggestions: result.contentSuggestions, articleId: targetId });
          await interaction.editReply({ embeds: payload.embeds, components: payload.components });
          ctx.db.prepare('UPDATE veille_articles SET status = ? WHERE id = ?').run('transformed', targetId);
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          const payload = buildErrorV1(`Deep dive échoué : ${msg}`);
          await interaction.editReply({ embeds: payload.embeds });
        }
      } else if (action === 'transform_accept') {
        ctx.db.prepare('UPDATE veille_articles SET status = ? WHERE id = ?').run('proposed', targetId);
        await autoDeleteReply(interaction, '✅ Article marqué pour transformation.');

      // Suggestion buttons
      } else if (action === 'go') {
        await interaction.deferUpdate();
        ctx.db.prepare("UPDATE suggestions SET status = ?, decided_at = datetime('now') WHERE id = ?").run('go', targetId);
        upsertRating(ctx.db, 'suggestions', targetId, 1, interaction.user.id);
        await interaction.editReply({ components: [] });
        try {
          const suggestion = ctx.db.prepare('SELECT content, platform, format FROM suggestions WHERE id = ?')
            .get(targetId) as { content: string; platform: string; format: string | null } | undefined;
          if (suggestion !== undefined) {
            const script = await generateFinalScript(suggestion.content, suggestion.platform, suggestion.format ?? 'reel');
            const payload = buildProductionV1({ id: targetId, textOverlay: script.textOverlay, fullScript: script.fullScript, hashtags: script.hashtags, platform: script.platform, suggestedTime: script.suggestedTime, notes: script.notes });
            await ctx.channels.production.send({ embeds: payload.embeds, components: payload.components });
          }
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          getLogger().error({ error: msg, suggestionId: targetId }, 'Failed to generate script');
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
        await interaction.update({ components: [] });
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
        await interaction.update({ components: [] });
        await autoDeleteReply(interaction, '🖼️ Variante sélectionnée.');

      // Publication buttons
      } else if (action === 'pub') {
        const rawId = interaction.customId;
        if (rawId.startsWith('pub:copy:')) {
          const suggestion = ctx.db.prepare('SELECT content FROM suggestions WHERE id = ?').get(targetId) as { content: string } | undefined;
          await interaction.reply({ content: suggestion?.content ?? 'Contenu introuvable.', ephemeral: true });
        } else if (rawId.startsWith('pub:done:')) {
          ctx.db.prepare("UPDATE publications SET status = 'published', published_at = datetime('now') WHERE suggestion_id = ?").run(targetId);
          await interaction.update({ components: [] });
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
        } else if (rawId.startsWith('search:recent:')) {
          const type = rawId.split(':')[2] ?? 'articles';
          let results;
          if (type === 'articles') {
            results = ctx.db.prepare("SELECT id, title, translated_title FROM veille_articles ORDER BY collected_at DESC LIMIT 10").all() as Array<{ id: number; title: string; translated_title: string | null }>;
            const lines = results.map((r) => `► ${r.translated_title ?? r.title}`);
            await interaction.reply({ content: lines.length > 0 ? `**📰 Articles récents :**\n${lines.join('\n')}` : 'Aucun article.', ephemeral: true });
          } else if (type === 'suggestions') {
            results = ctx.db.prepare("SELECT id, content FROM suggestions ORDER BY created_at DESC LIMIT 10").all() as Array<{ id: number; content: string }>;
            const lines = results.map((r) => `► ${r.content.slice(0, 80)}...`);
            await interaction.reply({ content: lines.length > 0 ? `**💡 Suggestions récentes :**\n${lines.join('\n')}` : 'Aucune suggestion.', ephemeral: true });
          } else {
            results = ctx.db.prepare("SELECT id, content, platform FROM publications ORDER BY created_at DESC LIMIT 10").all() as Array<{ id: number; content: string; platform: string }>;
            const lines = results.map((r) => `► [${r.platform}] ${r.content.slice(0, 60)}...`);
            await interaction.reply({ content: lines.length > 0 ? `**📤 Publications récentes :**\n${lines.join('\n')}` : 'Aucune publication.', ephemeral: true });
          }
        }

      // Dashboard buttons — route by raw customId for actions, parsed for nav
      } else if (action === 'dash') {
        const rawId = interaction.customId;

        // ── Action buttons (match raw customId first) ──
        if (rawId === 'dash:veille:run') {
          await interaction.deferReply({ ephemeral: true });
          await handleVeilleCronV2(ctx);
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
          await handleSuggestionsCronV2(ctx);
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

        // ── Postiz accounts ──
        } else if (rawId === 'dash:config:postiz' || rawId === 'dash:config:postiz:refresh') {
          await interaction.deferReply({ ephemeral: true });
          try {
            const { listIntegrations } = await import('./services/postiz.js');
            const integrations = await listIntegrations();
            const lines = integrations.length > 0
              ? integrations.map((i: { name: string; identifier: string; disabled: boolean }) => `${i.disabled ? '❌' : '✅'} **${i.name}** (${i.identifier})`).join('\n')
              : 'Aucun compte connecté.';
            const postizUrl = process.env['POSTIZ_URL'] ?? 'http://localhost:5000';
            const { buildContainer: bc4, txt: t4, sep: s4, btn: b4, row: r4, v2: v24, getColor: gc4, ButtonStyle: bs4 } = await import('./discord/component-builder-v2.js');
            const postizPayload = v24([bc4(gc4('info'), (c4) => {
              c4.addTextDisplayComponents(t4(`## 📤 Comptes Postiz\n\n${lines}\n\nPour ajouter ou supprimer des comptes, rendez-vous sur :\n${postizUrl}`));
              c4.addSeparatorComponents(s4());
              c4.addActionRowComponents(r4(
                b4('dash:config:postiz:refresh', 'Rafraîchir', bs4.Secondary, '🔄'),
              ));
            })]);
            await interaction.editReply({ components: postizPayload.components as never[] } as never);
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            await interaction.editReply({ content: `⚠️ Impossible de lister les comptes Postiz : ${msg}` });
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
          try {
            // 1. Stop scheduler
            schedulers.get(ctx.id)?.stop();
            schedulers.delete(ctx.id);

            // 2. Delete Discord channels + category
            const guild = interaction.guild ?? await interaction.client.guilds.fetch(ctx.guildId);
            const channelMap = ctx.channels as unknown as Record<string, import('discord.js').TextChannel | undefined>;
            for (const channel of Object.values(channelMap)) {
              if (channel !== undefined) {
                try { await channel.delete(); } catch { /* already deleted */ }
              }
            }
            // Delete the category
            try {
              const category = await guild.channels.fetch(ctx.categoryId);
              if (category !== null) await category.delete();
            } catch { /* category already deleted */ }

            // 3. Clean global DB
            globalDb.prepare('DELETE FROM instance_secrets WHERE instance_id = ?').run(ctx.id);
            globalDb.prepare('DELETE FROM instance_channels WHERE instance_id = ?').run(ctx.id);
            globalDb.prepare("UPDATE instances SET status = 'deleted' WHERE id = ?").run(ctx.id);

            // 4. Close + delete instance DB
            ctx.db.close();
            const { rm } = await import('node:fs/promises');
            await rm(`data/instances/${ctx.id}`, { recursive: true, force: true });

            // 5. Unregister from memory
            registry.unregister(ctx.id);

            await interaction.editReply({ content: `✅ Instance **${ctx.name}** supprimée.` });
            getLogger().info({ instanceId: ctx.id }, 'Instance deleted');
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            getLogger().error({ instanceId: ctx.id, error: msg }, 'Instance deletion failed');
            await interaction.editReply({ content: `❌ Erreur lors de la suppression : ${msg}` });
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
      await handleAdminMessageV2(message, ctx);
    },

    // ─── Global interactions (DMs, onboarding) ───
    globalInteraction: async (interaction) => {
      await handleWizardInteraction(interaction, globalDb, registry);
    },

    // ─── DM text messages (wizard free text input) ───
    onDirectMessage: async (message) => {
      const { getActiveWizardSession, saveWizardSession } = await import('./onboarding/wizard/state-machine.js');
      const { processDescription } = await import('./onboarding/wizard/describe.js');

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

      // Only handle text in steps that expect free text
      if (session.step === 'describe_project') {
        const { message: responsePayload } = await processDescription(session, message.content);
        saveWizardSession(globalDb, session);
        await message.reply({ components: responsePayload.components as never[], flags: responsePayload.flags } as never);
      }
      // Other steps that might accept text can be added here
    },

    // ─── Channel deleted ───
    onChannelDelete: async (channelId) => {
      const ctx = registry.resolveFromChannel(channelId);
      if (ctx === undefined) return;
      logger.warn({ instanceId: ctx.id, channelId }, 'Instance channel deleted');
      try {
        const payload = buildErrorV1(`⚠️ Un channel de l'instance a été supprimé (ID: ${channelId}).`);
        await ctx.channels.logs.send({ embeds: payload.embeds });
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

  logger.info({ instances: registry.getAll().length, version: CURRENT_VERSION }, 'Le Chroniqueur V2 is fully operational');
}

function startInstanceScheduler(ctx: InstanceContext, registry: InstanceRegistry): InstanceScheduler {
  const scheduler = new InstanceScheduler(ctx.id, ctx.db);

  const jobs: InstanceJob[] = [
    {
      name: 'veille',
      cronExpression: applyCronOffset(ctx.config.scheduler.veilleCron, ctx.cronOffsetMinutes),
      runOnMissed: true,
      handler: async () => {
        await handleVeilleCronV2(ctx);
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
        await handleSuggestionsCronV2(ctx);
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
        await handleWeeklyRapportV2(ctx);
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
