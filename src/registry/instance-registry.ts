import type { Client, TextChannel, Interaction } from 'discord.js';
import { ChannelType as DiscordChannelType } from 'discord.js';
import type { SqliteDatabase } from '../core/database.js';
import { createInstanceDatabase } from '../core/database.js';
import { decrypt, type EncryptedData } from '../core/crypto.js';
import { getConfig, DEFAULT_INSTANCE_CONFIG, type InstanceConfig, type InstanceVeilleCategory } from '../core/config.js';
import { getLogger } from '../core/logger.js';
import { personaLoader } from '../core/persona-loader.js';
import { getCategoriesFromDb } from '../veille/queries.js';
import { getProfile, buildFallbackProfile, type InstanceProfile } from '../core/instance-profile.js';
import type {
  InstanceContext,
  InstanceChannelMap,
  InstanceSecrets,
  InstanceRecord,
  InstanceChannelRecord,
  ChannelType,
} from './instance-context.js';

export class InstanceRegistry {
  private readonly instances = new Map<string, InstanceContext>();
  private readonly channelIndex = new Map<string, string>(); // channelId → instanceId
  private readonly globalDb: SqliteDatabase;
  private readonly client: Client;

  constructor(globalDb: SqliteDatabase, client: Client) {
    this.globalDb = globalDb;
    this.client = client;
  }

  // ─── Loading ───

  async loadAll(): Promise<void> {
    const logger = getLogger();

    const rows = this.globalDb.prepare(
      "SELECT * FROM instances WHERE status IN ('active', 'paused')",
    ).all() as InstanceRecord[];

    logger.info({ count: rows.length }, 'Loading instances');

    for (const row of rows) {
      try {
        const ctx = await this.loadInstance(row);
        this.instances.set(ctx.id, ctx);
        this.indexChannels(ctx);
        logger.info({ instanceId: ctx.id, name: ctx.name }, 'Instance loaded');
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error({ instanceId: row.id, error: msg }, 'Failed to load instance, skipping');
      }
    }
  }

  private async loadInstance(row: InstanceRecord): Promise<InstanceContext> {
    const config = getConfig();

    // Open instance DB
    const db = createInstanceDatabase(row.id);

    // Load channels
    const channelRecords = this.globalDb.prepare(
      'SELECT * FROM instance_channels WHERE instance_id = ?',
    ).all(row.id) as InstanceChannelRecord[];

    const channels = await this.resolveChannels(channelRecords);

    // Load secrets
    const secrets = this.loadSecrets(row.id, config.MASTER_ENCRYPTION_KEY);

    // Load persona
    const persona = personaLoader.loadForInstance(row.id, db);

    // Load categories from instance DB
    const categories = getCategoriesFromDb(db);

    // Load instance profile (V3) or build fallback for V2 instances
    const profile: InstanceProfile = getProfile(db) ?? buildFallbackProfile(row.name);

    // Build config from DB overrides + defaults + profile
    const instanceConfig = this.buildInstanceConfig(db, row.name, persona, categories, profile);

    return {
      id: row.id,
      name: row.name,
      guildId: row.guild_id,
      ownerId: row.owner_id,
      categoryId: row.category_id,
      config: instanceConfig,
      profile,
      db,
      channels,
      secrets,
      status: row.status as 'active' | 'paused' | 'archived',
      createdAt: row.created_at,
      cronOffsetMinutes: row.cron_offset_minutes,
    };
  }

  private async resolveChannels(records: InstanceChannelRecord[]): Promise<InstanceChannelMap> {
    const resolved: Record<string, TextChannel> = {};
    const logger = getLogger();

    for (const rec of records) {
      try {
        const channel = await this.client.channels.fetch(rec.channel_id);
        if (channel === null) {
          logger.warn({ channelType: rec.channel_type, channelId: rec.channel_id }, 'Channel fetch returned null');
          continue;
        }
        if (channel.type !== DiscordChannelType.GuildText) {
          logger.warn({ channelType: rec.channel_type, channelId: rec.channel_id, actualType: channel.type }, 'Channel is not GuildText');
          continue;
        }
        resolved[rec.channel_type] = channel as TextChannel;
        logger.debug({ channelType: rec.channel_type, channelId: rec.channel_id }, 'Channel resolved');
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.warn({ channelType: rec.channel_type, channelId: rec.channel_id, error: msg }, 'Channel not found');
      }
    }

    return resolved as unknown as InstanceChannelMap;
  }

  private loadSecrets(instanceId: string, masterKey: string): InstanceSecrets {
    const rows = this.globalDb.prepare(
      'SELECT key_type, encrypted_value, iv, auth_tag FROM instance_secrets WHERE instance_id = ?',
    ).all(instanceId) as Array<{ key_type: string; encrypted_value: string; iv: string; auth_tag: string }>;

    const secrets: Record<string, string> = {};

    for (const row of rows) {
      try {
        const data: EncryptedData = {
          encrypted: row.encrypted_value,
          iv: row.iv,
          authTag: row.auth_tag,
        };
        secrets[row.key_type] = decrypt(data, masterKey);
      } catch {
        getLogger().warn({ instanceId, keyType: row.key_type }, 'Failed to decrypt secret');
      }
    }

    return {
      anthropicApiKey: secrets['llm'] ?? secrets['anthropic'] ?? '',
      anthropicModel: secrets['anthropic_model'] ?? 'claude-sonnet-4-20250514',
      googleAiApiKey: secrets['google_ai'],
      postizApiUrl: secrets['postiz_url'],
      postizApiKey: secrets['postiz_api_key'],
    };
  }

