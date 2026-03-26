import {
  ChannelType,
  PermissionFlagsBits,
  type Guild,
  type CategoryChannel,
} from 'discord.js';
import { getLogger } from '../core/logger.js';
import type { SqliteDatabase } from '../core/database.js';
import { ALL_CHANNEL_TYPES, type ChannelType as InstanceChannelType } from '../registry/instance-context.js';

interface ChannelDef {
  readonly type: InstanceChannelType;
  readonly name: string;
}

const CHANNEL_DEFS: readonly ChannelDef[] = [
  { type: 'dashboard', name: '📊╏dashboard' },
  { type: 'recherche', name: '🔍╏recherche' },
  { type: 'veille', name: '📰╏veille' },
  { type: 'idees', name: '💡╏idées' },
  { type: 'production', name: '🎬╏production' },
  { type: 'publication', name: '📤╏publication' },
  { type: 'logs', name: '📋╏logs' },
];

export interface CreatedInfrastructure {
  readonly categoryId: string;
  readonly channels: Record<InstanceChannelType, string>; // channelType → channelId
}

/**
 * Validate that the bot can create the instance infrastructure.
 * Returns error messages if validation fails.
 */
export async function validateInfrastructure(guild: Guild): Promise<string[]> {
  const errors: string[] = [];
  const me = guild.members.me;

  if (me === null) {
    errors.push('Le bot n\'est pas membre du serveur.');
    return errors;
  }

  if (!me.permissions.has(PermissionFlagsBits.ManageChannels)) {
    errors.push('Permission ManageChannels manquante.');
  }

  if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) {
    errors.push('Permission ManageRoles manquante.');
  }

  const channelCount = guild.channels.cache.size;
  if (channelCount + CHANNEL_DEFS.length + 1 > 500) {
    errors.push(`Trop de channels (${String(channelCount)}/500, besoin de ${String(CHANNEL_DEFS.length + 1)} de plus).`);
  }

  const categoryCount = guild.channels.cache.filter(
    (c) => c.type === ChannelType.GuildCategory,
  ).size;
  if (categoryCount >= 50) {
    errors.push('Limite de 50 catégories Discord atteinte.');
  }

  return errors;
}

/**
 * Create the full Discord infrastructure for an instance:
 * 1 category + 7 channels (private, visible only by admin + bot).
 *
 * If creation fails mid-way, rolls back (deletes what was created).
 */
export async function createInfrastructure(
  guild: Guild,
  instanceName: string,
  adminId: string,
): Promise<CreatedInfrastructure> {
  const logger = getLogger();
  const me = guild.members.me;

  if (me === null) {
    throw new Error('Bot is not a member of the guild');
  }

  let category: CategoryChannel | undefined;
  const createdChannelIds: string[] = [];

  try {
    // 1. Create category
    category = await guild.channels.create({
      name: instanceName,
      type: ChannelType.GuildCategory,
      permissionOverwrites: [
        {
          id: guild.id, // @everyone
          deny: [PermissionFlagsBits.ViewChannel],
        },
        {
          id: adminId,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
          ],
        },
        {
          id: me.id,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ManageMessages,
            PermissionFlagsBits.EmbedLinks,
            PermissionFlagsBits.AttachFiles,
          ],
        },
      ],
    });

    logger.info({ categoryId: category.id, name: instanceName }, 'Category created');

    // 2. Create channels
    const channels: Record<string, string> = {};

    for (const def of CHANNEL_DEFS) {
      const channel = await guild.channels.create({
        name: def.name,
        type: ChannelType.GuildText,
        parent: category.id,
        // Permissions inherited from category
      });

      channels[def.type] = channel.id;
      createdChannelIds.push(channel.id);
      logger.debug({ channelType: def.type, channelId: channel.id }, 'Channel created');
    }

    return {
      categoryId: category.id,
      channels: channels as Record<InstanceChannelType, string>,
    };
  } catch (error) {
    // Rollback: delete created channels and category
    logger.error({ error: error instanceof Error ? error.message : String(error) }, 'Infrastructure creation failed, rolling back');

    for (const channelId of createdChannelIds) {
      try {
        const ch = await guild.channels.fetch(channelId);
        if (ch !== null) await ch.delete('Rollback: instance creation failed');
      } catch {
        // Already deleted
      }
    }

    if (category !== undefined) {
      try {
        await category.delete('Rollback: instance creation failed');
      } catch {
        // Already deleted
      }
    }

    throw error;
  }
}

/**
 * Register the created channels in the global DB.
 */
export function registerChannels(
  globalDb: SqliteDatabase,
  instanceId: string,
  channels: Record<InstanceChannelType, string>,
): void {
  const insert = globalDb.prepare(
    'INSERT INTO instance_channels (instance_id, channel_type, channel_id) VALUES (?, ?, ?)',
  );

  const insertAll = globalDb.transaction(() => {
    for (const channelType of ALL_CHANNEL_TYPES) {
      const channelId = channels[channelType];
      if (channelId !== undefined) {
        insert.run(instanceId, channelType, channelId);
      }
    }
  });

  insertAll();
}
