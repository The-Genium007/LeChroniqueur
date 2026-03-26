import type { TextChannel, Message } from 'discord.js';
import { getLogger } from '../core/logger.js';
import {
  type V2MessagePayload,
  buildContainer, txt, sep, btn, row, v2, getColor,
  ButtonStyle,
} from '../discord/component-builder-v2.js';

const SEARCH_CLEANUP_TIMEOUT_MS = 12 * 60 * 60 * 1000; // 12 hours

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
  tempMessageIds: string[];
  timeoutHandle: ReturnType<typeof setTimeout> | null;
}

const sessions = new Map<string, SearchSession>(); // channelId → session

export function registerSearchChannel(
  channelId: string,
  permanentMessageId: string,
): void {
  sessions.set(channelId, {
    channelId,
    permanentMessageId,
    tempMessageIds: [],
    timeoutHandle: null,
  });
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

  for (const msgId of session.tempMessageIds) {
    try {
      // We need the channel to delete messages — this will be called from
      // the interaction handler which has access to the channel
      logger.debug({ msgId, channelId: session.channelId }, 'Search cleanup: message marked for deletion');
    } catch {
      // Message already deleted
    }
  }

  session.tempMessageIds = [];
  session.timeoutHandle = null;
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
 */
export async function cleanSearchChannelOnBoot(
  channel: TextChannel,
  permanentMessageId: string,
): Promise<void> {
  const logger = getLogger();

  try {
    const messages = await channel.messages.fetch({ limit: 50 });
    const toDelete = messages.filter((m: Message) => m.id !== permanentMessageId);

    if (toDelete.size > 0) {
      await channel.bulkDelete(toDelete);
      logger.info({ count: toDelete.size, channelId: channel.id }, 'Search channel cleaned on boot');
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.warn({ error: msg, channelId: channel.id }, 'Failed to clean search channel on boot');
  }
}
