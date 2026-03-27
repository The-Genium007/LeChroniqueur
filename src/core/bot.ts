import {
  Client,
  GatewayIntentBits,
  Partials,
} from 'discord.js';
import { getConfig } from './config.js';
import { getLogger } from './logger.js';

export function createClient(): Client {
  return new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMessageTyping,
    ],
    partials: [
      Partials.Channel, // Required to receive DM messages
    ],
  });
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