  private buildInstanceConfig(
    db: SqliteDatabase,
    name: string,
    persona: string,
    categories: readonly InstanceVeilleCategory[],
    profile: InstanceProfile,
  ): InstanceConfig {
    const overrides = new Map<string, string>();
    const rows = db.prepare('SELECT key, value FROM config_overrides').all() as Array<{ key: string; value: string }>;
    for (const row of rows) {
      overrides.set(row.key, row.value);
    }

    const getNum = (key: string, def: number): number => {
      const v = overrides.get(key);
      return v !== undefined ? Number(v) : def;
    };

    const getStr = (key: string, def: string): string => {
      return overrides.get(key) ?? def;
    };

    return {
      name,
      persona,
      categories,
      scheduler: {
        veilleCron: getStr('veilleCron', DEFAULT_INSTANCE_CONFIG.scheduler.veilleCron),
        suggestionsCron: getStr('suggestionsCron', DEFAULT_INSTANCE_CONFIG.scheduler.suggestionsCron),
        rapportCron: getStr('rapportCron', DEFAULT_INSTANCE_CONFIG.scheduler.rapportCron),
      },
      budget: {
        dailyCents: getNum('dailyCents', DEFAULT_INSTANCE_CONFIG.budget.dailyCents),
        weeklyCents: getNum('weeklyCents', DEFAULT_INSTANCE_CONFIG.budget.weeklyCents),
        monthlyCents: getNum('monthlyCents', DEFAULT_INSTANCE_CONFIG.budget.monthlyCents),
      },
      content: {
        suggestionsPerCycle: getNum('suggestionsPerCycle', DEFAULT_INSTANCE_CONFIG.content.suggestionsPerCycle),
        minScoreToPropose: getNum('minScoreToPropose', DEFAULT_INSTANCE_CONFIG.content.minScoreToPropose),
        platforms: profile.targetPlatforms.length > 0 ? profile.targetPlatforms : DEFAULT_INSTANCE_CONFIG.content.platforms,
        formats: profile.targetFormats.length > 0 ? profile.targetFormats : DEFAULT_INSTANCE_CONFIG.content.formats,
        pillars: profile.pillars.length > 0 ? profile.pillars : DEFAULT_INSTANCE_CONFIG.content.pillars,
      },
      theme: { ...DEFAULT_INSTANCE_CONFIG.theme },
    };
  }

  private indexChannels(ctx: InstanceContext): void {
    const channelMap = ctx.channels as unknown as Record<string, TextChannel | undefined>;
    for (const channel of Object.values(channelMap)) {
      if (channel !== undefined) {
        this.channelIndex.set(channel.id, ctx.id);
      }
    }
  }

  // ─── Routing ───

  resolveFromChannel(channelId: string): InstanceContext | undefined {
    const instanceId = this.channelIndex.get(channelId);
    if (instanceId === undefined) return undefined;
    return this.instances.get(instanceId);
  }

  resolveFromInteraction(interaction: Interaction): InstanceContext | undefined {
    if (interaction.channelId === null) return undefined;

    // Direct channel match
    const direct = this.resolveFromChannel(interaction.channelId);
    if (direct !== undefined) return direct;

    // Thread support: if the interaction is in a thread, check the parent channel
    const channel = interaction.channel;
    if (channel !== null && 'parentId' in channel && channel.parentId !== null) {
      return this.resolveFromChannel(channel.parentId);
    }

    return undefined;
  }

  // ─── CRUD ───

  register(ctx: InstanceContext): void {
    this.instances.set(ctx.id, ctx);
    this.indexChannels(ctx);
  }

  unregister(id: string): void {
    const ctx = this.instances.get(id);
    if (ctx !== undefined) {
      const channelMap = ctx.channels as unknown as Record<string, TextChannel | undefined>;
      for (const channel of Object.values(channelMap)) {
        if (channel !== undefined) {
          this.channelIndex.delete(channel.id);
        }
      }
      this.instances.delete(id);
    }
  }

  get(id: string): InstanceContext | undefined {
    return this.instances.get(id);
  }

  getAll(): InstanceContext[] {
    return [...this.instances.values()];
  }

  getByGuild(guildId: string): InstanceContext[] {
    return [...this.instances.values()].filter((ctx) => ctx.guildId === guildId);
  }

  getActiveCount(): number {
    return [...this.instances.values()].filter((ctx) => ctx.status === 'active').length;
  }

  // ─── Channel record management ───

  setChannelMessageId(instanceId: string, channelType: ChannelType, messageId: string): void {
    this.globalDb.prepare(
      'UPDATE instance_channels SET message_id = ? WHERE instance_id = ? AND channel_type = ?',
    ).run(messageId, instanceId, channelType);
  }

  getChannelMessageId(instanceId: string, channelType: ChannelType): string | null {
    const row = this.globalDb.prepare(
      'SELECT message_id FROM instance_channels WHERE instance_id = ? AND channel_type = ?',
    ).get(instanceId, channelType) as { message_id: string | null } | undefined;
    return row?.message_id ?? null;
  }
}
