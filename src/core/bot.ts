import {
  Client,
  GatewayIntentBits,
  type TextChannel,
  ChannelType,
} from 'discord.js';
import { getConfig } from './config.js';
import { getLogger } from './logger.js';

export interface ChannelMap {
  readonly veille: TextChannel;
  readonly idees: TextChannel;
  readonly production: TextChannel;
  readonly publication: TextChannel;
  readonly logs: TextChannel;
  readonly admin: TextChannel;
  readonly bugs: TextChannel;
  readonly feedback: TextChannel;
}

export function createClient(): Client {
  return new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });
}

export async function resolveChannels(client: Client): Promise<ChannelMap> {
  const config = getConfig();
  const logger = getLogger();

  const channelEntries = [
    ['veille', config.CHANNEL_VEILLE],
    ['idees', config.CHANNEL_IDEES],
    ['production', config.CHANNEL_PRODUCTION],
    ['publication', config.CHANNEL_PUBLICATION],
    ['logs', config.CHANNEL_LOGS],
    ['admin', config.CHANNEL_ADMIN],
    ['bugs', config.CHANNEL_BUGS],
    ['feedback', config.CHANNEL_FEEDBACK],
  ] as const;

  const resolved: Record<string, TextChannel> = {};

  for (const [name, id] of channelEntries) {
    const channel = await client.channels.fetch(id);

    if (channel === null) {
      throw new Error(`Channel #${name} (${id}) not found`);
    }

    if (channel.type !== ChannelType.GuildText) {
      throw new Error(`Channel #${name} (${id}) is not a text channel`);
    }

    resolved[name] = channel;
    logger.debug({ channel: name, id }, 'Channel resolved');
  }

  return resolved as unknown as ChannelMap;
}

export async function loginBot(client: Client): Promise<void> {
  const config = getConfig();
  const logger = getLogger();

  return new Promise((resolve, reject) => {
    client.once('ready', () => {
      logger.info({ tag: client.user?.tag }, 'Bot connected to Discord');
      resolve();
    });

    client.once('error', (error) => {
      reject(new Error(`Discord connection failed: ${error.message}`));
    });

    void client.login(config.DISCORD_TOKEN).catch(reject);
  });
}
