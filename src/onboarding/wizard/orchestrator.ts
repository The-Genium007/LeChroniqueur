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
  getDmMessageIds,
  type WizardSession,
} from './state-machine.js';
import { buildDescribePrompt } from './describe.js';
import { generateCategories } from './categories.js';
import { dryRunCategories } from './dryrun.js';
import { buildToneSelection, setTone, generatePersonaSection, assemblePersona } from './persona.js';
import { buildPlatformSelection, buildScheduleConfig, togglePlatform } from './platforms.js';
import { buildConfirmation } from './confirm.js';
import { validateAnthropicKey, validateGoogleAiKey, storeInstanceSecret } from '../api-keys.js';
import { validateInfrastructure, createInfrastructure, registerChannels } from '../infrastructure.js';
import { seedCategories } from '../../veille/queries.js';
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
  const msg = await interaction.user.send({
    components: payload.components as never[],
    flags: payload.flags,
  });
  if (session !== undefined) {
    trackDmMessageId(session, msg.id);
  }
  // Acknowledge the interaction silently — ignore if expired
  if (!interaction.replied && !interaction.deferred) {
    try { await interaction.deferUpdate(); } catch { /* interaction expired */ }
  }
}

/**
 * Delete all tracked DM messages from a wizard session.
 */
async function cleanupWizardDMs(user: import('discord.js').User, session: WizardSession): Promise<void> {
  const messageIds = getDmMessageIds(session);
  if (messageIds.length === 0) return;
  const dmChannel = await user.createDM();
  await Promise.allSettled(
    messageIds.map((id) => dmChannel.messages.delete(id).catch(() => {})),
  );
}

/**
 * Handle all onboarding/wizard interactions (buttons + modals in DMs).
 */
export async function handleWizardInteraction(
  interaction: Interaction,
  globalDb: SqliteDatabase,
  registry: InstanceRegistry,
): Promise<void> {
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

    let session = getActiveWizardSession(globalDb, guildId, interaction.user.id);
    if (session !== undefined) {
      const payload = buildResumePrompt(session);
      await sendWizardDM(interaction, payload, session);
      saveWizardSession(globalDb, session);
      return;
    }

    session = createWizardSession(globalDb, guildId, interaction.user.id);
    saveWizardSession(globalDb, session);

    // Start with API key collection (Modal)
    const modal = buildAnthropicKeyModal();
    await interaction.showModal(modal);
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
    // Start with API key collection same as normal
    await interaction.showModal(buildAnthropicKeyModal());
    return;
  }

  // ─── onboard:key:* — API key entry buttons ───
  if (customId === 'onboard:key:anthropic') {
    await interaction.showModal(buildAnthropicKeyModal());
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
    if (sub === 'verify') {
      const { verifyPostizIntegrations } = await import('../postiz-setup.js');
      await interaction.deferReply({ ephemeral: true });
      const result = await verifyPostizIntegrations();
      const lines = result.connected.length > 0
        ? result.connected.map((c) => `✅ ${c}`).join('\n')
        : '❌ Aucune intégration connectée';
      const payload = v2([buildContainer(getColor('info'), (c) => {
        c.addTextDisplayComponents(txt(`## 📤 Intégrations Postiz\n${lines}\n\n${String(result.total)} plateforme(s) connectée(s).`));
        c.addSeparatorComponents(sep());
        c.addActionRowComponents(row(
          btn('onboard:postiz:verify', 'Revérifier', ButtonStyle.Secondary, '🔄'),
          btn('onboard:postiz:done', 'Continuer', ButtonStyle.Success, '✅'),
        ));
      })]);
      const verifyMsg = await interaction.user.send({ components: payload.components as never[], flags: payload.flags });
      const verifySession = findSessionForUser(globalDb, interaction);
      if (verifySession !== undefined) {
        trackDmMessageId(verifySession, verifyMsg.id);
        saveWizardSession(globalDb, verifySession);
      }
      try { await interaction.editReply({ content: '✅' }); interaction.deleteReply().catch(() => {}); } catch { /* interaction expired */ }
      return;
    }
    if (sub === 'done') {
      await advanceToDescribe(interaction, globalDb);
      return;
    }
    // Social platform config buttons handled by showing guide
    if (sub.startsWith('social:')) {
      const platform = sub.replace('social:', '');
      const { PLATFORM_CONFIG, getRedirectUri } = await import('../postiz-setup.js');
      const config = PLATFORM_CONFIG[platform as keyof typeof PLATFORM_CONFIG];
      if (config !== undefined) {
        const redirectUri = getRedirectUri(platform as 'tiktok' | 'instagram' | 'x' | 'linkedin');
        await interaction.reply({
          content: [
            `## ${config.emoji} Configuration ${config.label}`,
            '',
            `**Redirect URI** : \`${redirectUri}\``,
            `**Scopes/Notes** : ${config.scopes}`,
            `**Variables requises** : ${config.envVars.join(', ')}`,
            '',
            'Configure l\'app sur la plateforme développeur, puis entre les clés via le bouton ci-dessous.',
          ].join('\n'),
          ephemeral: true,
        });
      }
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
    await interaction.reply({ content: '✏️ Envoie ta modification en texte.', ephemeral: true });
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
    await interaction.user.send({ components: restartPayload.components as never[], flags: restartPayload.flags });
    if (!interaction.replied && !interaction.deferred) {
      try { await interaction.deferUpdate(); } catch { /* expired */ }
    }
  } else if (customId.startsWith('wizard:tone:')) {
    const tone = customId.split(':')[2] ?? 'sarcastic';
    setTone(session, tone);
    saveWizardSession(globalDb, session);
    advanceStep(session);
    saveWizardSession(globalDb, session);
    const payload = await generatePersonaSection(session, 'identity');
    await sendWizardDM(interaction, payload, session);
    saveWizardSession(globalDb, session);
  } else if (customId.startsWith('wizard:platform:')) {
    const platform = customId.split(':')[2] ?? '';
    togglePlatform(session, platform);
    saveWizardSession(globalDb, session);
    const payload = buildPlatformSelection(session);
    try { await interaction.update({ components: payload.components as never[] }); } catch { /* expired */ }
  }
}

