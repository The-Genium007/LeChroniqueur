import type { ButtonInteraction, ModalSubmitInteraction, Interaction } from 'discord.js';
import {
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
} from 'discord.js';
import { getLogger } from '../../core/logger.js';
import type { SqliteDatabase } from '../../core/database.js';
import { createInstanceDatabase } from '../../core/database.js';
import {
  createWizardSession,
  getActiveWizardSession,
  saveWizardSession,
  deleteWizardSession,
  advanceStep,
  goToStep,
  canIterate,
  trackDmMessageId,
  type WizardSession,
} from './state-machine.js';
import { buildDescribePrompt } from './describe.js';
import { generateCategories } from './categories.js';
import { dryRunCategories } from './dryrun.js';
import { buildToneSelection, setTone, generatePersonaSection, assemblePersona, buildNeutralPersona } from './persona.js';
import { buildPlatformSelection, buildScheduleConfig, togglePlatform, setScheduleMode, setVeilleDay, togglePublicationDay } from './platforms.js';
import {
  buildSourcesSelection,
  toggleSource,
  buildRssConfigModal,
  buildRedditConfigModal,
  buildYouTubeConfigModal,
  miniDryRunSources,
} from './sources.js';
import {
  buildProviderSelection,
  buildModelSelection,
  buildApiKeyModal,
  buildCustomModelModal,
  buildValidationResult,
  setLlmProvider,
  setLlmModel,
  setLlmApiKey,
  setLlmBaseUrl,
  getLlmSessionConfig,
} from './llm-selection.js';
import { validateLlmKey } from '../api-keys.js';
import { getProvider as getLlmProvider } from '../../services/llm-providers.js';
import { buildConfirmation } from './confirm.js';
import { validateAnthropicKey, storeInstanceSecret } from '../api-keys.js';
import {
  PLATFORM_CONFIG,
  type PlatformId,
  buildPostizScreen,
  buildPostizMoreScreen,
  buildPlatformDetail,
  getConfiguredPlatforms,
  configurePlatform,
  removePlatform,
  verifyPostizIntegrations,
} from '../postiz-setup.js';
import { validateInfrastructure, createInfrastructure, registerChannels } from '../infrastructure.js';
import { saveProfile, upsertConfigOverride } from '../../core/instance-profile.js';
import { upsertSource } from '../../veille/sources/index.js';
import { saveScheduleConfig } from '../../core/scheduler-weekly.js';
import { sendSplit } from '../../discord/message-splitter.js';
import { buildSearchInterface } from '../../dashboard/search.js';
import { buildDashboardHome, collectDashboardHomeData } from '../../dashboard/pages/home.js';
import {
  buildContainer, txt, sep, btn, row, v2, getColor,
  ButtonStyle,
} from '../../discord/component-builder-v2.js';
import type { InstanceRegistry } from '../../registry/instance-registry.js';

/**
 * Send a V2 message as a DM. Interaction replies don't support V2 containers,
 * so we send via user.send() and acknowledge the interaction separately.
 * If a session is provided, the message ID is tracked for later cleanup.
 */
async function sendWizardDM(
  interaction: ButtonInteraction | ModalSubmitInteraction,
  payload: { components: unknown[]; flags: number },
  session?: WizardSession,
): Promise<void> {
  const ids = await sendSplit(interaction.user, payload as import('../../discord/component-builder-v2.js').V2MessagePayload);
  if (session !== undefined) {
    for (const id of ids) trackDmMessageId(session, id);
  }
  // Acknowledge the interaction silently — ignore if expired
  if (!interaction.replied && !interaction.deferred) {
    try { await interaction.deferUpdate(); } catch { /* interaction expired */ }
  }
}

/**
 * Send a V2 payload as DM (with splitting) and track all message IDs in the session.
 * Returns the sent message IDs.
 */
async function dmSplit(
  user: import('discord.js').User,
  payload: import('../../discord/component-builder-v2.js').V2MessagePayload,
  session: WizardSession,
): Promise<string[]> {
  const ids = await sendSplit(user, payload);
  for (const id of ids) trackDmMessageId(session, id);
  return ids;
}

/**
 * Delete ALL bot messages in the DM channel by paginating through the entire history.
 * Discord only allows the bot to delete its own messages in DMs.
 */
