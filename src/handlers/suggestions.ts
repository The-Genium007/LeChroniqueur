import type { TextChannel } from 'discord.js';
import type { SqliteDatabase } from '../core/database.js';
import { getLogger } from '../core/logger.js';
import { generateSuggestions, type GeneratedSuggestion } from '../content/suggestions.js';
import { indexDocument } from '../search/engine.js';
import { checkThresholds, isApiAllowed } from '../budget/tracker.js';
import {
  suggestion as buildSuggestionV2,
  budgetAlert as buildBudgetAlert,
} from '../discord/component-builder-v2.js';
import { sendSplit } from '../discord/message-splitter.js';
import type { InstanceContext } from '../registry/instance-context.js';

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

async function runSuggestionsPipeline(
  db: SqliteDatabase,
  ideesChannel: TextChannel,
  logsChannel: TextChannel,
  alertChannel: TextChannel,
): Promise<void> {
  const logger = getLogger();

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

    indexDocument(db, {
      title: suggestion.hook,
      snippet: suggestion.script.slice(0, 200),
      content: suggestion.script,
      sourceTable: 'suggestions',
      sourceId: id,
    });

    if (suggestion.sourceArticleId !== undefined) {
      db.prepare('UPDATE veille_articles SET status = ? WHERE id = ? AND status = ?')
        .run('proposed', suggestion.sourceArticleId, 'new');
    }

    const payload = buildSuggestionV2({
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

    const messageIds = await sendSplit(ideesChannel, payload);
    const firstMsgId = messageIds[0];

    if (firstMsgId !== undefined) {
      db.prepare('UPDATE suggestions SET discord_message_id = ? WHERE id = ?')
        .run(firstMsgId, id);
    }
  }

  const alerts = checkThresholds(db);
  for (const alert of alerts) {
    const alertPayload = buildBudgetAlert(
      alert.period,
      alert.thresholdPercent,
      alert.costCents,
      alert.budgetCents,
    );
    const targetChannel = alert.period === 'monthly' ? alertChannel : logsChannel;
    await sendSplit(targetChannel, alertPayload);
  }

  logger.info({ count: suggestions.length }, 'Suggestions pipeline complete');
}

// ─── V2: InstanceContext entry point ───

export async function handleSuggestionsCronV2(ctx: InstanceContext): Promise<void> {
  await runSuggestionsPipeline(
    ctx.db,
    ctx.channels.idees,
    ctx.channels.logs,
    ctx.channels.logs,
  );
}

// ─── Legacy entry point ───

interface SuggestionsHandlerDeps {
  readonly db: SqliteDatabase;
  readonly ideesChannel: TextChannel;
  readonly logsChannel: TextChannel;
  readonly adminChannel: TextChannel;
}

export async function handleSuggestionsCron(deps: SuggestionsHandlerDeps): Promise<void> {
  await runSuggestionsPipeline(deps.db, deps.ideesChannel, deps.logsChannel, deps.adminChannel);
}
