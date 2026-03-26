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
import type { InstanceContext } from '../registry/instance-context.js';
import type { TextChannel } from 'discord.js';

// ─── Legacy interface (kept for backward compat during transition) ───

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

async function runVeillePipeline(
  db: SqliteDatabase,
  veilleChannel: TextChannel,
  logsChannel: TextChannel,
  adminChannel: TextChannel,
): Promise<void> {
  const logger = getLogger();

  logger.info('Starting veille pipeline');

  if (!isApiAllowed(db)) {
    logger.warn('API budget exhausted, skipping veille analysis');
    return;
  }

  recalculate(db);
  const preferences = getProfile(db).map((p) => ({
    dimension: p.dimension,
    value: p.value,
    score: p.score,
    totalCount: p.totalCount,
  }));

  const { articles: rawArticles, stats } = await collect(db);

  if (rawArticles.length === 0) {
    logger.info('No new articles found');
    return;
  }

  recordSearxngQuery(db, stats.totalFetched);

  const { articles: analyzed, tokensUsed } = await analyze(rawArticles, preferences);

  recordAnthropicUsage(db, tokensUsed.input, tokensUsed.output);

  const savedArticles: Array<{ article: AnalyzedArticle; id: number }> = [];

  for (const article of analyzed) {
    const id = saveArticle(db, article);
    savedArticles.push({ article, id });

    indexDocument(db, {
      title: article.translatedTitle ?? article.title,
      snippet: article.translatedSnippet ?? article.snippet,
      content: article.suggestedAngle,
      sourceTable: 'veille_articles',
      sourceId: id,
    });
  }

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

  const digestPayload = veilleDigest(topArticles, stats);
  const digestMessage = await veilleChannel.send({
    embeds: digestPayload.embeds,
    components: digestPayload.components,
  });

  const threadArticles = sortedArticles.filter((a) => a.article.score >= 5);

  if (threadArticles.length > 0) {
    const thread = await digestMessage.startThread({
      name: `Détails veille — ${new Date().toLocaleDateString('fr-FR')}`,
      autoArchiveDuration: 1440,
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

      db.prepare('UPDATE veille_articles SET discord_message_id = ?, discord_thread_id = ? WHERE id = ?')
        .run(articleMsg.id, thread.id, id);
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

// ─── V2: InstanceContext entry point ───

export async function handleVeilleCronV2(ctx: InstanceContext): Promise<void> {
  await runVeillePipeline(
    ctx.db,
    ctx.channels.veille,
    ctx.channels.logs,
    ctx.channels.logs, // V2 has no separate admin channel — logs doubles
  );
}

// ─── Legacy entry point (backward compat) ───

export async function handleVeilleCron(deps: VeilleHandlerDeps): Promise<void> {
  await runVeillePipeline(deps.db, deps.veilleChannel, deps.logsChannel, deps.adminChannel);
}