// ─── Modal builders ───

function buildAnthropicKeyModal(): ModalBuilder {
  return new ModalBuilder()
    .setCustomId('wizard:modal:anthropic')
    .setTitle('Clé API Anthropic')
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('api_key')
          .setLabel('Clé API Anthropic (sk-ant-...)')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('sk-ant-api03-...')
          .setRequired(true),
      ),
    );
}

function buildGoogleKeyModal(): ModalBuilder {
  return new ModalBuilder()
    .setCustomId('wizard:modal:google')
    .setTitle('Clé API Google AI')
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('api_key')
          .setLabel('Clé API Google AI (AIza...)')
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

    // Ask for Google AI key — use plain content + ActionRow (ephemeral doesn't support V2 containers)
    await interaction.editReply({
      content: '✅ **Clé Anthropic validée !**\n\nMaintenant, la clé Google AI (optionnel — pour la génération d\'images et vidéos).',
      components: [row(
        btn('onboard:key:google', 'Entrer clé Google AI', ButtonStyle.Primary, '🔑'),
        btn('onboard:skip:google', 'Plus tard', ButtonStyle.Secondary, '⏭️'),
      )],
    });
    return;
  }

  if (customId === 'wizard:modal:google') {
    const apiKey = interaction.fields.getTextInputValue('api_key');
    await interaction.deferReply({ ephemeral: true });

    const valid = await validateGoogleAiKey(apiKey);
    if (!valid) {
      await interaction.editReply({ content: '❌ Clé Google AI invalide. Vérifie et réessaie.' });
      return;
    }

    const session = findSessionForUser(globalDb, interaction);
    if (session !== undefined) {
      (session.data as Record<string, unknown>)['_googleKey'] = apiKey;
      saveWizardSession(globalDb, session);
    }

    await advanceToPostiz(interaction, globalDb);
    return;
  }
}

// ─── Step handlers ───

