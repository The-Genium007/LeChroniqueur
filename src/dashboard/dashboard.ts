import type { TextChannel, Message } from 'discord.js';
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

/**
 * Clean dashboard channel on boot — remove all messages except the permanent dashboard.
 * Prevents stale status messages ("✅ Veille lancée", "🔄 Dashboard rafraîchi", etc.)
 * from accumulating across bot restarts.
 *
 * Uses bulkDelete for recent messages (<14 days) and individual delete for older ones.
 * Paginates through ALL messages in the channel, not just the first 50.
 */
export async function cleanDashboardChannelOnBoot(
  channel: TextChannel,
  permanentMessageId: string,
): Promise<void> {
  const logger = getLogger();

  try {
    const botId = channel.client.user?.id;
    let deleted = 0;
    let lastId: string | undefined;

    // Paginate through channel messages (100 at a time)
    for (let page = 0; page < 5; page++) {
      const options: { limit: number; before?: string } = { limit: 100 };
      if (lastId !== undefined) options.before = lastId;

      const messages = await channel.messages.fetch(options);
      if (messages.size === 0) break;

      const toDelete = messages.filter(
        (m: Message) => m.id !== permanentMessageId && (botId === undefined || m.author.id === botId),
      );

      // Split into bulk-deletable (<14 days) and old messages
      const fourteenDaysAgo = Date.now() - 14 * 24 * 60 * 60 * 1000;
      const recent = toDelete.filter((m: Message) => m.createdTimestamp > fourteenDaysAgo);
      const old = toDelete.filter((m: Message) => m.createdTimestamp <= fourteenDaysAgo);

      if (recent.size > 1) {
        try {
          await channel.bulkDelete(recent);
          deleted += recent.size;
        } catch {
          // Fallback to individual delete
          for (const [, m] of recent) {
            try { await m.delete(); deleted++; } catch { /* already deleted */ }
          }
        }
      } else if (recent.size === 1) {
        const single = recent.first();
        if (single !== undefined) {
          try { await single.delete(); deleted++; } catch { /* already deleted */ }
        }
      }

      for (const [, m] of old) {
        try { await m.delete(); deleted++; } catch { /* already deleted */ }
      }

      lastId = messages.last()?.id;
      if (messages.size < 100) break;
    }

    if (deleted > 0) {
      logger.info({ count: deleted, channelId: channel.id }, 'Dashboard channel cleaned on boot');
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.warn({ error: msg, channelId: channel.id }, 'Failed to clean dashboard channel on boot');
  }
}
