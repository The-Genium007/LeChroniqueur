import type { TextChannel } from 'discord.js';
import type { SqliteDatabase } from '../core/database.js';
import { getLogger } from '../core/logger.js';
import { generateSuggestions, type GeneratedSuggestion } from '../content/suggestions.js';
import { indexDocument } from '../search/engine.js';
import { checkThresholds, isApiAllowed } from '../budget/tracker.js';
import {
  suggestion as buildSuggestionEmbed,
  budgetAlert as buildBudgetAlert,
} from '../discord/message-builder.js';

interface SuggestionsHandlerDeps {
  readonly db: SqliteDatabase;
  readonly ideesChannel: TextChannel;
  readonly logsChannel: TextChannel;
  readonly adminChannel: TextChannel;
}

function saveSuggestion(
  db: SqliteDatabase,
  suggestion: GeneratedSuggestion,
): number {
  const content = [
    `**Hook :** ${suggestion.hook}`,
    '',
    `**Script :**`,
    suggestion.script,
    '',
    `**Hashtags :** ${suggestion.hashtags.join(' ')}`,
    `**Heure suggérée :** ${suggestion.suggestedTime}`,
  ].join('\n');

  const result = db.prepare(`
    INSERT INTO suggestions (veille_article_id, content, pillar, platform, format, status)
    VALUES (?, ?, ?, ?, ?, 'pending')
  `).run(
    suggestion.sourceArticleId ?? null,
    content,
    suggestion.pillar,
    suggestion.platform,
    suggestion.format,
  );

  return Number(result.lastInsertRowid);
}

export async function handleSuggestionsCron(deps: SuggestionsHandlerDeps): Promise<void> {
  const logger = getLogger();
  const { db, ideesChannel, logsChannel, adminChannel } = deps;

  logger.info('Starting suggestions pipeline');

  if (!isApiAllowed(db)) {
    logger.warn('API budget exhausted, skipping suggestions');
    return;
  }

  const suggestions = await generateSuggestions(db, 3);

  if (suggestions.length === 0) {
    logger.info('No suggestions generated');
    return;
  }

  for (const suggestion of suggestions) {
    const id = saveSuggestion(db, suggestion);

    // Index for search
    indexDocument(db, {
      title: suggestion.hook,
      snippet: suggestion.script.slice(0, 200),
      content: suggestion.script,
      sourceTable: 'suggestions',
      sourceId: id,
    });

    // Mark source article as proposed if applicable
    if (suggestion.sourceArticleId !== undefined) {
      db.prepare('UPDATE veille_articles SET status = ? WHERE id = ? AND status = ?')
        .run('proposed', suggestion.sourceArticleId, 'new');
    }

    // Build and send Discord embed
    const payload = buildSuggestionEmbed({
      id,
      content: [
        `**Hook :** ${suggestion.hook}`,
        '',
        suggestion.script,
        '',
        `🏷️ ${suggestion.hashtags.join(' ')}`,
        `⏰ ${suggestion.suggestedTime}`,
      ].join('\n'),
      pillar: suggestion.pillar,
      platform: suggestion.platform,
      format: suggestion.format,
    });

    const message = await ideesChannel.send({
      embeds: payload.embeds,
      components: payload.components,
    });

    // Store Discord message ID
    db.prepare('UPDATE suggestions SET discord_message_id = ? WHERE id = ?')
      .run(message.id, id);
  }

  // Check budget thresholds
  const alerts = checkThresholds(db);
  for (const alert of alerts) {
    const alertPayload = buildBudgetAlert(
      alert.period,
      alert.thresholdPercent,
      alert.costCents,
      alert.budgetCents,
    );
    const targetChannel = alert.period === 'monthly' ? adminChannel : logsChannel;
    await targetChannel.send({
      embeds: alertPayload.embeds,
      components: alertPayload.components,
    });
  }

  logger.info({ count: suggestions.length }, 'Suggestions pipeline complete');
}
