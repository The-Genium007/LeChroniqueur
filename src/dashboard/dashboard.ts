import type { TextChannel } from 'discord.js';
import { MessageFlags } from 'discord.js';
import type { SqliteDatabase } from '../core/database.js';
import { getLogger } from '../core/logger.js';
import { buildDashboardHome, collectDashboardHomeData } from './pages/home.js';

/**
 * Ensure the dashboard message exists in the channel.
 * If it was deleted, recreate it. Returns the message ID.
 */
export async function ensureDashboardExists(
  channel: TextChannel,
  db: SqliteDatabase,
  instanceName: string,
  createdAt: string,
  isPaused: boolean,
  storedMessageId: string | null,
  onMessageIdChange: (newId: string) => void,
): Promise<string> {
  const logger = getLogger();

  // Try to fetch existing message
  if (storedMessageId !== null) {
    try {
      await channel.messages.fetch(storedMessageId);
      return storedMessageId;
    } catch {
      logger.warn({ messageId: storedMessageId }, 'Dashboard message not found, recreating');
    }
  }

  // Create new dashboard message
  const data = collectDashboardHomeData(db, instanceName, createdAt, isPaused);
  const payload = buildDashboardHome(data);

  const msg = await channel.send({
    components: payload.components as never[],
    flags: payload.flags,
  });

  onMessageIdChange(msg.id);
  logger.info({ messageId: msg.id, channelId: channel.id }, 'Dashboard message created');

  return msg.id;
}

/**
 * Refresh the dashboard home page (update existing message with fresh data).
 * Called after each cron job completes.
 */
export async function refreshDashboard(
  channel: TextChannel,
  messageId: string,
  db: SqliteDatabase,
  instanceName: string,
  createdAt: string,
  isPaused: boolean,
): Promise<void> {
  const logger = getLogger();

  try {
    const msg = await channel.messages.fetch(messageId);
    const data = collectDashboardHomeData(db, instanceName, createdAt, isPaused);
    const payload = buildDashboardHome(data);

    await msg.edit({
      components: payload.components as never[],
      flags: MessageFlags.IsComponentsV2,
    });

    logger.debug({ messageId }, 'Dashboard refreshed');
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    logger.warn({ error: errorMsg, messageId }, 'Failed to refresh dashboard');
  }
}