async function advanceToPostiz(
  interaction: ButtonInteraction | ModalSubmitInteraction,
  globalDb: SqliteDatabase,
): Promise<void> {
  const { getAvailablePlatforms, PLATFORM_CONFIG } = await import('../postiz-setup.js');
  const available = getAvailablePlatforms();

  const platformButtons = available.map((p) => {
    const config = PLATFORM_CONFIG[p];
    return btn(`onboard:postiz:social:${p}`, config.label, ButtonStyle.Secondary, config.emoji);
  });

  const payload = v2([buildContainer(getColor('primary'), (c) => {
    c.addTextDisplayComponents(txt([
      '## 📤 Configuration Postiz',
      '',
      'Si tu as connecté des réseaux sociaux dans Postiz,',
      'vérifie que tout est en ordre.',
      '',
      'Si tu n\'as pas encore configuré Postiz, tu peux le faire plus tard.',
    ].join('\n')));
    c.addSeparatorComponents(sep());
    if (platformButtons.length > 0) {
      c.addActionRowComponents(row(...platformButtons.slice(0, 4)));
    }
    c.addActionRowComponents(row(
      btn('onboard:postiz:verify', 'Vérifier les intégrations', ButtonStyle.Primary, '🔄'),
      btn('onboard:postiz:skip', 'Plus tard', ButtonStyle.Secondary, '⏭️'),
    ));
  })]);

  const session = findSessionForUser(globalDb, interaction);
  if (interaction.replied || interaction.deferred) {
    const msg = await interaction.user.send({ components: payload.components as never[], flags: payload.flags });
    if (session !== undefined) { trackDmMessageId(session, msg.id); saveWizardSession(globalDb, session); }
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
      const msg = await interaction.user.send({ components: importPayload.components as never[], flags: importPayload.flags });
      trackDmMessageId(session, msg.id);
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
    const msg = await interaction.user.send({ components: payload.components as never[], flags: payload.flags });
    trackDmMessageId(session, msg.id);
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
      case 'review_categories':
      case 'refine_categories':
        ({ message: payload } = await generateCategories(session));
        break;
      case 'dryrun_searxng':
        payload = await dryRunCategories(session);
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
    const sentMsg = await interaction.user.send({ components: payload.components as never[], flags: payload.flags });
    trackDmMessageId(session, sentMsg.id);
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
    if (step === 'review_categories' || step === 'refine_categories') {
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
      const sentMsg = await interaction.user.send({ components: payload.components as never[], flags: payload.flags });
      trackDmMessageId(session, sentMsg.id);
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
  // Go back to categories step
  goToStep(session, 'review_categories');
  saveWizardSession(globalDb, session);

  try { await interaction.deferReply({ ephemeral: true }); } catch { /* expired */ }
  const { message: payload } = await generateCategories(session);
  try {
    const sentMsg = await interaction.user.send({ components: payload.components as never[], flags: payload.flags });
    trackDmMessageId(session, sentMsg.id);
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

    // 3. Register instance in global DB
    const cronOffset = registry.getActiveCount() * 3;
    globalDb.prepare(`
      INSERT INTO instances (id, guild_id, name, category_id, owner_id, status, cron_offset_minutes)
      VALUES (?, ?, ?, ?, ?, 'active', ?)
    `).run(instanceId, guild.id, instanceName, infra.categoryId, interaction.user.id, cronOffset);

    registerChannels(globalDb, instanceId, infra.channels);

    // 4. Store API keys
    const anthropicKey = (session.data as Record<string, unknown>)['_anthropicKey'] as string | undefined;
    if (anthropicKey !== undefined) {
      storeInstanceSecret(globalDb, instanceId, 'anthropic', anthropicKey);
    }
    const googleKey = (session.data as Record<string, unknown>)['_googleKey'] as string | undefined;
    if (googleKey !== undefined) {
      storeInstanceSecret(globalDb, instanceId, 'google_ai', googleKey);
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
      } else {
        seedCategories(instanceDb);
      }

      // Save persona from wizard
      if (session.data.personaFull !== undefined) {
        instanceDb.prepare(`
          INSERT INTO persona (id, content, updated_at) VALUES (1, ?, datetime('now'))
        `).run(session.data.personaFull);
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
      await interaction.user.send({ components: donePayload.components as never[], flags: donePayload.flags });
      await interaction.editReply({ content: '✅ Instance créée !' });
      setTimeout(() => { interaction.deleteReply().catch(() => {}); }, 5_000);
    } catch { /* expired */ }

    logger.info({ instanceId, guildId: guild.id, name: instanceName }, 'Instance created successfully');
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

function buildResumePrompt(session: WizardSession): ReturnType<typeof v2> {
  return v2([buildContainer(getColor('info'), (c) => {
    c.addTextDisplayComponents(txt([
      '## 📋 Onboarding en cours',
      '',
      `Tu as un onboarding en cours (étape **${session.step}**).`,
    ].join('\n')));
    c.addSeparatorComponents(sep());
    c.addActionRowComponents(row(
      btn('wizard:next', 'Reprendre', ButtonStyle.Success, '▶️'),
      btn('wizard:cancel', 'Recommencer', ButtonStyle.Danger, '✖️'),
    ));
  })]);
}
