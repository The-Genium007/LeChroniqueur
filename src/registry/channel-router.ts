import {
  type Interaction,
  type Message,
  Events,
  type Client,
} from 'discord.js';
import { getLogger } from '../core/logger.js';
import type { InstanceRegistry } from './instance-registry.js';
import type { InstanceContext } from './instance-context.js';

export type InstanceInteractionHandler = (
  interaction: Interaction,
  ctx: InstanceContext,
) => Promise<void>;

export type InstanceMessageHandler = (
  message: Message,
  ctx: InstanceContext,
) => Promise<void>;

export type GlobalInteractionHandler = (
  interaction: Interaction,
) => Promise<void>;

export type DirectMessageHandler = (
  message: Message,
) => Promise<void>;

/**
 * Route Discord events to the correct instance context.
 *
 * - Interactions in instance channels → routed to that instance's handler
 * - Interactions with no instance (DMs, onboarding buttons) → routed to global handler
 * - Messages in instance channels → routed to that instance's message handler
 */
export function setupChannelRouter(
  client: Client,
  registry: InstanceRegistry,
  handlers: {
    instanceInteraction: InstanceInteractionHandler;
    instanceMessage: InstanceMessageHandler;
    globalInteraction: GlobalInteractionHandler;
    onDirectMessage: DirectMessageHandler;
    onChannelDelete: (channelId: string) => Promise<void>;
    onGuildCreate: (guild: import('discord.js').Guild) => Promise<void>;
    onGuildDelete: (guild: import('discord.js').Guild) => Promise<void>;
  },
): void {
  const logger = getLogger();

  // ─── Interactions (buttons, commands, modals) ───
  client.on(Events.InteractionCreate, (interaction) => {
    const ctx = registry.resolveFromInteraction(interaction);

    if (ctx !== undefined) {
      void handlers.instanceInteraction(interaction, ctx).catch((error) => {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error({ instanceId: ctx.id, error: msg }, 'Instance interaction handler error');
      });
    } else {
      void handlers.globalInteraction(interaction).catch((error) => {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error({ error: msg }, 'Global interaction handler error');
      });
    }
  });

  // ─── Messages (for admin text input in instance channels) ───
  client.on(Events.MessageCreate, (message) => {
    if (message.author.bot) return;
    if (message.channelId === null) return;

    const ctx = registry.resolveFromChannel(message.channelId);
    if (ctx !== undefined) {
      void handlers.instanceMessage(message, ctx).catch((error) => {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error({ instanceId: ctx.id, error: msg }, 'Instance message handler error');
      });
    } else if (message.guild === null) {
      // DM — route to wizard text handler
      void handlers.onDirectMessage(message).catch((error) => {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error({ error: msg }, 'DM handler error');
      });
    }
  });

  // ─── Channel deleted ───
  client.on(Events.ChannelDelete, (channel) => {
    void handlers.onChannelDelete(channel.id).catch((error) => {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error({ channelId: channel.id, error: msg }, 'Channel delete handler error');
    });
  });

  // ─── Bot added to guild ───
  client.on(Events.GuildCreate, (guild) => {
    void handlers.onGuildCreate(guild).catch((error) => {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error({ guildId: guild.id, error: msg }, 'Guild create handler error');
    });
  });

  // ─── Bot removed from guild ───
  client.on(Events.GuildDelete, (guild) => {
    void handlers.onGuildDelete(guild).catch((error) => {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error({ guildId: guild.id, error: msg }, 'Guild delete handler error');
    });
  });
}
