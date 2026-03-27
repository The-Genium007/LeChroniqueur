import type { Guild } from 'discord.js';
import { getLogger } from '../core/logger.js';
import {
  buildContainer, txt, sep, btn, row, v2, getColor,
  ButtonStyle,
} from '../discord/component-builder-v2.js';

/**
 * Handle the bot being added to a new guild.
 * Sends a DM to the guild owner with a welcome message and onboarding button.
 */
export async function handleGuildCreate(guild: Guild): Promise<void> {
  const logger = getLogger();

  logger.info({ guildId: guild.id, guildName: guild.name }, 'Bot added to new guild');

  try {
    const owner = await guild.fetchOwner();

    const payload = v2([buildContainer(getColor('primary'), (c) => {
      c.addTextDisplayComponents(txt([
        '# 👋 Bienvenue !',
        '',
        `Je viens de rejoindre **${guild.name}**.`,
        '',
        'Pour commencer, il faut créer une première **instance** — c\'est un agent autonome avec son propre persona, ses sujets de veille, et ses channels dédiés.',
        '',
        'L\'onboarding va te guider pas à pas :',
        '1. 🔑 Configuration des clés API (Anthropic, Google AI)',
        '2. 📤 Configuration Postiz (publication réseaux sociaux)',
        '3. 🤖 Wizard IA (persona + catégories de veille)',
        '4. 🏗️ Création automatique des channels Discord',
      ].join('\n')));
      c.addSeparatorComponents(sep());
      c.addActionRowComponents(row(
        btn('onboard:start', 'Créer ma première instance', ButtonStyle.Success, '🚀'),
        btn('onboard:import', 'Importer une configuration', ButtonStyle.Secondary, '📥'),
      ));
    })]);

    await owner.send({
      components: payload.components as never[],
      flags: payload.flags,
    });

    logger.info({ ownerId: owner.id }, 'Welcome DM sent to guild owner');
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.warn({ guildId: guild.id, error: msg }, 'Failed to send welcome DM to guild owner (DMs may be disabled)');

    // Fallback: try to send in the system channel
    const systemChannel = guild.systemChannel;
    if (systemChannel !== null) {
      try {
        const fallbackPayload = v2([buildContainer(getColor('primary'), (c) => {
          c.addTextDisplayComponents(txt([
            '# 👋 Bienvenue !',
            '',
            'Je n\'ai pas pu t\'envoyer un DM. Pour commencer l\'onboarding,',
            'le propriétaire du serveur peut cliquer le bouton ci-dessous.',
          ].join('\n')));
          c.addSeparatorComponents(sep());
          c.addActionRowComponents(row(
            btn('onboard:start', 'Commencer l\'onboarding', ButtonStyle.Success, '🚀'),
            btn('onboard:import', 'Importer', ButtonStyle.Secondary, '📥'),
          ));
        })]);

        await systemChannel.send({
          components: fallbackPayload.components as never[],
          flags: fallbackPayload.flags,
        });
      } catch {
        logger.error({ guildId: guild.id }, 'Failed to send welcome message in system channel');
      }
    }
  }
}

/**
 * Check if any guild the bot is in has no instances yet.
 * Used at boot to send welcome messages to guilds that added the bot while it was offline.
 */
export function getGuildsWithoutInstances(
  guildIds: string[],
  globalDb: import('../core/database.js').SqliteDatabase,
): string[] {
  const guildsWithInstances = new Set<string>();

  const rows = globalDb.prepare(
    'SELECT DISTINCT guild_id FROM instances',
  ).all() as Array<{ guild_id: string }>;

  for (const row of rows) {
    guildsWithInstances.add(row.guild_id);
  }

  return guildIds.filter((id) => !guildsWithInstances.has(id));
}
