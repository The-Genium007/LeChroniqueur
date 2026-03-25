import type { Message, TextChannel } from 'discord.js';
import type { SqliteDatabase } from '../core/database.js';
import { getConfig } from '../core/config.js';
import { getLogger } from '../core/logger.js';
import { modifySuggestion } from '../content/suggestions.js';
import { suggestion as buildSuggestionEmbed, infoMessage } from '../discord/message-builder.js';

interface PendingModification {
  readonly suggestionId: number;
  readonly originalContent: string;
  readonly timestamp: number;
}

// In-memory store for pending modifications — keyed by user ID
const pendingModifications = new Map<string, PendingModification>();

const MODIFICATION_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

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

interface ConversationHandlerDeps {
  readonly db: SqliteDatabase;
  readonly ideesChannel: TextChannel;
}

export async function handleAdminMessage(
  message: Message,
  deps: ConversationHandlerDeps,
): Promise<void> {
  const config = getConfig();
  const logger = getLogger();
  const { db, ideesChannel } = deps;

  // Only respond to the owner
  if (message.author.id !== config.DISCORD_OWNER_ID) {
    return;
  }

  // Ignore bot messages
  if (message.author.bot) {
    return;
  }

  const content = message.content.trim();

  if (content.length === 0) {
    return;
  }

  // Check for pending modification
  const pending = pendingModifications.get(message.author.id);

  if (pending !== undefined) {
    // Check timeout
    if (Date.now() - pending.timestamp > MODIFICATION_TIMEOUT_MS) {
      pendingModifications.delete(message.author.id);
      const payload = infoMessage('⏰ La modification a expiré (5 minutes). Reclique sur ✏️ Modifier pour recommencer.');
      await message.reply({ embeds: payload.embeds });
      return;
    }

    logger.info({ suggestionId: pending.suggestionId }, 'Processing modification');

    await message.react('⏳');

    try {
      const modified = await modifySuggestion(db, pending.originalContent, content);

      // Update in database
      db.prepare('UPDATE suggestions SET content = ?, modification_notes = ?, status = ? WHERE id = ?')
        .run(modified, content, 'pending', pending.suggestionId);

      // Get suggestion metadata for rebuild
      const row = db.prepare('SELECT pillar, platform, format FROM suggestions WHERE id = ?')
        .get(pending.suggestionId) as { pillar: string; platform: string; format: string | null } | undefined;

      if (row !== undefined) {
        // Post updated suggestion in #idées
        const payload = buildSuggestionEmbed({
          id: pending.suggestionId,
          content: modified,
          pillar: row.pillar,
          platform: row.platform,
          format: row.format ?? undefined,
        });

        const newMsg = await ideesChannel.send({
          embeds: payload.embeds,
          components: payload.components,
        });

        db.prepare('UPDATE suggestions SET discord_message_id = ? WHERE id = ?')
          .run(newMsg.id, pending.suggestionId);
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

    return;
  }

  // No pending modification — this is a general admin message
  // For now, acknowledge but don't process (Phase 2 scope: only modification flow)
  // Future: natural language commands, config changes, etc.
}
