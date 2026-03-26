import { type Interaction, MessageFlags } from 'discord.js';
import { getConfig } from '../core/config.js';

/**
 * Check if an interaction comes from the legacy owner (env var).
 */
export function isOwner(interaction: Interaction): boolean {
  const config = getConfig();
  return interaction.user.id === config.DISCORD_OWNER_ID;
}

/**
 * Check if an interaction comes from a specific owner (instance-based).
 */
export function isInstanceOwner(interaction: Interaction, ownerId: string): boolean {
  return interaction.user.id === ownerId;
}

export async function requireOwner(interaction: Interaction): Promise<boolean> {
  if (isOwner(interaction)) {
    return true;
  }

  if (interaction.isRepliable()) {
    await interaction.reply({
      content: 'Ces boutons sont réservés au propriétaire.',
      flags: MessageFlags.Ephemeral,
    });
  }

  return false;
}

export async function requireInstanceOwner(
  interaction: Interaction,
  ownerId: string,
): Promise<boolean> {
  if (isInstanceOwner(interaction, ownerId)) {
    return true;
  }

  if (interaction.isRepliable()) {
    await interaction.reply({
      content: 'Ces boutons sont réservés au propriétaire de cette instance.',
      flags: MessageFlags.Ephemeral,
    });
  }

  return false;
}
