import type { TextChannel, Message } from 'discord.js';
import { getLogger } from '../core/logger.js';
import {
  type V2MessagePayload,
  buildContainer, txt, sep, btn, row, v2, getColor,
  ButtonStyle,
} from '../discord/component-builder-v2.js';

const SEARCH_CLEANUP_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes

// ─── Search Interface (permanent message) ───

export function buildSearchInterface(instanceName: string): V2MessagePayload {
  return v2([buildContainer(getColor('info'), (c) => {
    c.addTextDisplayComponents(txt(`# 🔍 Recherche — ${instanceName}\nRecherche dans la veille, les suggestions et les publications.`));
    c.addSeparatorComponents(sep());
    c.addActionRowComponents(row(
      btn('search:open', 'Rechercher', ButtonStyle.Primary, '🔍'),
      btn('search:recent:articles', 'Articles récents', ButtonStyle.Secondary, '📰'),
      btn('search:recent:suggestions', 'Suggestions récentes', ButtonStyle.Secondary, '💡'),
      btn('search:recent:publications', 'Publications', ButtonStyle.Secondary, '📤'),
    ));
  })]);
}

// ─── Search Session (cleanup logic) ───

interface SearchSession {
  readonly channelId: string;
  readonly permanentMessageId: string;
  readonly channel: TextChannel;
  tempMessageIds: string[];
  timeoutHandle: ReturnType<typeof setTimeout> | null;
  lastQuery: string | null;
}

const sessions = new Map<string, SearchSession>(); // channelId → session

export function registerSearchChannel(
  channel: TextChannel,
  permanentMessageId: string,
): void {
  sessions.set(channel.id, {
    channelId: channel.id,
    permanentMessageId,
    channel,
    tempMessageIds: [],
    timeoutHandle: null,
    lastQuery: null,
  });
}

export function setLastQuery(channelId: string, query: string): void {
  const session = sessions.get(channelId);
  if (session !== undefined) {
    session.lastQuery = query;
  }
}

export function getLastQuery(channelId: string): string | null {
  return sessions.get(channelId)?.lastQuery ?? null;
}

export function trackTempMessage(channelId: string, messageId: string): void {
  const session = sessions.get(channelId);
  if (session === undefined) return;

  session.tempMessageIds.push(messageId);
  resetCleanupTimeout(session);
}

function resetCleanupTimeout(session: SearchSession): void {
  if (session.timeoutHandle !== null) {
    clearTimeout(session.timeoutHandle);
  }

  session.timeoutHandle = setTimeout(() => {
    void cleanupSession(session);
  }, SEARCH_CLEANUP_TIMEOUT_MS);
}

async function cleanupSession(session: SearchSession): Promise<void> {
  const logger = getLogger();

  const toDelete = [...session.tempMessageIds];
  session.tempMessageIds = [];
  session.timeoutHandle = null;

  for (const msgId of toDelete) {
    try {
      const msg = await session.channel.messages.fetch(msgId);
      await msg.delete();
    } catch {
      logger.debug({ msgId, channelId: session.channelId }, 'Search cleanup: message already deleted');
    }
  }
}

/**
 * Explicitly clear all temporary search results in a channel.
 */
export async function clearSearchResults(channel: TextChannel, channelId: string): Promise<void> {
  const logger = getLogger();
  const session = sessions.get(channelId);
  if (session === undefined) return;

  if (session.timeoutHandle !== null) {
    clearTimeout(session.timeoutHandle);
    session.timeoutHandle = null;
  }

  const toDelete = [...session.tempMessageIds];
  session.tempMessageIds = [];

  for (const msgId of toDelete) {
    try {
      const msg = await channel.messages.fetch(msgId);
      await msg.delete();
    } catch {
      logger.debug({ msgId }, 'Search cleanup: message already deleted');
    }
  }
}

/**
 * Clean search channel on boot — remove all messages except the permanent interface.
 * Paginates and handles messages older than 14 days individually.
 */
export async function cleanSearchChannelOnBoot(
  channel: TextChannel,
  permanentMessageId: string,
): Promise<void> {
  const logger = getLogger();

  try {
    const botId = channel.client.user?.id;
    let deleted = 0;
    let lastId: string | undefined;

    for (let page = 0; page < 5; page++) {
      const options: { limit: number; before?: string } = { limit: 100 };
      if (lastId !== undefined) options.before = lastId;

      const messages = await channel.messages.fetch(options);
      if (messages.size === 0) break;

      const toDelete = messages.filter(
        (m: Message) => m.id !== permanentMessageId && (botId === undefined || m.author.id === botId),
      );

      const fourteenDaysAgo = Date.now() - 14 * 24 * 60 * 60 * 1000;
      const recent = toDelete.filter((m: Message) => m.createdTimestamp > fourteenDaysAgo);
      const old = toDelete.filter((m: Message) => m.createdTimestamp <= fourteenDaysAgo);

      if (recent.size > 1) {
        try {
          await channel.bulkDelete(recent);
          deleted += recent.size;
        } catch {
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
      logger.info({ count: deleted, channelId: channel.id }, 'Search channel cleaned on boot');
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.warn({ error: msg, channelId: channel.id }, 'Failed to clean search channel on boot');
  }
}
