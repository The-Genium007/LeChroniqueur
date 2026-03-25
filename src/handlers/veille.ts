import type { TextChannel } from 'discord.js';
import type { SqliteDatabase } from '../core/database.js';
import { getLogger } from '../core/logger.js';
import { collect } from '../veille/collector.js';
import { analyze, type AnalyzedArticle } from '../veille/analyzer.js';
import { recalculate, getProfile } from '../feedback/preference-learner.js';
import { indexDocument } from '../search/engine.js';
import { recordAnthropicUsage, recordSearxngQuery, checkThresholds, isApiAllowed } from '../budget/tracker.js';
import {
  veilleDigest,
  veilleArticle,
  budgetAlert as buildBudgetAlert,
  type VeilleArticleSummary,
} from '../discord/message-builder.js';

interface VeilleHandlerDeps {
  readonly db: SqliteDatabase;
  readonly veilleChannel: TextChannel;
  readonly logsChannel: TextChannel;
  readonly adminChannel: TextChannel;
}

function saveArticle(db: SqliteDatabase, article: AnalyzedArticle): number {
  const result = db.prepare(`
    INSERT INTO veille_articles (
      url, title, snippet, source, language, category,
      score, pillar, suggested_angle, translated_title,
      translated_snippet, thumbnail_url, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new')
  `).run(
    article.url,
    article.title,
    article.snippet,
    article.source,
    article.language,
    article.category,
    article.score,
    article.pillar,
    article.suggestedAngle,
    article.translatedTitle ?? null,
    article.translatedSnippet ?? null,
    article.thumbnailUrl ?? null,
  );

  return Number(result.lastInsertRowid);
}

export async function handleVeilleCron(deps: VeilleHandlerDeps): Promise<void> {
  const logger = getLogger();
  const { db, veilleChannel, logsChannel, adminChannel } = deps;

  logger.info('Starting veille pipeline');

  // 1. Check budget
  if (!isApiAllowed(db)) {
    logger.warn('API budget exhausted, skipping veille analysis');
    return;
  }

  // 2. Recalculate preferences
  recalculate(db);
  const preferences = getProfile(db).map((p) => ({
    dimension: p.dimension,
    value: p.value,
    score: p.score,
    totalCount: p.totalCount,
  }));

  // 3. Collect articles via SearXNG
  const { articles: rawArticles, stats } = await collect(db);

  if (rawArticles.length === 0) {
    logger.info('No new articles found');
    return;
  }

  // Track SearXNG usage
  recordSearxngQuery(db, stats.totalFetched);

  // 4. Analyze with Claude
  const { articles: analyzed, tokensUsed } = await analyze(rawArticles, preferences);

  // Track Anthropic usage
  recordAnthropicUsage(db, tokensUsed.input, tokensUsed.output);

  // 5. Save articles to database and index for search
  const savedArticles: Array<{ article: AnalyzedArticle; id: number }> = [];

  for (const article of analyzed) {
    const id = saveArticle(db, article);
    savedArticles.push({ article, id });

    // Index for FTS5 search
    indexDocument(db, {
      title: article.translatedTitle ?? article.title,
      snippet: article.translatedSnippet ?? article.snippet,
      content: article.suggestedAngle,
      sourceTable: 'veille_articles',
      sourceId: id,
    });
  }

  // 6. Sort by score and build summaries
  const sortedArticles = savedArticles
    .sort((a, b) => b.article.score - a.article.score);

  const topArticles: VeilleArticleSummary[] = sortedArticles
    .filter((a) => a.article.score >= 8)
    .map((a) => ({
      id: a.id,
      title: a.article.title,
      translatedTitle: a.article.translatedTitle,
      suggestedAngle: a.article.suggestedAngle,
      source: a.article.source,
      url: a.article.url,
      score: a.article.score,
      publishedDate: a.article.publishedDate,
    }));

  // 7. Send digest to #veille
  const digestPayload = veilleDigest(topArticles, stats);
  const digestMessage = await veilleChannel.send({
    embeds: digestPayload.embeds,
    components: digestPayload.components,
  });

  // 8. Create thread with individual articles (score >= 5)
  const threadArticles = sortedArticles.filter((a) => a.article.score >= 5);

  if (threadArticles.length > 0) {
    const thread = await digestMessage.startThread({
      name: `Détails veille — ${new Date().toLocaleDateString('fr-FR')}`,
      autoArchiveDuration: 1440, // 24h
    });

    for (const { article, id } of threadArticles) {
      const articlePayload = veilleArticle({
        id,
        title: article.title,
        translatedTitle: article.translatedTitle,
        suggestedAngle: article.suggestedAngle,
        source: article.source,
        url: article.url,
        score: article.score,
        publishedDate: article.publishedDate,
      });

      const articleMsg = await thread.send({
        embeds: articlePayload.embeds,
        components: articlePayload.components,
      });

      // Update database with Discord message ID
      db.prepare('UPDATE veille_articles SET discord_message_id = ?, discord_thread_id = ? WHERE id = ?')
        .run(articleMsg.id, thread.id, id);
    }
  }

  // 9. Check budget thresholds
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

  logger.info(
    {
      collected: stats.kept,
      analyzed: analyzed.length,
      top: topArticles.length,
      tokensIn: tokensUsed.input,
      tokensOut: tokensUsed.output,
    },
    'Veille pipeline complete',
  );
}
