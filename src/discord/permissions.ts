import { type Interaction, MessageFlags } from 'discord.js';
import { getConfig } from '../core/config.js';

export function isOwner(interaction: Interaction): boolean {
  const config = getConfig();
  return interaction.user.id === config.DISCORD_OWNER_ID;
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
