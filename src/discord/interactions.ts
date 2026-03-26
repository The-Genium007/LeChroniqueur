import type {
  Interaction,
  ChatInputCommandInteraction,
  ButtonInteraction,
} from 'discord.js';
import { getLogger } from '../core/logger.js';
import { requireOwner } from './permissions.js';

export interface ButtonAction {
  readonly action: string;
  readonly targetTable: string;
  readonly targetId: number;
}

export type CommandHandler = (interaction: ChatInputCommandInteraction) => Promise<void>;
export type ButtonHandler = (interaction: ButtonInteraction, parsed: ButtonAction) => Promise<void>;

interface InteractionRouter {
  readonly commandHandlers: Map<string, CommandHandler>;
  readonly buttonHandlers: Map<string, ButtonHandler>;
}

export function parseButtonCustomId(customId: string): ButtonAction | undefined {
  const parts = customId.split(':');
  if (parts.length < 2) {
    return undefined;
  }

  const action = parts[0];
  const targetTable = parts[1];

  if (action === undefined || targetTable === undefined) {
    return undefined;
  }

  // 2-segment IDs (dash:home, search:open) → targetId = 0
  const targetIdStr = parts[2];
  const targetId = targetIdStr !== undefined ? parseInt(targetIdStr, 10) : 0;

  return { action, targetTable, targetId: isNaN(targetId) ? 0 : targetId };
}

export function createInteractionRouter(router: InteractionRouter) {
  const logger = getLogger();

  return async function handleInteraction(interaction: Interaction): Promise<void> {
    // ─── Slash commands ───
    if (interaction.isChatInputCommand()) {
      const isAllowed = await requireOwner(interaction);
      if (!isAllowed) return;

      const handler = router.commandHandlers.get(interaction.commandName);
      if (handler === undefined) {
        logger.warn({ command: interaction.commandName }, 'Unknown command');
        return;
      }

      try {
        await handler(interaction);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error({ command: interaction.commandName, error: message }, 'Command handler error');

        if (interaction.replied || interaction.deferred) {
          await interaction.followUp({ content: `Erreur : ${message}`, ephemeral: true });
        } else {
          await interaction.reply({ content: `Erreur : ${message}`, ephemeral: true });
        }
      }

      return;
    }

    // ─── Button interactions ───
    if (interaction.isButton()) {
      const isAllowed = await requireOwner(interaction);
      if (!isAllowed) return;

      const parsed = parseButtonCustomId(interaction.customId);
      if (parsed === undefined) {
        logger.warn({ customId: interaction.customId }, 'Invalid button customId');
        return;
      }

      const handler = router.buttonHandlers.get(parsed.action);
      if (handler === undefined) {
        logger.warn({ action: parsed.action }, 'Unknown button action');
        return;
      }

      try {
        await handler(interaction, parsed);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error({ action: parsed.action, error: message }, 'Button handler error');

        if (interaction.replied || interaction.deferred) {
          await interaction.followUp({ content: `Erreur : ${message}`, ephemeral: true });
        } else {
          await interaction.reply({ content: `Erreur : ${message}`, ephemeral: true });
        }
      }
    }
  };
}
