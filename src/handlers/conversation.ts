import type { Message, TextChannel } from 'discord.js';
import type { SqliteDatabase } from '../core/database.js';
import { getLogger } from '../core/logger.js';
import { modifySuggestion } from '../content/suggestions.js';
import { suggestion as buildSuggestionV2, infoMessage } from '../discord/component-builder-v2.js';
import { sendSplit } from '../discord/message-splitter.js';
import type { InstanceContext } from '../registry/instance-context.js';

interface PendingModification {
  readonly suggestionId: number;
  readonly originalContent: string;
  readonly timestamp: number;
}

const pendingModifications = new Map<string, PendingModification>();

const MODIFICATION_TIMEOUT_MS = 5 * 60 * 1000;

export function setPendingModification(
  userId: string,
  suggestionId: number,
  originalContent: string,
): void {
  pendingModifications.set(userId, {
    suggestionId,
    originalContent,
    timestamp: Date.now(),
  });
}

export function clearPendingModification(userId: string): void {
  pendingModifications.delete(userId);
}

async function handleModificationMessage(
  message: Message,
  db: SqliteDatabase,
  ideesChannel: TextChannel,
  ownerId: string,
): Promise<void> {
  const logger = getLogger();

  if (message.author.id !== ownerId) return;
  if (message.author.bot) return;

  const content = message.content.trim();
  if (content.length === 0) return;

  const pending = pendingModifications.get(message.author.id);

  if (pending === undefined) return;

  if (Date.now() - pending.timestamp > MODIFICATION_TIMEOUT_MS) {
    pendingModifications.delete(message.author.id);
    const payload = infoMessage('⏰ La modification a expiré (5 minutes). Reclique sur ✏️ Modifier pour recommencer.');
    await message.reply({ components: payload.components as never[], flags: payload.flags } as never);
    return;
  }

  logger.info({ suggestionId: pending.suggestionId }, 'Processing modification');

  await message.react('⏳');

  try {
    const modified = await modifySuggestion(db, pending.originalContent, content);

    db.prepare('UPDATE suggestions SET content = ?, modification_notes = ?, status = ? WHERE id = ?')
      .run(modified, content, 'pending', pending.suggestionId);

    const row = db.prepare('SELECT pillar, platform, format FROM suggestions WHERE id = ?')
      .get(pending.suggestionId) as { pillar: string; platform: string; format: string | null } | undefined;

    if (row !== undefined) {
      const payload = buildSuggestionV2({
        id: pending.suggestionId,
        content: modified,
        pillar: row.pillar,
        platform: row.platform,
        format: row.format ?? undefined,
      });

      const msgIds = await sendSplit(ideesChannel, payload);
      const firstMsgId = msgIds[0];

      if (firstMsgId !== undefined) {
        db.prepare('UPDATE suggestions SET discord_message_id = ? WHERE id = ?')
          .run(firstMsgId, pending.suggestionId);
      }
    }

    await message.react('✅');
    pendingModifications.delete(message.author.id);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    logger.error({ error: errorMsg }, 'Modification failed');
    await message.react('❌');
    await message.reply(`Erreur lors de la modification : ${errorMsg}`);
    pendingModifications.delete(message.author.id);
  }
}

// ─── V2: InstanceContext entry point ───

export async function handleAdminMessageV2(
  message: Message,
  ctx: InstanceContext,
): Promise<void> {
  await handleModificationMessage(message, ctx.db, ctx.channels.idees, ctx.ownerId);
}

// ─── Legacy entry point ───

interface ConversationHandlerDeps {
  readonly db: SqliteDatabase;
  readonly ideesChannel: TextChannel;
}

export async function handleAdminMessage(
  message: Message,
  deps: ConversationHandlerDeps,
): Promise<void> {
  const { getConfig } = await import('../core/config.js');
  const config = getConfig();
  await handleModificationMessage(message, deps.db, deps.ideesChannel, config.DISCORD_OWNER_ID);
}
