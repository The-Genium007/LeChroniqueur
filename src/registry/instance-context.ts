import type { TextChannel } from 'discord.js';
import type { SqliteDatabase } from '../core/database.js';
import type { InstanceConfig } from '../core/config.js';
import type { InstanceProfile } from '../core/instance-profile.js';

export interface InstanceChannelMap {
  readonly dashboard: TextChannel;
  readonly recherche: TextChannel;
  readonly veille: TextChannel;
  readonly idees: TextChannel;
  readonly production: TextChannel;
  readonly publication: TextChannel;
  readonly logs: TextChannel;
}

export type ChannelType = keyof InstanceChannelMap;

export const ALL_CHANNEL_TYPES: readonly ChannelType[] = [
  'dashboard', 'recherche', 'veille', 'idees',
  'production', 'publication', 'logs',
] as const;

export interface InstanceSecrets {
  readonly anthropicApiKey: string;
  readonly anthropicModel: string;
  readonly geminiApiKey: string;
  readonly googleCloudApiKey?: string | undefined;
  readonly postizApiUrl?: string | undefined;
  readonly postizApiKey?: string | undefined;
}

export interface InstanceContext {
  readonly id: string;
  readonly name: string;
  readonly guildId: string;
  readonly ownerId: string;
  readonly categoryId: string;
  readonly config: InstanceConfig;
  readonly profile: InstanceProfile;
  readonly db: SqliteDatabase;
  readonly channels: InstanceChannelMap;
  readonly secrets: InstanceSecrets;
  readonly status: 'active' | 'paused' | 'archived';
  readonly createdAt: string;
  readonly cronOffsetMinutes: number;
}

export interface InstanceChannelRecord {
  readonly instance_id: string;
  readonly channel_type: string;
  readonly channel_id: string;
  readonly message_id: string | null;
}

export interface InstanceRecord {
  readonly id: string;
  readonly guild_id: string;
  readonly name: string;
  readonly category_id: string;
  readonly owner_id: string;
  readonly status: string;
  readonly cron_offset_minutes: number;
  readonly created_at: string;
}
