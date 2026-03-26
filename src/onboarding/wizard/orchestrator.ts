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
    const guildId = interaction.guildId ?? interaction.message?.guildId ?? null;
    if (guildId === null) {
      await interaction.reply({ content: '❌ Cette commande doit être utilisée depuis un serveur.', ephemeral: true });
      return;
    }

    let session = getActiveWizardSession(globalDb, guildId, interaction.user.id);
    if (session !== undefined) {
      // Resume existing session
      const payload = buildResumePrompt(session);
      await interaction.reply({ components: payload.components as never[], flags: payload.flags, ephemeral: true } as never);
      return;
    }

    session = createWizardSession(globalDb, guildId, interaction.user.id);
    saveWizardSession(globalDb, session);

    // Start with API key collection (Modal)
    const modal = buildAnthropicKeyModal();
    await interaction.showModal(modal);
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
      await interaction.editReply({ components: payload.components as never[] });
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
    deleteWizardSession(globalDb, session.id);
    await interaction.reply({ content: '❌ Onboarding annulé.', ephemeral: true });
  } else if (customId.startsWith('wizard:tone:')) {
    const tone = customId.split(':')[2] ?? 'sarcastic';
    setTone(session, tone);
    saveWizardSession(globalDb, session);
    advanceStep(session);
    saveWizardSession(globalDb, session);
    const payload = await generatePersonaSection(session, 'identity');
    await interaction.reply({ components: payload.components as never[], flags: payload.flags, ephemeral: true } as never);
  } else if (customId.startsWith('wizard:platform:')) {
    const platform = customId.split(':')[2] ?? '';
    togglePlatform(session, platform);
    saveWizardSession(globalDb, session);
    const payload = buildPlatformSelection(session);
    await interaction.update({ components: payload.components as never[] });
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

    // Store temporarily — will be persisted to instance on confirm
    const session = findSessionForUser(globalDb, interaction);
    if (session !== undefined) {
      // Store in session data for now
      (session.data as Record<string, unknown>)['_anthropicKey'] = apiKey;
      saveWizardSession(globalDb, session);
    }

    // Ask for Google AI key
    const payload = v2([buildContainer(getColor('success'), (c) => {
      c.addTextDisplayComponents(txt('## ✅ Clé Anthropic validée\n\nMaintenant, la clé Google AI (optionnel — pour la génération d\'images et vidéos).'));
      c.addSeparatorComponents(sep());
      c.addActionRowComponents(row(
        btn('onboard:key:google', 'Entrer clé Google AI', ButtonStyle.Primary, '🔑'),
        btn('onboard:skip:google', 'Plus tard', ButtonStyle.Secondary, '⏭️'),
      ));
    })]);

    await interaction.editReply({ components: payload.components as never[] });
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
  _globalDb: SqliteDatabase,
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

  if (interaction.replied || interaction.deferred) {
    await interaction.editReply({ components: payload.components as never[] });
  } else {
    await interaction.reply({ components: payload.components as never[], flags: payload.flags, ephemeral: true } as never);
  }
}

async function advanceToDescribe(
  interaction: ButtonInteraction | ModalSubmitInteraction,
  globalDb: SqliteDatabase,
): Promise<void> {
  const session = findSessionForUser(globalDb, interaction);
  if (session === undefined) return;

  session.step = 'describe_project';
  saveWizardSession(globalDb, session);

  const payload = buildDescribePrompt(session);

  if (interaction.replied || interaction.deferred) {
    await interaction.editReply({ components: payload.components as never[] });
  } else {
    await interaction.reply({ components: payload.components as never[], flags: payload.flags, ephemeral: true } as never);
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

  await interaction.deferReply({ ephemeral: true });

  let payload;

  switch (nextStep) {
    case 'review_categories':
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

  saveWizardSession(globalDb, session);
  await interaction.editReply({ components: payload.components as never[] });
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

  await interaction.deferReply({ ephemeral: true });

  // Re-run the current step
  let payload;
  const step = session.step;

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

  if (payload !== undefined) {
    saveWizardSession(globalDb, session);
    await interaction.editReply({ components: payload.components as never[] });
  } else {
    await interaction.editReply({ content: 'Régénération non disponible pour cette étape.' });
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

  await interaction.deferReply({ ephemeral: true });
  const { message: payload } = await generateCategories(session);
  await interaction.editReply({ components: payload.components as never[] });
}

async function handleWizardConfirm(
  interaction: ButtonInteraction,
  session: WizardSession,
  globalDb: SqliteDatabase,
  registry: InstanceRegistry,
): Promise<void> {
  const logger = getLogger();

  await interaction.deferReply({ ephemeral: true });

  const guild = interaction.guild;
  if (guild === null) {
    await interaction.editReply({ content: '❌ Cette action doit être effectuée depuis un serveur.' });
    return;
  }

  // 1. Validate infrastructure
  const errors = await validateInfrastructure(guild);
  if (errors.length > 0) {
    await interaction.editReply({ content: `❌ Impossible de créer l'instance :\n${errors.join('\n')}` });
    return;
  }

  const instanceName = session.data.instanceName ?? session.data.projectName ?? 'mon-instance';
  const instanceId = instanceName.toLowerCase().replace(/[^a-z0-9-]/g, '-');

  try {
    // 2. Create Discord channels
    await interaction.editReply({ content: '🏗️ Création des channels Discord...' });
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
    await interaction.editReply({ content: '💾 Initialisation de la base de données...' });
    const instanceDb = createInstanceDatabase(instanceId);

    // Seed categories
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

    // Save persona
    if (session.data.personaFull !== undefined) {
      instanceDb.prepare(`
        INSERT INTO persona (id, content, updated_at) VALUES (1, ?, datetime('now'))
      `).run(session.data.personaFull);
    }

    // 6. Post dashboard + search interface
    await interaction.editReply({ content: '📊 Création du dashboard...' });

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

    // 8. Clean up wizard session
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

    await interaction.editReply({ components: donePayload.components as never[] });

    logger.info({ instanceId, guildId: guild.id, name: instanceName }, 'Instance created successfully');
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error({ error: msg }, 'Instance creation failed');
    await interaction.editReply({ content: `❌ Erreur lors de la création : ${msg}` });
  }
}

// ─── Helpers ───

function findSessionForUser(globalDb: SqliteDatabase, interaction: Interaction): WizardSession | undefined {
  // Try to find a session for this user across all guilds
  const guildId = interaction.guildId ?? '';
  if (guildId.length > 0) {
    return getActiveWizardSession(globalDb, guildId, interaction.user.id);
  }

  // DM context — search all sessions for this user
  const row = globalDb.prepare(`
    SELECT guild_id FROM wizard_sessions
    WHERE user_id = ? AND expires_at > datetime('now')
    ORDER BY created_at DESC LIMIT 1
  `).get(interaction.user.id) as { guild_id: string } | undefined;

  if (row === undefined) return undefined;
  return getActiveWizardSession(globalDb, row.guild_id, interaction.user.id);
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