async function cleanupWizardDMs(user: import('discord.js').User, _session: WizardSession): Promise<void> {
  try {
    const dmChannel = await user.createDM();
    const botId = user.client.user?.id;
    if (botId === undefined) return;

    let lastId: string | undefined;
    let totalDeleted = 0;

    // Paginate through all messages in the DM channel
    for (let page = 0; page < 10; page++) {
      const fetchOptions: { limit: number; before?: string } = { limit: 100 };
      if (lastId !== undefined) fetchOptions.before = lastId;

      const messages = await dmChannel.messages.fetch(fetchOptions);
      if (messages.size === 0) break;

      const botMessages = messages.filter((m) => m.author.id === botId);
      if (botMessages.size > 0) {
        await Promise.allSettled(botMessages.map((m) => m.delete().catch(() => {})));
        totalDeleted += botMessages.size;
      }

      // Move cursor to oldest message in this batch
      const oldest = messages.last();
      if (oldest === undefined || messages.size < 100) break;
      lastId = oldest.id;
    }

    if (totalDeleted > 0) {
      getLogger().debug({ userId: user.id, deleted: totalDeleted }, 'Cleaned up wizard DMs');
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    getLogger().warn({ userId: user.id, error: msg }, 'Failed to cleanup wizard DMs');
  }
}

/**
 * Handle all onboarding/wizard interactions (buttons + modals in DMs).
 */
export async function handleWizardInteraction(
  interaction: Interaction,
  globalDb: SqliteDatabase,
  registry: InstanceRegistry,
): Promise<void> {
  // ─── /setup slash command ───
  if (interaction.isChatInputCommand() && interaction.commandName === 'setup') {
    const instances = registry.getByGuild(interaction.guildId ?? '');
    const hasInstances = instances.length > 0;

    const payload = v2([buildContainer(getColor('primary'), (c) => {
      c.addTextDisplayComponents(txt([
        '# 🔧 Setup — Le Chroniqueur',
        '',
        hasInstances
          ? `Tu as **${String(instances.length)}** instance(s) sur ce serveur.\nUtilise le dashboard dans tes channels pour les gérer.`
          : 'Aucune instance sur ce serveur.',
        '',
        'Tu peux créer une nouvelle instance ou importer une configuration existante.',
      ].join('\n')));
      c.addSeparatorComponents(sep());
      c.addActionRowComponents(row(
        btn('onboard:start', 'Créer une instance', ButtonStyle.Success, '🚀'),
        btn('onboard:import', 'Importer une config', ButtonStyle.Secondary, '📥'),
      ));
    })]);

    try {
      await sendSplit(interaction.user, payload);
      await interaction.reply({ content: '📬 Check tes DMs !', ephemeral: true });
    } catch {
      await interaction.reply({ content: '❌ Impossible d\'envoyer un DM. Vérifie que tes DMs sont activés.', ephemeral: true });
    }
    return;
  }

  // ─── Modal submissions ───
  if (interaction.isModalSubmit()) {
    await handleModalSubmit(interaction, globalDb, registry);
    return;
  }

  if (!interaction.isButton()) return;

  const customId = interaction.customId;

  // ─── onboard:start — begin the wizard ───
  if (customId === 'onboard:start') {
    let guildId = interaction.guildId ?? interaction.message?.guildId ?? null;

    // In DMs, find the guild where this user is owner and the bot is present
    if (guildId === null && interaction.client !== undefined) {
      const userGuild = interaction.client.guilds.cache.find(
        (g) => g.ownerId === interaction.user.id,
      );
      if (userGuild !== undefined) {
        guildId = userGuild.id;
      }
    }

    if (guildId === null) {
      await interaction.reply({ content: '❌ Impossible de trouver ton serveur. Ajoute le bot à un serveur dont tu es propriétaire.', ephemeral: true });
      return;
    }

    // Defer immediately — cleanup can take a while
    await interaction.deferReply({ ephemeral: true });

    // If a session already exists, clean it up and start fresh
    const existingSession = getActiveWizardSession(globalDb, guildId, interaction.user.id);
    if (existingSession !== undefined) {
      await cleanupWizardDMs(interaction.user, existingSession);
      deleteWizardSession(globalDb, existingSession.id);
    }

    const session = createWizardSession(globalDb, guildId, interaction.user.id);
    saveWizardSession(globalDb, session);
    // Step 1: Gemini key (obligatoire) — show modal directly
    const geminiPrompt = v2([buildContainer(getColor('primary'), (c) => {
      c.addTextDisplayComponents(txt([
        '## 🔑 Clé Gemini (obligatoire)',
        '',
        'Pour générer des images et vidéos, une clé **Google AI Studio** (Gemini) est requise.',
        'Crée-en une sur [Google AI Studio](https://aistudio.google.com/apikey).',
        '',
        'Tu pourras aussi l\'utiliser comme provider LLM pour l\'analyse de texte.',
      ].join('\n')));
      c.addSeparatorComponents(sep());
      c.addActionRowComponents(row(
        btn('onboard:gemini:enter', 'Entrer ma clé Gemini', ButtonStyle.Primary, '🔑'),
      ));
    })]);
    await dmSplit(interaction.user, geminiPrompt, session);
    saveWizardSession(globalDb, session);
    try { await interaction.editReply({ content: '📩 Check tes DMs !' }); } catch { /* expired */ }
    return;
  }

  // ─── onboard:import — import flow ───
  if (customId === 'onboard:import') {
    let guildId = interaction.guildId ?? interaction.message?.guildId ?? null;
    if (guildId === null && interaction.client !== undefined) {
      const userGuild = interaction.client.guilds.cache.find(
        (g) => g.ownerId === interaction.user.id,
      );
      if (userGuild !== undefined) guildId = userGuild.id;
    }
    if (guildId === null) {
      await interaction.reply({ content: '❌ Impossible de trouver ton serveur.', ephemeral: true });
      return;
    }
    const session = createWizardSession(globalDb, guildId, interaction.user.id);
    (session.data as Record<string, unknown>)['_importMode'] = true;
    saveWizardSession(globalDb, session);
    // Import mode also starts with Gemini key
    await interaction.deferReply({ ephemeral: true });
    const importGeminiPrompt = v2([buildContainer(getColor('primary'), (c) => {
      c.addTextDisplayComponents(txt([
        '## 🔑 Clé Gemini (obligatoire)',
        '',
        'Avant d\'importer, entre ta clé Google AI Studio (Gemini).',
      ].join('\n')));
      c.addSeparatorComponents(sep());
      c.addActionRowComponents(row(
        btn('onboard:gemini:enter', 'Entrer ma clé Gemini', ButtonStyle.Primary, '🔑'),
      ));
    })]);
    await dmSplit(interaction.user, importGeminiPrompt, session);
    saveWizardSession(globalDb, session);
    try { await interaction.editReply({ content: '📩 Check tes DMs !' }); } catch { /* expired */ }
    return;
  }

  // ─── Gemini key flow ───
  if (customId === 'onboard:gemini:enter') {
    const modal = new ModalBuilder()
      .setCustomId('wizard:modal:gemini')
      .setTitle('Clé Gemini (Google AI Studio)')
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId('gemini_key')
            .setLabel('Clé API Gemini (AIza...)')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('AIza...')
            .setRequired(true),
        ),
      );
    await interaction.showModal(modal);
    return;
  }

  if (customId === 'onboard:gemini:llm:yes') {
    // User wants Gemini as LLM too — set provider + reuse Gemini key as LLM key
    const session = findSessionForUser(globalDb, interaction);
    if (session === undefined) return;
    setLlmProvider(session, 'google');
    session.data.llmProvider = 'google';
    // Reuse the Gemini key as LLM key
    const geminiKey = (session.data as Record<string, unknown>)['_geminiKey'] as string | undefined;
    if (geminiKey !== undefined) {
      setLlmApiKey(session, geminiKey);
      (session.data as Record<string, unknown>)['_anthropicKey'] = geminiKey;
      process.env['ANTHROPIC_API_KEY'] = geminiKey;
    }
    saveWizardSession(globalDb, session);
    // Show model selection for Gemini
    const payload = buildModelSelection(session);
    await interaction.deferReply({ ephemeral: true });
    await dmSplit(interaction.user, payload, session);
    saveWizardSession(globalDb, session);
    try { await interaction.editReply({ content: '✅' }); interaction.deleteReply().catch(() => {}); } catch { /* expired */ }
    return;
  }

  if (customId === 'onboard:gemini:llm:no') {
    // User wants a separate LLM provider — show provider selection
    const session = findSessionForUser(globalDb, interaction);
    if (session === undefined) return;
    const payload = buildProviderSelection(session);
    await interaction.deferReply({ ephemeral: true });
    await dmSplit(interaction.user, payload, session);
    saveWizardSession(globalDb, session);
    try { await interaction.editReply({ content: '✅' }); interaction.deleteReply().catch(() => {}); } catch { /* expired */ }
    return;
  }

  // ─── onboard:key:* — API key entry buttons ───
  if (customId === 'onboard:key:anthropic') {
    // Legacy button — redirect to new LLM provider selection
    const session = findSessionForUser(globalDb, interaction);
    if (session !== undefined) {
      setLlmProvider(session, 'anthropic');
      session.data.llmProvider = 'anthropic';
      saveWizardSession(globalDb, session);
      const payload = buildModelSelection(session);
      await interaction.deferReply({ ephemeral: true });
      await dmSplit(interaction.user, payload, session);
      saveWizardSession(globalDb, session);
      try { await interaction.editReply({ content: '✅' }); interaction.deleteReply().catch(() => {}); } catch { /* expired */ }
    }
    return;
  }

  if (customId === 'onboard:key:google') {
    await interaction.showModal(buildGoogleKeyModal());
    return;
  }

  if (customId === 'onboard:skip:google') {
    await advanceToPostiz(interaction, globalDb);
    return;
  }

  // ─── Postiz setup buttons ───
  if (customId.startsWith('onboard:postiz:')) {
    const sub = customId.replace('onboard:postiz:', '');

    if (sub === 'skip') {
      await advanceToDescribe(interaction, globalDb);
      return;
    }

    if (sub === 'verify' || sub === 'back') {
      // Show/refresh the main Postiz screen with updated statuses
      await interaction.deferReply({ ephemeral: true });
      const result = await verifyPostizIntegrations();
      const payload = await buildPostizScreen('onboard:postiz', result.connected);
      const verifySession = findSessionForUser(globalDb, interaction);
      if (verifySession !== undefined) {
        await dmSplit(interaction.user, payload, verifySession);
        saveWizardSession(globalDb, verifySession);
      } else {
        await sendSplit(interaction.user, payload);
      }
      try { await interaction.editReply({ content: '✅' }); interaction.deleteReply().catch(() => {}); } catch { /* expired */ }
      return;
    }

    if (sub === 'more') {
      await interaction.deferReply({ ephemeral: true });
      const result = await verifyPostizIntegrations();
      let configured: PlatformId[];
      try { configured = await getConfiguredPlatforms(); } catch { configured = []; }
      const payload = buildPostizMoreScreen('onboard:postiz', result.connected, configured);
      const moreSession = findSessionForUser(globalDb, interaction);
      if (moreSession !== undefined) {
        await dmSplit(interaction.user, payload, moreSession);
        saveWizardSession(globalDb, moreSession);
      } else {
        await sendSplit(interaction.user, payload);
      }
      try { await interaction.editReply({ content: '✅' }); interaction.deleteReply().catch(() => {}); } catch { /* expired */ }
      return;
    }

    if (sub === 'done') {
      // Check if at least one platform is configured or connected
      await interaction.deferReply({ ephemeral: true });
      const result = await verifyPostizIntegrations();
      let configured: PlatformId[];
      try { configured = await getConfiguredPlatforms(); } catch { configured = []; }

      if (result.connected.length === 0 && configured.length === 0) {
        const warnPayload = v2([buildContainer(getColor('warning'), (c) => {
          c.addTextDisplayComponents(txt([
            '## ⚠️ Aucune plateforme configurée',
            '',
            'Tu n\'as configuré aucune plateforme sociale.',
            'Tu pourras le faire plus tard depuis le dashboard.',
          ].join('\n')));
          c.addSeparatorComponents(sep());
          c.addActionRowComponents(row(
            btn('onboard:postiz:force', 'Continuer quand même', ButtonStyle.Secondary, '⏭️'),
            btn('onboard:postiz:back', 'Configurer', ButtonStyle.Primary, '🔧'),
          ));
        })]);
        const warnSession = findSessionForUser(globalDb, interaction);
        if (warnSession !== undefined) {
          await dmSplit(interaction.user, warnPayload, warnSession);
          saveWizardSession(globalDb, warnSession);
        } else {
          await sendSplit(interaction.user, warnPayload);
        }
        try { await interaction.editReply({ content: '✅' }); interaction.deleteReply().catch(() => {}); } catch { /* expired */ }
        return;
      }

      // Store configured + connected platforms for step 11 (platform selection)
      const allPostizPlatforms = [...new Set([...configured, ...result.connected])];
      const doneSession = findSessionForUser(globalDb, interaction);
      if (doneSession !== undefined) {
        (doneSession.data as Record<string, unknown>)['_configuredPostizPlatforms'] = allPostizPlatforms;
        // Pre-select all configured platforms
        doneSession.data.platforms = allPostizPlatforms;
        saveWizardSession(globalDb, doneSession);
      }

      try { await interaction.editReply({ content: '✅' }); interaction.deleteReply().catch(() => {}); } catch { /* expired */ }
      await advanceToDescribe(interaction, globalDb);
      return;
    }

    if (sub === 'force') {
      await advanceToDescribe(interaction, globalDb);
      return;
    }

    // Platform detail: onboard:postiz:platform:{id}
    if (sub.startsWith('platform:')) {
      const platformId = sub.replace('platform:', '') as PlatformId;
      const def = PLATFORM_CONFIG[platformId];
      if (def === undefined) return;
      await interaction.deferReply({ ephemeral: true });
      const result = await verifyPostizIntegrations();
      let configured: PlatformId[];
      try { configured = await getConfiguredPlatforms(); } catch { configured = []; }
      const isConnected = result.connected.includes(platformId);
      const isConfigured = configured.includes(platformId);
      const payload = buildPlatformDetail('onboard:postiz', platformId, isConfigured, isConnected);
      const detailSession = findSessionForUser(globalDb, interaction);
      if (detailSession !== undefined) {
        await dmSplit(interaction.user, payload, detailSession);
        saveWizardSession(globalDb, detailSession);
      } else {
        await sendSplit(interaction.user, payload);
      }
      try { await interaction.editReply({ content: '✅' }); interaction.deleteReply().catch(() => {}); } catch { /* expired */ }
      return;
    }

    // Open keys modal: onboard:postiz:keys:{id}
    if (sub.startsWith('keys:')) {
      const platformId = sub.replace('keys:', '') as PlatformId;
      const def = PLATFORM_CONFIG[platformId];
      if (def === undefined) return;
      const modal = new ModalBuilder()
        .setCustomId(`wizard:modal:postiz:${platformId}`)
        .setTitle(`${def.label} — Clés API`);
      for (let i = 0; i < def.envVars.length && i < 5; i++) {
        const envVar = def.envVars[i];
        const label = def.envLabels[i] ?? envVar;
        if (envVar === undefined) continue;
        modal.addComponents(
          new ActionRowBuilder<TextInputBuilder>().addComponents(
            new TextInputBuilder()
              .setCustomId(envVar)
              .setLabel(label ?? envVar)
              .setStyle(TextInputStyle.Short)
              .setRequired(true),
          ),
        );
      }
      await interaction.showModal(modal);
      return;
    }

    // Remove platform: onboard:postiz:remove:{id}
    if (sub.startsWith('remove:')) {
      const platformId = sub.replace('remove:', '') as PlatformId;
      const def = PLATFORM_CONFIG[platformId];
      if (def === undefined) return;
      await interaction.deferReply({ ephemeral: true });
      try {
        await removePlatform(platformId);
        await interaction.editReply({ content: `✅ ${def.label} supprimé. Postiz redémarré.` });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        await interaction.editReply({ content: `⚠️ Erreur : ${msg}` });
      }
      // Auto-refresh main screen after a short delay
      setTimeout(async () => {
        try {
          const result = await verifyPostizIntegrations();
          const payload = await buildPostizScreen('onboard:postiz', result.connected);
          await sendSplit(interaction.user, payload);
        } catch { /* best effort */ }
      }, 2000);
      return;
    }

    return;
  }

  // ─── wizard:* — wizard step navigation ───
  const session = findSessionForUser(globalDb, interaction);
  if (session === undefined) {
    await interaction.reply({ content: 'Session expirée. Relance l\'onboarding.', ephemeral: true });
    return;
  }

  if (customId === 'wizard:next') {
    await handleWizardNext(interaction, session, globalDb, registry);
  } else if (customId === 'wizard:redo') {
    await handleWizardRedo(interaction, session, globalDb);
  } else if (customId === 'wizard:back') {
    await handleWizardBack(interaction, session, globalDb);
  } else if (customId === 'wizard:modify') {
    // Mark session as awaiting modification
    (session.data as Record<string, unknown>)['_awaitingModification'] = true;
    saveWizardSession(globalDb, session);

    const stepHints: Record<string, string> = {
      describe_project: 'Décris ce que tu veux changer (nom, niche, plateformes, etc.)',
      review_categories: 'Ex: "retire la catégorie 7" ou "ajoute une catégorie sur les conventions" ou "change les keywords de la catégorie 3"',
      review_persona_identity: 'Ex: "rends le persona plus mystérieux" ou "change le nom en ..."',
      review_persona_tone: 'Ex: "moins de sarcasme, plus pédagogue"',
      review_persona_vocabulary: 'Ex: "ajoute l\'expression ..." ou "retire le mot interdit ..."',
      review_persona_art_direction: 'Ex: "utilise du bleu au lieu du violet" ou "palette plus sombre"',
      review_persona_examples: 'Ex: "le post TikTok est trop long" ou "change le ton du tweet"',
    };

    const hint = stepHints[session.step] ?? 'Décris les changements que tu veux apporter.';
    await interaction.reply({
      content: `✏️ **Envoie ta modification dans ce chat.**\n\n${hint}\n\n_Le bot va régénérer le contenu avec tes instructions._`,
      ephemeral: true,
    });
  } else if (customId === 'wizard:confirm') {
    await handleWizardConfirm(interaction, session, globalDb, registry);
  } else if (customId === 'wizard:cancel') {
    await cleanupWizardDMs(interaction.user, session);
    deleteWizardSession(globalDb, session.id);
    // Send a fresh welcome message so the user can restart cleanly
    const restartPayload = v2([buildContainer(getColor('primary'), (c) => {
      c.addTextDisplayComponents(txt([
        '## 🔄 Onboarding réinitialisé',
        '',
        'Tu peux relancer l\'onboarding quand tu veux.',
      ].join('\n')));
      c.addSeparatorComponents(sep());
      c.addActionRowComponents(row(
        btn('onboard:start', 'Recommencer', ButtonStyle.Success, '🚀'),
      ));
    })]);
    await sendSplit(interaction.user, restartPayload);
    if (!interaction.replied && !interaction.deferred) {
      try { await interaction.deferUpdate(); } catch { /* expired */ }
    }
  } else if (customId === 'wizard:tone:neutral') {
    // Neutral/corporate — skip all persona generation, jump to platforms
    buildNeutralPersona(session);
    goToStep(session, 'configure_platforms');
    saveWizardSession(globalDb, session);
    const neutralPayload = v2([buildContainer(getColor('success'), (c) => {
      c.addTextDisplayComponents(txt([
        '## 🏢 Persona neutre activé',
        '',
        'Un persona professionnel standard a été créé.',
        'Pas de génération IA — on passe directement à la configuration des plateformes.',
      ].join('\n')));
      c.addSeparatorComponents(sep());
      c.addActionRowComponents(row(
        btn('wizard:next', 'Continuer', ButtonStyle.Success, '▶️'),
        btn('wizard:back', 'Revenir au choix', ButtonStyle.Secondary, '◀️'),
      ));
    })]);
    await sendWizardDM(interaction, neutralPayload, session);
    saveWizardSession(globalDb, session);

  } else if (customId === 'wizard:tone:custom') {
    // Custom tone — open modal for free-text description
    const modal = new ModalBuilder()
      .setCustomId('wizard:modal:tone:custom')
      .setTitle('Ton personnalisé')
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId('custom_tone')
            .setLabel('Décris le ton de ton persona')
            .setStyle(TextInputStyle.Paragraph)
            .setPlaceholder('Ex: Un expert passionné qui parle comme un ami proche, avec des touches d\'ironie...')
            .setRequired(true)
            .setMaxLength(500),
        ),
      );
    await interaction.showModal(modal);

  } else if (customId.startsWith('wizard:tone:')) {
    const tone = customId.split(':')[2] ?? 'sarcastic';
    setTone(session, tone);
    saveWizardSession(globalDb, session);
    advanceStep(session);
    saveWizardSession(globalDb, session);
    // Defer immediately — generatePersonaSection makes an API call that takes >3s
    try { await interaction.deferReply({ ephemeral: true }); } catch { /* expired */ }
    try {
      const payload = await generatePersonaSection(session, 'identity');
      await dmSplit(interaction.user, payload, session);
      saveWizardSession(globalDb, session);
      await interaction.editReply({ content: '✅' });
      interaction.deleteReply().catch(() => {});
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      getLogger().error({ error: errMsg, step: 'review_persona_identity' }, 'Tone → persona generation failed');
      const errPayload = v2([buildContainer(getColor('error'), (c) => {
        c.addTextDisplayComponents(txt(`## ⚠️ Erreur\nLa génération du persona a échoué : ${errMsg.slice(0, 200)}\n\nRéessaie.`));
        c.addSeparatorComponents(sep());
        c.addActionRowComponents(row(
          btn('wizard:redo', 'Réessayer', ButtonStyle.Primary, '🔄'),
          btn('wizard:next', 'Passer', ButtonStyle.Secondary, '⏭️'),
        ));
      })]);
      await dmSplit(interaction.user, errPayload, session);
      saveWizardSession(globalDb, session);
      try { await interaction.editReply({ content: '⚠️' }); interaction.deleteReply().catch(() => {}); } catch { /* expired */ }
    }
  } else if (customId.startsWith('wizard:platform:')) {
    const platform = customId.split(':')[2] ?? '';
    togglePlatform(session, platform);
    saveWizardSession(globalDb, session);
    const payload = buildPlatformSelection(session);
    // Delete the old message and send a new one so button styles update
    try { await interaction.message.delete(); } catch { /* already deleted */ }
    await dmSplit(interaction.user, payload, session);
    saveWizardSession(globalDb, session);
    if (!interaction.replied && !interaction.deferred) {
      try { await interaction.deferUpdate(); } catch { /* expired */ }
    }

  // ─── Project describe modal button ───
  } else if (customId === 'wizard:describe:modal') {
    const { buildDescribeModal } = await import('./describe.js');
    await interaction.showModal(buildDescribeModal());

  // ─── Refine validate button ───
  } else if (customId === 'wizard:refine:validate') {
    // Check if answers were already processed by the DM handler
    if (session.data.onboardingContext !== undefined && session.data.onboardingContext.length > 0) {
      // Already processed — just show validation if not already shown
      if (session.step === 'refine_project') {
        try { await interaction.deferReply({ ephemeral: true }); } catch { /* expired */ }
        const { buildProfileValidation } = await import('./refine-project.js');
        advanceStep(session);
        saveWizardSession(globalDb, session);
        const payload = buildProfileValidation(session);
        await dmSplit(interaction.user, payload, session);
        saveWizardSession(globalDb, session);
        try { interaction.deleteReply().catch(() => {}); } catch { /* expired */ }
      } else {
        // Already advanced — just dismiss the button
        if (!interaction.replied && !interaction.deferred) {
          try { await interaction.deferUpdate(); } catch { /* expired */ }
        }
      }
    } else {
      await interaction.reply({ content: '⚠️ Envoie d\'abord tes réponses aux questions dans le chat, puis clique sur Valider.', ephemeral: true });
    }

  // ─── Source selection buttons ───
  } else if (customId.startsWith('wizard:source:toggle:')) {
    const sourceId = customId.replace('wizard:source:toggle:', '');
    toggleSource(session, sourceId);
    saveWizardSession(globalDb, session);
    const payload = buildSourcesSelection(session);
    try { await interaction.message.delete(); } catch { /* already deleted */ }
    await dmSplit(interaction.user, payload, session);
    saveWizardSession(globalDb, session);
    if (!interaction.replied && !interaction.deferred) {
      try { await interaction.deferUpdate(); } catch { /* expired */ }
    }

  } else if (customId === 'wizard:source:config:rss') {
    await interaction.showModal(buildRssConfigModal());

  } else if (customId === 'wizard:source:config:reddit') {
    await interaction.showModal(buildRedditConfigModal());

  } else if (customId === 'wizard:source:config:youtube') {
    await interaction.showModal(buildYouTubeConfigModal());

  // ─── Schedule buttons ───
  } else if (customId === 'wizard:schedule:mode:weekly' || customId === 'wizard:schedule:mode:daily') {
    const mode = customId === 'wizard:schedule:mode:weekly' ? 'weekly' : 'daily';
    setScheduleMode(session, mode);
    saveWizardSession(globalDb, session);
    const payload = buildScheduleConfig(session);
    try { await interaction.message.delete(); } catch { /* already deleted */ }
    await dmSplit(interaction.user, payload, session);
    saveWizardSession(globalDb, session);
    if (!interaction.replied && !interaction.deferred) {
      try { await interaction.deferUpdate(); } catch { /* expired */ }
    }

  } else if (customId.startsWith('wizard:schedule:day:')) {
    const day = parseInt(customId.replace('wizard:schedule:day:', ''), 10);
    setVeilleDay(session, day);
    saveWizardSession(globalDb, session);
    const payload = buildScheduleConfig(session);
    try { await interaction.message.delete(); } catch { /* already deleted */ }
    await dmSplit(interaction.user, payload, session);
    saveWizardSession(globalDb, session);
    if (!interaction.replied && !interaction.deferred) {
      try { await interaction.deferUpdate(); } catch { /* expired */ }
    }

  } else if (customId.startsWith('wizard:schedule:pub:')) {
    const day = parseInt(customId.replace('wizard:schedule:pub:', ''), 10);
    togglePublicationDay(session, day);
    saveWizardSession(globalDb, session);
    const payload = buildScheduleConfig(session);
    try { await interaction.message.delete(); } catch { /* already deleted */ }
    await dmSplit(interaction.user, payload, session);
    saveWizardSession(globalDb, session);
    if (!interaction.replied && !interaction.deferred) {
      try { await interaction.deferUpdate(); } catch { /* expired */ }
    }

  // ─── LLM Provider selection buttons ───
  } else if (customId.startsWith('wizard:llm:provider:')) {
    const providerId = customId.split(':')[3] ?? '';
    setLlmProvider(session, providerId);
    session.data.llmProvider = providerId;
    saveWizardSession(globalDb, session);
    // Show model selection for this provider
    const payload = buildModelSelection(session);
    try { await interaction.message.delete(); } catch { /* already deleted */ }
    await dmSplit(interaction.user, payload, session);
    saveWizardSession(globalDb, session);
    if (!interaction.replied && !interaction.deferred) {
      try { await interaction.deferUpdate(); } catch { /* expired */ }
    }

  } else if (customId.startsWith('wizard:llm:model:') && customId !== 'wizard:llm:model:custom') {
    const modelId = customId.replace('wizard:llm:model:', '');
    setLlmModel(session, modelId);
    session.data.llmModel = modelId;
    saveWizardSession(globalDb, session);
    // Refresh model selection UI
    const payload = buildModelSelection(session);
    try { await interaction.message.delete(); } catch { /* already deleted */ }
    await dmSplit(interaction.user, payload, session);
    saveWizardSession(globalDb, session);
    if (!interaction.replied && !interaction.deferred) {
      try { await interaction.deferUpdate(); } catch { /* expired */ }
    }

  } else if (customId === 'wizard:llm:model:custom') {
    const modal = buildCustomModelModal(session);
    await interaction.showModal(modal);

  } else if (customId === 'wizard:llm:next') {
    // Model selected → if Gemini key already provided (Gemini-as-LLM), skip API key modal
    const existingKey = (session.data as Record<string, unknown>)['_anthropicKey'] as string | undefined;
    if (existingKey !== undefined && existingKey.length > 0 && session.data.llmProvider === 'google') {
      // Gemini key already set — show validation result directly
      const provider = getLlmProvider(session.data.llmProvider);
      const payload = buildValidationResult(true, provider?.name ?? 'Gemini', session.data.llmModel ?? '');
      try { await interaction.message.delete(); } catch { /* already deleted */ }
      await dmSplit(interaction.user, payload, session);
      saveWizardSession(globalDb, session);
      if (!interaction.replied && !interaction.deferred) {
        try { await interaction.deferUpdate(); } catch { /* expired */ }
      }
    } else {
      // Normal flow — show API key modal
      const modal = buildApiKeyModal(session);
      await interaction.showModal(modal);
    }

  } else if (customId === 'wizard:llm:retry') {
    // Retry API key entry
    const modal = buildApiKeyModal(session);
    await interaction.showModal(modal);

  } else if (customId === 'wizard:llm:back') {
    // Go back to provider selection
    const payload = buildProviderSelection(session);
    try { await interaction.message.delete(); } catch { /* already deleted */ }
    await dmSplit(interaction.user, payload, session);
    saveWizardSession(globalDb, session);
    if (!interaction.replied && !interaction.deferred) {
      try { await interaction.deferUpdate(); } catch { /* expired */ }
    }

  } else if (customId === 'wizard:llm:confirmed') {
    // LLM confirmed → ask for Google Cloud key (YouTube Data API, optionnel)
    if (!interaction.replied && !interaction.deferred) {
      await interaction.deferReply({ ephemeral: true });
    }
    try { await interaction.message.delete(); } catch { /* already deleted */ }
    await interaction.editReply({
      content: '✅ **Provider LLM configuré !**\n\nClé Google Cloud (optionnel — pour YouTube Data API).\nCrée une clé sur [Google Cloud Console](https://console.cloud.google.com/apis/credentials) avec l\'API **YouTube Data v3** activée.',
      components: [row(
        btn('onboard:key:google', 'Entrer clé Google Cloud', ButtonStyle.Primary, '🔑'),
        btn('onboard:skip:google', 'Plus tard', ButtonStyle.Secondary, '⏭️'),
      )],
    });
    saveWizardSession(globalDb, session);
  }
}

// ─── Modal builders ───

function buildGoogleKeyModal(): ModalBuilder {
  return new ModalBuilder()
    .setCustomId('wizard:modal:google')
    .setTitle('Clé Google Cloud (YouTube Data)')
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('api_key')
          .setLabel('Clé Google Cloud Console (AIza...)')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('AIza...')
          .setRequired(true),
      ),
    );
}

// ─── Modal handlers ───

async function handleModalSubmit(
  interaction: ModalSubmitInteraction,
  globalDb: SqliteDatabase,
  _registry: InstanceRegistry,
): Promise<void> {
  const customId = interaction.customId;

  // Custom tone modal
  if (customId === 'wizard:modal:tone:custom') {
    const customTone = interaction.fields.getTextInputValue('custom_tone');
    const session = findSessionForUser(globalDb, interaction);
    if (session === undefined) {
      await interaction.reply({ content: 'Session expirée.', ephemeral: true });
      return;
    }
    setTone(session, customTone);
    saveWizardSession(globalDb, session);
    advanceStep(session);
    saveWizardSession(globalDb, session);

    try { await interaction.deferReply({ ephemeral: true }); } catch { /* expired */ }
    try {
      const payload = await generatePersonaSection(session, 'identity');
      await dmSplit(interaction.user, payload, session);
      saveWizardSession(globalDb, session);
      await interaction.editReply({ content: '✅' });
      interaction.deleteReply().catch(() => {});
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      getLogger().error({ error: msg, step: 'review_persona_identity' }, 'Custom tone → persona generation failed');
      await interaction.editReply({ content: `⚠️ Erreur lors de la génération : ${msg.slice(0, 200)}` });
    }
    return;
  }

  if (customId === 'wizard:modal:anthropic') {
    const apiKey = interaction.fields.getTextInputValue('api_key');
    await interaction.deferReply({ ephemeral: true });

    const valid = await validateAnthropicKey(apiKey);
    if (!valid) {
      await interaction.editReply({ content: '❌ Clé Anthropic invalide. Vérifie et réessaie.' });
      return;
    }

    // Make the key available to the Anthropic service for wizard API calls
    process.env['ANTHROPIC_API_KEY'] = apiKey;

    // Store temporarily — will be persisted to instance on confirm
    const session = findSessionForUser(globalDb, interaction);
    if (session !== undefined) {
      (session.data as Record<string, unknown>)['_anthropicKey'] = apiKey;
      saveWizardSession(globalDb, session);
    }

    // Ask for Google Cloud key (YouTube Data, optionnel)
    await interaction.editReply({
      content: '✅ **Clé Anthropic validée !**\n\nClé Google Cloud (optionnel — pour YouTube Data API).\nCrée une clé sur [Google Cloud Console](https://console.cloud.google.com/apis/credentials) avec l\'API **YouTube Data v3** activée.',
      components: [row(
        btn('onboard:key:google', 'Entrer clé Google Cloud', ButtonStyle.Primary, '🔑'),
        btn('onboard:skip:google', 'Plus tard', ButtonStyle.Secondary, '⏭️'),
      )],
    });
    return;
  }

  // Gemini key modal — step 1 (obligatoire)
  if (customId === 'wizard:modal:gemini') {
    const apiKey = interaction.fields.getTextInputValue('gemini_key');
    await interaction.deferReply({ ephemeral: true });

    const { validateGeminiKey } = await import('../api-keys.js');
    const valid = await validateGeminiKey(apiKey);

    if (!valid) {
      await interaction.editReply({ content: '❌ Clé Gemini invalide. Vérifie sur [Google AI Studio](https://aistudio.google.com/apikey) et réessaie.' });
      return;
    }

    const session = findSessionForUser(globalDb, interaction);
    if (session !== undefined) {
      (session.data as Record<string, unknown>)['_geminiKey'] = apiKey;
      // Also make Gemini key available immediately for LLM calls during onboarding
      process.env['GEMINI_API_KEY'] = apiKey;
      saveWizardSession(globalDb, session);
    }

    // Ask: use Gemini as LLM too?
    const choicePayload = v2([buildContainer(getColor('success'), (c) => {
      c.addTextDisplayComponents(txt([
        '## ✅ Clé Gemini validée !',
        '',
        'Images (Imagen) et vidéos (Veo) sont configurées.',
        '',
        '**Veux-tu aussi utiliser Gemini comme provider LLM** pour l\'analyse de texte, le scoring et les suggestions ?',
        '',
        '> *Si non, tu pourras choisir un autre provider (Anthropic, OpenAI, Mistral, etc.)*',
      ].join('\n')));
      c.addSeparatorComponents(sep());
      c.addActionRowComponents(row(
        btn('onboard:gemini:llm:yes', 'Oui, utiliser Gemini pour tout', ButtonStyle.Success, '✅'),
        btn('onboard:gemini:llm:no', 'Non, choisir un autre provider', ButtonStyle.Secondary, '🔄'),
      ));
    })]);

    if (session !== undefined) {
      await dmSplit(interaction.user, choicePayload, session);
      saveWizardSession(globalDb, session);
    } else {
      await sendSplit(interaction.user, choicePayload);
    }
    try { await interaction.editReply({ content: '✅ Clé Gemini validée.' }); interaction.deleteReply().catch(() => {}); } catch { /* expired */ }
    return;
  }

  // Google Cloud key modal — step 3 (optionnel, YouTube Data only)
  if (customId === 'wizard:modal:google') {
    const apiKey = interaction.fields.getTextInputValue('api_key');
    await interaction.deferReply({ ephemeral: true });

    const { validateGoogleCloudKey } = await import('../api-keys.js');
    const valid = await validateGoogleCloudKey(apiKey);

    if (!valid) {
      await interaction.editReply({ content: '❌ Clé Google Cloud invalide ou API YouTube Data non activée.\nActive-la sur [Google Cloud Console](https://console.cloud.google.com/apis/library/youtube.googleapis.com).' });
      return;
    }

    const session = findSessionForUser(globalDb, interaction);
    if (session !== undefined) {
      (session.data as Record<string, unknown>)['_googleCloudKey'] = apiKey;
      process.env['GOOGLE_CLOUD_API_KEY'] = apiKey;
      saveWizardSession(globalDb, session);
    }

    await interaction.editReply({ content: '✅ YouTube Data API configuré !' });
    setTimeout(() => { void advanceToPostiz(interaction, globalDb); }, 1500);
    return;
  }

  // LLM API key modal
  if (customId === 'wizard:modal:llm:apikey') {
    const apiKey = interaction.fields.getTextInputValue('llm_api_key');
    let baseUrl: string | undefined;
    try { baseUrl = interaction.fields.getTextInputValue('llm_base_url'); } catch { /* field not present */ }

    await interaction.deferReply({ ephemeral: true });

    const session = findSessionForUser(globalDb, interaction);
    if (session === undefined) return;

    const llmConfig = getLlmSessionConfig(session);
    const providerId = llmConfig.provider ?? 'anthropic';
    const modelId = llmConfig.model ?? '';
    const provider = getLlmProvider(providerId);
    const resolvedBaseUrl = baseUrl ?? provider?.baseUrl;

    const valid = await validateLlmKey(providerId, apiKey, modelId, resolvedBaseUrl);

    if (!valid) {
      const payload = buildValidationResult(false, provider?.name ?? providerId, modelId);
      await dmSplit(interaction.user, payload, session);
      saveWizardSession(globalDb, session);
      await interaction.editReply({ content: '❌ Clé invalide.' });
      return;
    }

    // Store in session
    setLlmApiKey(session, apiKey);
    if (resolvedBaseUrl !== undefined) {
      setLlmBaseUrl(session, resolvedBaseUrl);
    }

    // Make key available for wizard API calls
    // Currently all LLM calls go through anthropic.ts service which reads ANTHROPIC_API_KEY
    process.env['ANTHROPIC_API_KEY'] = apiKey;
    (session.data as Record<string, unknown>)['_anthropicKey'] = apiKey;

    saveWizardSession(globalDb, session);

    const payload = buildValidationResult(true, provider?.name ?? providerId, modelId);
    await dmSplit(interaction.user, payload, session);
    saveWizardSession(globalDb, session);
    await interaction.editReply({ content: '✅ Clé validée.' });
    return;
  }

  // LLM custom model ID modal
  if (customId === 'wizard:modal:llm:custom_model') {
    const modelId = interaction.fields.getTextInputValue('llm_model_id');
    let baseUrl: string | undefined;
    try { baseUrl = interaction.fields.getTextInputValue('llm_base_url'); } catch { /* field not present */ }

    const session = findSessionForUser(globalDb, interaction);
    if (session === undefined) return;

    setLlmModel(session, modelId);
    session.data.llmModel = modelId;
    if (baseUrl !== undefined && baseUrl.length > 0) {
      setLlmBaseUrl(session, baseUrl);
    }
    saveWizardSession(globalDb, session);

    // Can't show modal from a modal submit — send a message with a button instead
    const payload = v2([buildContainer(getColor('primary'), (c) => {
      c.addTextDisplayComponents(txt([
        `## ✅ Modèle configuré : \`${modelId}\``,
        '',
        'Maintenant, entre ta clé API.',
      ].join('\n')));
      c.addSeparatorComponents(sep());
      c.addActionRowComponents(row(
        btn('wizard:llm:retry', 'Entrer la clé API', ButtonStyle.Primary, '🔑'),
        btn('wizard:llm:back', 'Changer de provider', ButtonStyle.Secondary, '⬅️'),
      ));
    })]);
    await dmSplit(interaction.user, payload, session);
    saveWizardSession(globalDb, session);
    if (!interaction.replied && !interaction.deferred) {
      try { await interaction.deferUpdate(); } catch { /* expired */ }
    }
    return;
  }

  // Project describe modal
  if (customId === 'wizard:modal:describe') {
    const session = findSessionForUser(globalDb, interaction);
    if (session === undefined) return;

    const fields = {
      projectName: interaction.fields.getTextInputValue('project_name'),
      projectUrl: interaction.fields.getTextInputValue('project_url'),
      projectNiche: interaction.fields.getTextInputValue('project_niche'),
      contentTypes: interaction.fields.getTextInputValue('project_content_types'),
      platforms: interaction.fields.getTextInputValue('project_platforms'),
    };

    try { await interaction.deferReply({ ephemeral: true }); } catch { /* expired */ }

    try {
      const { processDescribeModal } = await import('./describe.js');
      const { message } = await processDescribeModal(session, fields);
      saveWizardSession(globalDb, session);
      await dmSplit(interaction.user, message, session);
      saveWizardSession(globalDb, session);
      try { await interaction.editReply({ content: '✅' }); interaction.deleteReply().catch(() => {}); } catch { /* expired */ }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      getLogger().error({ error: msg }, 'Describe modal processing failed');
      try { await interaction.editReply({ content: `❌ Erreur : ${msg.slice(0, 200)}` }); } catch { /* expired */ }
    }
    return;
  }

  // Source config modals
  if (customId === 'wizard:modal:source:rss') {
    const urls = interaction.fields.getTextInputValue('rss_urls')
      .split('\n')
      .map((u) => u.trim())
      .filter((u) => u.length > 0);

    const session = findSessionForUser(globalDb, interaction);
    if (session !== undefined) {
      session.data.rssUrls = urls;
      saveWizardSession(globalDb, session);
    }

    await interaction.reply({ content: `✅ ${String(urls.length)} flux RSS configurés.`, ephemeral: true });
    return;
  }

  if (customId === 'wizard:modal:source:reddit') {
    const subs = interaction.fields.getTextInputValue('subreddits')
      .split('\n')
      .map((s) => s.trim().replace(/^r\//, ''))
      .filter((s) => s.length > 0);

    const session = findSessionForUser(globalDb, interaction);
    if (session !== undefined) {
      session.data.redditSubreddits = subs;
      saveWizardSession(globalDb, session);
    }

    await interaction.reply({ content: `✅ ${String(subs.length)} subreddits configurés.`, ephemeral: true });
    return;
  }

  if (customId === 'wizard:modal:source:youtube') {
    const keywords = interaction.fields.getTextInputValue('youtube_keywords')
      .split('\n')
      .map((k) => k.trim())
      .filter((k) => k.length > 0);

    const session = findSessionForUser(globalDb, interaction);
    if (session !== undefined) {
      session.data.youtubeKeywords = keywords;
      saveWizardSession(globalDb, session);
    }

    await interaction.reply({ content: `✅ ${String(keywords.length)} mots-clés YouTube configurés.`, ephemeral: true });
    return;
  }

  // Postiz platform credentials modal: wizard:modal:postiz:{platformId}
  if (customId.startsWith('wizard:modal:postiz:')) {
    const platformId = customId.replace('wizard:modal:postiz:', '') as PlatformId;
    const def = PLATFORM_CONFIG[platformId];
    if (def === undefined) return;

    await interaction.deferReply({ ephemeral: true });

    const keys: Record<string, string> = {};
    for (const envVar of def.envVars) {
      if (envVar === undefined) continue;
      try {
        keys[envVar] = interaction.fields.getTextInputValue(envVar);
      } catch { /* field not found */ }
    }

    try {
      await interaction.editReply({ content: `⏳ Configuration de ${def.label}... Redémarrage de Postiz.` });
      await configurePlatform(platformId, keys);
      await interaction.editReply({ content: `✅ ${def.label} configuré ! Postiz redémarré.\n\nVa sur Postiz pour connecter ton compte, puis reviens vérifier.` });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      await interaction.editReply({ content: `⚠️ Erreur lors de la configuration de ${def.label} : ${msg}` });
    }

    // Auto-refresh main screen
    setTimeout(async () => {
      try {
        const result = await verifyPostizIntegrations();
        const payload = await buildPostizScreen('onboard:postiz', result.connected);
        await sendSplit(interaction.user, payload);
      } catch { /* best effort */ }
    }, 3000);
    return;
  }
}

// ─── Step handlers ───

async function advanceToPostiz(
  interaction: ButtonInteraction | ModalSubmitInteraction,
  globalDb: SqliteDatabase,
): Promise<void> {
  const result = await verifyPostizIntegrations();
  const payload = await buildPostizScreen('onboard:postiz', result.connected);

  const session = findSessionForUser(globalDb, interaction);
  if (interaction.replied || interaction.deferred) {
    if (session !== undefined) {
      await dmSplit(interaction.user, payload, session);
      saveWizardSession(globalDb, session);
    } else {
      await sendSplit(interaction.user, payload);
    }
    try { await interaction.editReply({ content: '✅' }); interaction.deleteReply().catch(() => {}); } catch { /* interaction expired */ }
  } else {
    await sendWizardDM(interaction, payload, session);
    if (session !== undefined) saveWizardSession(globalDb, session);
  }
}

async function advanceToDescribe(
  interaction: ButtonInteraction | ModalSubmitInteraction,
  globalDb: SqliteDatabase,
): Promise<void> {
  const session = findSessionForUser(globalDb, interaction);
  if (session === undefined) return;

  // Import mode — ask for JSON file instead of wizard
  const isImportMode = (session.data as Record<string, unknown>)['_importMode'] === true;
  if (isImportMode) {
    const importPayload = v2([buildContainer(getColor('info'), (c) => {
      c.addTextDisplayComponents(txt([
        '## 📥 Import de configuration',
        '',
        'Envoie le fichier JSON exporté en message dans cette conversation.',
        'Le fichier doit provenir d\'un export depuis le dashboard.',
      ].join('\n')));
    })]);
    if (interaction.replied || interaction.deferred) {
      await dmSplit(interaction.user, importPayload, session);
      session.step = 'describe_project'; // park at this step, waiting for file
      saveWizardSession(globalDb, session);
      try { await interaction.editReply({ content: '✅' }); interaction.deleteReply().catch(() => {}); } catch { /* expired */ }
    } else {
      await sendWizardDM(interaction, importPayload, session);
      session.step = 'describe_project';
      saveWizardSession(globalDb, session);
    }
    return;
  }

  session.step = 'describe_project';
  saveWizardSession(globalDb, session);

  const payload = buildDescribePrompt(session);

  if (interaction.replied || interaction.deferred) {
    await dmSplit(interaction.user, payload, session);
    saveWizardSession(globalDb, session);
    try { await interaction.editReply({ content: '✅' }); interaction.deleteReply().catch(() => {}); } catch { /* interaction expired */ }
  } else {
    await sendWizardDM(interaction, payload, session);
    saveWizardSession(globalDb, session);
  }
}

async function handleWizardNext(
  interaction: ButtonInteraction,
  session: WizardSession,
  globalDb: SqliteDatabase,
  _registry: InstanceRegistry,
): Promise<void> {
  if (!canIterate(session)) {
    await interaction.reply({ content: '⚠️ Limite de 20 itérations atteinte. Finalise manuellement ou recommence.', ephemeral: true });
    return;
  }

  const nextStep = advanceStep(session);
  saveWizardSession(globalDb, session);

  if (nextStep === null) {
    // Wizard complete — shouldn't happen via "next", only via "confirm"
    return;
  }

  try { await interaction.deferReply({ ephemeral: true }); } catch { /* interaction expired */ }

  let payload;

  try {
    switch (nextStep) {
      case 'refine_project': {
        const { buildRefineQuestions } = await import('./refine-project.js');
        payload = buildRefineQuestions(session);
        break;
      }
      case 'validate_profile': {
        const { buildProfileValidation } = await import('./refine-project.js');
        payload = buildProfileValidation(session);
        break;
      }
      case 'review_categories':
        ({ message: payload } = await generateCategories(session));
        break;
      case 'dryrun_searxng':
        payload = await dryRunCategories(session);
        break;
      case 'configure_sources':
        payload = buildSourcesSelection(session);
        break;
      case 'mini_dryrun_sources':
        payload = await miniDryRunSources(session);
        break;
      case 'choose_persona_tone':
        payload = buildToneSelection(session);
        break;
      case 'review_persona_identity':
        payload = await generatePersonaSection(session, 'identity');
        break;
      case 'review_persona_tone':
        payload = await generatePersonaSection(session, 'tone');
        break;
      case 'review_persona_vocabulary':
        payload = await generatePersonaSection(session, 'vocabulary');
        break;
      case 'review_persona_art_direction':
        payload = await generatePersonaSection(session, 'art_direction');
        break;
      case 'review_persona_examples':
        payload = await generatePersonaSection(session, 'examples');
        break;
      case 'configure_platforms':
        payload = buildPlatformSelection(session);
        break;
      case 'configure_schedule':
        payload = buildScheduleConfig(session);
        break;
      case 'confirm':
        assemblePersona(session);
        payload = buildConfirmation(session);
        break;
      default:
        payload = v2([buildContainer(getColor('info'), (c) => {
          c.addTextDisplayComponents(txt(`Étape ${nextStep} en cours...`));
        })]);
    }
  } catch (error) {
    const logger = getLogger();
    const msg = error instanceof Error ? error.message : String(error);
    logger.error({ error: msg, step: nextStep }, 'Wizard step generation failed');
    payload = v2([buildContainer(getColor('error'), (c) => {
      c.addTextDisplayComponents(txt(`## ⚠️ Erreur\nLa génération a échoué : ${msg.slice(0, 200)}\n\nRéessaie ou passe à l'étape suivante.`));
      c.addSeparatorComponents(sep());
      c.addActionRowComponents(row(
        btn('wizard:redo', 'Réessayer', ButtonStyle.Primary, '🔄'),
        btn('wizard:next', 'Passer', ButtonStyle.Secondary, '⏭️'),
      ));
    })]);
  }

  saveWizardSession(globalDb, session);
  try {
    await dmSplit(interaction.user, payload, session);
    saveWizardSession(globalDb, session);
    await interaction.editReply({ content: '✅' });
    interaction.deleteReply().catch(() => {});
  } catch { /* interaction expired — DM sent anyway */ }
}

async function handleWizardRedo(
  interaction: ButtonInteraction,
  session: WizardSession,
  globalDb: SqliteDatabase,
): Promise<void> {
  if (!canIterate(session)) {
    await interaction.reply({ content: '⚠️ Limite d\'itérations atteinte.', ephemeral: true });
    return;
  }

  try { await interaction.deferReply({ ephemeral: true }); } catch { /* interaction expired */ }

  // Re-run the current step
  let payload;
  const step = session.step;

  try {
    if (step === 'review_categories') {
      ({ message: payload } = await generateCategories(session));
    } else if (step === 'dryrun_searxng') {
      payload = await dryRunCategories(session);
    } else if (step.startsWith('review_persona_')) {
      const sectionMap: Record<string, 'identity' | 'tone' | 'vocabulary' | 'art_direction' | 'examples'> = {
        review_persona_identity: 'identity',
        review_persona_tone: 'tone',
        review_persona_vocabulary: 'vocabulary',
        review_persona_art_direction: 'art_direction',
        review_persona_examples: 'examples',
      };
      const section = sectionMap[step];
      if (section !== undefined) {
        payload = await generatePersonaSection(session, section);
      }
    }
  } catch (error) {
    const logger = getLogger();
    const msg = error instanceof Error ? error.message : String(error);
    logger.error({ error: msg, step }, 'Wizard redo generation failed');
    payload = v2([buildContainer(getColor('error'), (c) => {
      c.addTextDisplayComponents(txt(`## ⚠️ Erreur\nLa régénération a échoué : ${msg.slice(0, 200)}\n\nRéessaie ou passe à l'étape suivante.`));
      c.addSeparatorComponents(sep());
      c.addActionRowComponents(row(
        btn('wizard:redo', 'Réessayer', ButtonStyle.Primary, '🔄'),
        btn('wizard:next', 'Passer', ButtonStyle.Secondary, '⏭️'),
      ));
    })]);
  }

  if (payload !== undefined) {
    saveWizardSession(globalDb, session);
    try {
      await dmSplit(interaction.user, payload, session);
      saveWizardSession(globalDb, session);
      await interaction.editReply({ content: '✅' });
      interaction.deleteReply().catch(() => {});
    } catch { /* interaction expired */ }
  } else {
    try { await interaction.editReply({ content: 'Régénération non disponible pour cette étape.' }); } catch { /* expired */ }
  }
}

async function handleWizardBack(
  interaction: ButtonInteraction,
  session: WizardSession,
  globalDb: SqliteDatabase,
): Promise<void> {
  const { goToPreviousStep } = await import('./state-machine.js');

  const prevStep = goToPreviousStep(session);
  if (prevStep === null) {
    if (!interaction.replied && !interaction.deferred) {
      try { await interaction.deferUpdate(); } catch { /* expired */ }
    }
    return;
  }

  saveWizardSession(globalDb, session);
  try { await interaction.deferReply({ ephemeral: true }); } catch { /* expired */ }

  // Build the UI for the previous step — reuse existing data, don't regenerate
  let payload;

  switch (prevStep) {
    case 'describe_project': {
      const { buildDescribePrompt } = await import('./describe.js');
      payload = buildDescribePrompt(session);
      break;
    }
    case 'refine_project': {
      const { buildRefineQuestions } = await import('./refine-project.js');
      payload = buildRefineQuestions(session);
      break;
    }
    case 'validate_profile': {
      const { buildProfileValidation } = await import('./refine-project.js');
      payload = buildProfileValidation(session);
      break;
    }
    case 'review_categories': {
      if (session.data.categories !== undefined && session.data.categories.length > 0) {
        const { buildCategoriesDisplay } = await import('./categories.js');
        payload = buildCategoriesDisplay(session);
      } else {
        const { message: genPayload } = await generateCategories(session);
        payload = genPayload;
      }
      break;
    }
    case 'dryrun_searxng': {
      payload = await dryRunCategories(session);
      break;
    }
    case 'configure_sources': {
      payload = buildSourcesSelection(session);
      break;
    }
    case 'mini_dryrun_sources': {
      payload = await miniDryRunSources(session);
      break;
    }
    case 'choose_persona_tone': {
      const { buildToneSelection: bts } = await import('./persona.js');
      payload = bts(session);
      break;
    }
    case 'review_persona_identity':
    case 'review_persona_tone':
    case 'review_persona_vocabulary':
    case 'review_persona_art_direction':
    case 'review_persona_examples': {
      // Show existing persona section if available, otherwise regenerate
      const sectionMap: Record<string, { key: string; section: 'identity' | 'tone' | 'vocabulary' | 'art_direction' | 'examples' }> = {
        review_persona_identity: { key: 'personaIdentity', section: 'identity' },
        review_persona_tone: { key: 'personaToneSection', section: 'tone' },
        review_persona_vocabulary: { key: 'personaVocabulary', section: 'vocabulary' },
        review_persona_art_direction: { key: 'personaArtDirection', section: 'art_direction' },
        review_persona_examples: { key: 'personaExamples', section: 'examples' },
      };
      const mapping = sectionMap[prevStep];
      if (mapping !== undefined) {
        const existing = (session.data as Record<string, unknown>)[mapping.key] as string | undefined;
        if (existing !== undefined && existing.length > 0) {
          // Display existing section without regenerating
          const SECTION_LABELS: Record<string, string> = {
            identity: '🎭 Identité',
            tone: '🗣️ Ton & personnalité',
            vocabulary: '📝 Vocabulaire',
            art_direction: '🎨 Direction artistique',
            examples: '✍️ Exemples de voix',
          };
          const { getStepLabel: localGetStepLabel } = await import('./state-machine.js');
          const label = SECTION_LABELS[mapping.section] ?? mapping.section;
          const preview = existing.length > 1500 ? existing.slice(0, 1500) + '\n\n*(...tronqué)*' : existing;
          payload = v2([buildContainer(getColor('primary'), (c) => {
            c.addTextDisplayComponents(txt(`## ${label} — Étape ${localGetStepLabel(session.step)}\n\n${preview}`));
            c.addSeparatorComponents(sep());
            c.addActionRowComponents(row(
              btn('wizard:next', 'Valider', ButtonStyle.Success, '✅'),
              btn('wizard:redo', 'Régénérer', ButtonStyle.Secondary, '🔄'),
              btn('wizard:modify', 'Modifier', ButtonStyle.Primary, '✏️'),
              btn('wizard:back', 'Retour', ButtonStyle.Secondary, '◀️'),
            ));
          })]);
        } else {
          payload = await generatePersonaSection(session, mapping.section);
        }
      }
      break;
    }
    case 'configure_platforms': {
      payload = buildPlatformSelection(session);
      break;
    }
    case 'configure_schedule': {
      payload = buildScheduleConfig(session);
      break;
    }
    case 'confirm': {
      const { buildConfirmation: bc } = await import('./confirm.js');
      assemblePersona(session);
      payload = bc(session);
      break;
    }
    default:
      break;
  }

  if (payload === undefined) {
    try { await interaction.editReply({ content: '◀️ Retour' }); interaction.deleteReply().catch(() => {}); } catch { /* expired */ }
    return;
  }

  try {
    await dmSplit(interaction.user, payload, session);
    saveWizardSession(globalDb, session);
    await interaction.editReply({ content: '✅' });
    interaction.deleteReply().catch(() => {});
  } catch { /* interaction expired */ }
}

async function handleWizardConfirm(
  interaction: ButtonInteraction,
  session: WizardSession,
  globalDb: SqliteDatabase,
  registry: InstanceRegistry,
): Promise<void> {
  const logger = getLogger();

  try { await interaction.deferReply({ ephemeral: true }); } catch { /* expired */ }

  // In DMs, guild is null — fetch it from the session's guildId
  let guild = interaction.guild;
  if (guild === null) {
    try {
      guild = await interaction.client.guilds.fetch(session.guildId);
    } catch {
      try { await interaction.editReply({ content: '❌ Impossible de trouver le serveur. Vérifie que le bot est toujours membre.' }); } catch { /* expired */ }
      return;
    }
  }

  // 1. Validate infrastructure
  const errors = await validateInfrastructure(guild);
  if (errors.length > 0) {
    try { await interaction.editReply({ content: `❌ Impossible de créer l'instance :\n${errors.join('\n')}` }); } catch { /* expired */ }
    return;
  }

  const instanceName = session.data.instanceName ?? session.data.projectName ?? 'mon-instance';
  const instanceId = instanceName.toLowerCase().replace(/[^a-z0-9-]/g, '-');

  try {
    // 2. Create Discord channels
    try { await interaction.editReply({ content: '🏗️ Création des channels Discord...' }); } catch { /* expired */ }
    const infra = await createInfrastructure(guild, instanceName, interaction.user.id);

    // 3. Register instance in global DB (upsert in case a deleted instance with same ID exists)
    const cronOffset = registry.getActiveCount() * 3;
    // Clean up any leftover data from a previously deleted instance with the same ID
    globalDb.prepare('DELETE FROM instance_channels WHERE instance_id = ?').run(instanceId);
    globalDb.prepare('DELETE FROM instance_secrets WHERE instance_id = ?').run(instanceId);
    globalDb.prepare(`
      INSERT INTO instances (id, guild_id, name, category_id, owner_id, status, cron_offset_minutes)
      VALUES (?, ?, ?, ?, ?, 'active', ?)
      ON CONFLICT(id) DO UPDATE SET
        guild_id = excluded.guild_id, name = excluded.name, category_id = excluded.category_id,
        owner_id = excluded.owner_id, status = 'active', cron_offset_minutes = excluded.cron_offset_minutes
    `).run(instanceId, guild.id, instanceName, infra.categoryId, interaction.user.id, cronOffset);

    registerChannels(globalDb, instanceId, infra.channels);

    // 4. Store API keys (encrypted via AES-256-GCM in instance_secrets)
    const llmKey = (session.data as Record<string, unknown>)['_anthropicKey'] as string | undefined;
    if (llmKey !== undefined) {
      // Store under both 'anthropic' (legacy compat) and 'llm' (generic)
      storeInstanceSecret(globalDb, instanceId, 'anthropic', llmKey);
      storeInstanceSecret(globalDb, instanceId, 'llm', llmKey);
    }
    const geminiKey = (session.data as Record<string, unknown>)['_geminiKey'] as string | undefined;
    if (geminiKey !== undefined) {
      storeInstanceSecret(globalDb, instanceId, 'gemini', geminiKey);
    }
    const googleCloudKey = (session.data as Record<string, unknown>)['_googleCloudKey'] as string | undefined;
    if (googleCloudKey !== undefined) {
      storeInstanceSecret(globalDb, instanceId, 'google_cloud', googleCloudKey);
    }

    // 5. Create instance DB + seed data
    try { await interaction.editReply({ content: '💾 Initialisation de la base de données...' }); } catch { /* expired */ }
    const instanceDb = createInstanceDatabase(instanceId);

    // Check if import mode with pre-loaded data
    const importData = (session.data as Record<string, unknown>)['_importData'] as import('../import.js').ImportData | undefined;

    if (importData !== undefined) {
      // Import mode — use applyImportToInstance for categories, overrides, and persona
      const { applyImportToInstance } = await import('../import.js');
      applyImportToInstance(instanceId, instanceDb, importData);
    } else {
      // Normal wizard mode — seed categories from wizard data
      if (session.data.categories !== undefined && session.data.categories.length > 0) {
        const insert = instanceDb.prepare(`
          INSERT INTO veille_categories (id, label, keywords_en, keywords_fr, engines, max_age_hours, sort_order)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `);
        const cats = session.data.categories;
        const insertAll = instanceDb.transaction(() => {
          if (cats === undefined) return;
          for (let i = 0; i < cats.length; i++) {
            const cat = cats[i];
            if (cat === undefined) continue;
            insert.run(cat.id, cat.label, JSON.stringify(cat.keywords.en), JSON.stringify(cat.keywords.fr), JSON.stringify(cat.engines), cat.maxAgeHours, i);
          }
        });
        insertAll();
      }

      // Save persona from wizard
      if (session.data.personaFull !== undefined) {
        instanceDb.prepare(`
          INSERT INTO persona (id, content, updated_at) VALUES (1, ?, datetime('now'))
        `).run(session.data.personaFull);
      }

      // Save instance profile (V3)
      saveProfile(instanceDb, {
        projectName: session.data.projectName ?? instanceName,
        projectNiche: session.data.projectNiche ?? '',
        projectDescription: session.data.projectDescription ?? '',
        projectLanguage: session.data.projectLanguage ?? 'fr',
        projectUrl: session.data.projectUrl ?? null,
        targetPlatforms: session.data.projectPlatforms ?? ['tiktok', 'instagram'],
        targetFormats: session.data.formats ?? ['reel', 'carousel', 'story', 'post'],
        contentTypes: session.data.contentTypes ?? [],
        includeDomains: session.data.includeDomains ?? [],
        excludeDomains: session.data.excludeDomains ?? [],
        negativeKeywords: session.data.negativeKeywords ?? [],
        pillars: ['trend', 'tuto', 'community', 'product'],
        onboardingContext: session.data.onboardingContext ?? '',
      });

      // Save sources configuration (V3)
      const enabledSources = session.data.enabledSources ?? [];
      for (const sourceType of enabledSources) {
        let config: Record<string, unknown> = {};
        if (sourceType === 'rss' && session.data.rssUrls !== undefined) {
          config = { urls: session.data.rssUrls };
        } else if (sourceType === 'reddit' && session.data.redditSubreddits !== undefined) {
          config = { subreddits: session.data.redditSubreddits };
        } else if (sourceType === 'youtube' && session.data.youtubeKeywords !== undefined) {
          config = { keywords: session.data.youtubeKeywords, maxResults: 10 };
        } else if (sourceType === 'web_search') {
          config = {};
        }
        upsertSource(instanceDb, { type: sourceType as import('../../veille/sources/index.js').SourceType, enabled: true, config });
      }
      // Always ensure SearXNG is enabled
      upsertSource(instanceDb, { type: 'searxng', enabled: true, config: {} });

      // Save schedule config (V3)
      saveScheduleConfig(instanceDb, {
        mode: session.data.scheduleMode ?? 'daily',
        veilleDay: session.data.veilleDay ?? null,
        veilleHour: session.data.veilleHour ?? 7,
        publicationDays: session.data.publicationDays ?? [1, 2, 3, 4, 5],
        suggestionsPerCycle: session.data.suggestionsPerCycle ?? 3,
      });

      // Save cron overrides (V3)
      if (session.data.veilleCron !== undefined) {
        upsertConfigOverride(instanceDb, 'veilleCron', session.data.veilleCron);
      }
      if (session.data.suggestionsCron !== undefined) {
        upsertConfigOverride(instanceDb, 'suggestionsCron', session.data.suggestionsCron);
      }
      if (session.data.rapportCron !== undefined) {
        upsertConfigOverride(instanceDb, 'rapportCron', session.data.rapportCron);
      }

      // Save LLM provider config (V3)
      if (session.data.llmProvider !== undefined) {
        upsertConfigOverride(instanceDb, 'llm_provider', session.data.llmProvider);
      }
      if (session.data.llmModel !== undefined) {
        upsertConfigOverride(instanceDb, 'llm_model', session.data.llmModel);
      }
    }

    // 6. Post dashboard + search interface
    try { await interaction.editReply({ content: '📊 Création du dashboard...' }); } catch { /* expired */ }

    const dashChannel = await guild.channels.fetch(infra.channels.dashboard);
    const searchChannel = await guild.channels.fetch(infra.channels.recherche);

    if (dashChannel !== null && dashChannel.isTextBased()) {
      const homeData = collectDashboardHomeData(instanceDb, instanceName, new Date().toISOString(), false);
      const dashPayload = buildDashboardHome(homeData);
      const dashMsg = await (dashChannel as import('discord.js').TextChannel).send({
        components: dashPayload.components as never[],
        flags: dashPayload.flags,
      });
      registry.setChannelMessageId(instanceId, 'dashboard', dashMsg.id);
    }

    if (searchChannel !== null && searchChannel.isTextBased()) {
      const searchPayload = buildSearchInterface(instanceName);
      const searchMsg = await (searchChannel as import('discord.js').TextChannel).send({
        components: searchPayload.components as never[],
        flags: searchPayload.flags,
      });
      registry.setChannelMessageId(instanceId, 'recherche', searchMsg.id);
    }

    // 7. Reload registry
    await registry.loadAll();

    // 8. Clean up wizard session + DMs
    await cleanupWizardDMs(interaction.user, session);
    deleteWizardSession(globalDb, session.id);

    // 9. Done
    const donePayload = v2([buildContainer(getColor('success'), (c) => {
      c.addTextDisplayComponents(txt([
        '## ✅ Instance créée !',
        '',
        `**${instanceName}** est opérationnelle.`,
        '',
        `📊 Dashboard : <#${infra.channels.dashboard}>`,
        `🔍 Recherche : <#${infra.channels.recherche}>`,
        `📰 Veille : <#${infra.channels.veille}>`,
        `💡 Idées : <#${infra.channels.idees}>`,
        `🎬 Production : <#${infra.channels.production}>`,
        `📤 Publication : <#${infra.channels.publication}>`,
        `📋 Logs : <#${infra.channels.logs}>`,
        '',
        'La première veille sera lancée au prochain cron. Tu peux aussi la lancer depuis le dashboard.',
      ].join('\n')));
    })]);

    try {
      await sendSplit(interaction.user, donePayload);
      await interaction.editReply({ content: '✅ Instance créée !' });
      setTimeout(() => { interaction.deleteReply().catch(() => {}); }, 5_000);
    } catch { /* expired */ }

    logger.info({ instanceId, guildId: guild.id, name: instanceName }, 'Instance created successfully');

    // Fire-and-forget: generate calibrated scoring examples in background
    if (session.data.projectNiche !== undefined && session.data.projectNiche.length > 0) {
      const personaText = session.data.personaFull ?? '';
      Promise.all([
        import('../../veille/calibrated-examples.js'),
        import('../../core/instance-profile.js'),
      ]).then(([{ generateCalibratedExamples: genExamples }, { getProfile: gp }]) => {
        const profile = gp(instanceDb);
        if (profile !== undefined) {
          logger.info({ instanceId }, 'Starting calibrated examples generation (background)');
          genExamples(instanceDb, profile, personaText)
            .then((examples) => { logger.info({ instanceId, count: examples.length }, 'Calibrated examples generated'); })
            .catch((err) => { logger.error({ instanceId, error: err instanceof Error ? err.message : String(err) }, 'Calibrated examples generation failed'); });
        }
      }).catch((err) => { logger.error({ instanceId, error: err instanceof Error ? err.message : String(err) }, 'Failed to load calibrated examples module'); });
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error({ error: msg }, 'Instance creation failed');
    try { await interaction.editReply({ content: `❌ Erreur lors de la création : ${msg}` }); } catch { /* expired */ }
  }
}

// ─── Helpers ───

function findSessionForUser(globalDb: SqliteDatabase, interaction: Interaction): WizardSession | undefined {
  let session: WizardSession | undefined;

  // Try to find a session for this user across all guilds
  const guildId = interaction.guildId ?? '';
  if (guildId.length > 0) {
    session = getActiveWizardSession(globalDb, guildId, interaction.user.id);
  } else {
    // DM context — search all sessions for this user
    const row = globalDb.prepare(`
      SELECT guild_id FROM wizard_sessions
      WHERE user_id = ? AND expires_at > datetime('now')
      ORDER BY created_at DESC LIMIT 1
    `).get(interaction.user.id) as { guild_id: string } | undefined;

    if (row !== undefined) {
      session = getActiveWizardSession(globalDb, row.guild_id, interaction.user.id);
    }
  }

  // Restore API key to process.env if session has one (survives hot-reload)
  if (session !== undefined) {
    const storedKey = (session.data as Record<string, unknown>)['_anthropicKey'];
    if (typeof storedKey === 'string' && storedKey.length > 0) {
      process.env['ANTHROPIC_API_KEY'] = storedKey;
    }
  }

  return session;
}

