import type { SqliteDatabase } from '../core/database.js';
import { getLogger } from '../core/logger.js';
import { collectFromAllSources } from '../veille/sources/index.js';
import { getCategoriesFromDb } from '../veille/queries.js';
import { analyze, type AnalyzedArticle } from '../veille/analyzer.js';
import { recalculate, getProfile as getPreferenceProfile } from '../feedback/preference-learner.js';
import { indexDocument } from '../search/engine.js';
import { recordAnthropicUsage, recordSearxngQuery, checkThresholds, isApiAllowed } from '../budget/tracker.js';
import { personaLoader } from '../core/persona-loader.js';
import type { InstanceProfile } from '../core/instance-profile.js';
import { prefilter } from '../veille/prefilter.js';
import {
  veilleDigest,
  veilleArticle,
  budgetAlert as buildBudgetAlert,
} from '../discord/component-builder-v2.js';
import { sendSplit } from '../discord/message-splitter.js';
import type { InstanceContext } from '../registry/instance-context.js';
import type { TextChannel } from 'discord.js';

function deriveSourceType(source: string): string {
  if (source.startsWith('reddit/')) return 'reddit';
  if (source.startsWith('youtube/') || source === 'youtube') return 'youtube';
  if (source === 'rss' || source === 'rss_feed') return 'rss';
  if (source === 'web_search') return 'web_search';
  return 'searxng';
}

function saveArticle(db: SqliteDatabase, article: AnalyzedArticle): number {
  const result = db.prepare(`
    INSERT INTO veille_articles (
      url, title, snippet, source, language, category,
      score, pillar, suggested_angle, translated_title,
      translated_snippet, thumbnail_url, status, source_type
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?)
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
    deriveSourceType(article.source),
  );

  return Number(result.lastInsertRowid);
}

async function runVeillePipeline(
  db: SqliteDatabase,
  veilleChannel: TextChannel,
  logsChannel: TextChannel,
  adminChannel: TextChannel,
  instanceId: string,
  profile: InstanceProfile,
): Promise<void> {
  const logger = getLogger();

  logger.info({ instanceId }, 'Starting veille pipeline');

  if (!isApiAllowed(db)) {
    logger.warn('API budget exhausted, skipping veille analysis');
    return;
  }

  // Load score thresholds from config_overrides (or defaults)
  const configRow = db.prepare("SELECT value FROM config_overrides WHERE key = 'minScoreDigest'").get() as { value: string } | undefined;
  const minScoreDigest = configRow !== undefined ? Number(configRow.value) : 7;
  const threadRow = db.prepare("SELECT value FROM config_overrides WHERE key = 'minScoreThread'").get() as { value: string } | undefined;
  const minScoreThread = threadRow !== undefined ? Number(threadRow.value) : 5;

  recalculate(db);
  const preferences = getPreferenceProfile(db).map((p) => ({
    dimension: p.dimension,
    value: p.value,
    score: p.score,
    totalCount: p.totalCount,
  }));

  // Load categories from DB (no hardcoded fallback)
  const categories = getCategoriesFromDb(db);

  if (categories.length === 0) {
    logger.warn({ instanceId }, 'No categories configured, skipping veille');
    return;
  }

  // Collect from all enabled sources
  const result = await collectFromAllSources(db, categories);
  const rawArticles = [...result.articles];
  const totalFetched = result.totalFetched;

  if (rawArticles.length === 0) {
    logger.info('No new articles found');
    return;
  }

  recordSearxngQuery(db, totalFetched);

  // Pre-filter: URL patterns, content quality, near-dedup, DB dedup
  const filterResult = prefilter(rawArticles, profile, db);
  const filtered = [...filterResult.passed];

  logger.info({
    before: rawArticles.length,
    after: filtered.length,
    stats: filterResult.stats,
  }, 'Pre-filtered articles');

  if (filtered.length === 0) {
    logger.info('No articles passed pre-filtering');
    return;
  }

  // Load persona for dynamic scoring prompt
  const persona = personaLoader.loadForInstance(instanceId, db);

  // Batch analysis: process in chunks of 20 articles max
  const BATCH_SIZE = 20;
  const allAnalyzed: AnalyzedArticle[] = [];
  let totalTokensIn = 0;
  let totalTokensOut = 0;

  let consecutiveRateLimits = 0;

  for (let i = 0; i < filtered.length; i += BATCH_SIZE) {
    // If we hit 3 consecutive rate-limited batches, stop — the quota is exhausted
    if (consecutiveRateLimits >= 3) {
      logger.warn({ remainingBatches: Math.ceil((filtered.length - i) / BATCH_SIZE) }, 'Stopping analysis — API rate limit persists after 3 consecutive failures');
      break;
    }

    const batch = filtered.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(filtered.length / BATCH_SIZE);
    logger.info({ batch: batchNum, total: totalBatches, articles: batch.length }, 'Analyzing batch');

    // Retry with exponential backoff for rate limits (429)
    let success = false;
    for (let attempt = 0; attempt < 3 && !success; attempt++) {
      try {
        const { articles: batchAnalyzed, tokensUsed } = await analyze(batch, preferences, persona, profile);
        allAnalyzed.push(...batchAnalyzed);
        totalTokensIn += tokensUsed.input;
        totalTokensOut += tokensUsed.output;
        logger.info({ batch: batchNum, analyzed: batchAnalyzed.length, tokensIn: tokensUsed.input, tokensOut: tokensUsed.output }, 'Batch analysis complete');
        success = true;
        consecutiveRateLimits = 0;
      } catch (batchError) {
        const msg = batchError instanceof Error ? batchError.message : String(batchError);
        const isRateLimit = msg.includes('429') || msg.includes('rate_limit');
        if (isRateLimit && attempt < 2) {
          const waitMs = (attempt + 1) * 60_000; // 60s, 120s
          logger.warn({ batch: batchNum, attempt: attempt + 1, waitMs }, 'Rate limited, waiting before retry');
          await new Promise<void>((resolve) => { setTimeout(resolve, waitMs); });
        } else {
          logger.error({ batch: batchNum, error: msg }, 'Batch analysis failed, skipping batch');
          if (isRateLimit) consecutiveRateLimits++;
        }
      }
    }
  }

  recordAnthropicUsage(db, totalTokensIn, totalTokensOut);

  const analyzed = allAnalyzed;

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

  const topArticles = sortedArticles
    .filter((a) => a.article.score >= minScoreDigest)
    .map((a) => ({
      id: a.id,
      title: a.article.title,
      translatedTitle: a.article.translatedTitle,
      suggestedAngle: a.article.suggestedAngle,
      source: a.article.source,
      url: a.article.url,
      score: a.article.score,
    }));

  logger.info({ topCount: topArticles.length, totalAnalyzed: sortedArticles.length }, 'Sending veille digest');

  const digestPayload = veilleDigest(topArticles, { totalFetched, deduplicated: rawArticles.length - filtered.length, kept: filtered.length });
  let digestMessageIds: string[];
  try {
    digestMessageIds = await sendSplit(veilleChannel, digestPayload);
  } catch (sendError) {
    const msg = sendError instanceof Error ? sendError.message : String(sendError);
    logger.error({ error: msg }, 'Failed to send veille digest');
    return;
  }

  const firstDigestId = digestMessageIds[0];
  const threadArticles = sortedArticles.filter((a) => a.article.score >= minScoreThread);
  logger.info({ threadArticleCount: threadArticles.length }, 'Creating veille thread');

  if (threadArticles.length > 0 && firstDigestId !== undefined) {
    const digestMessage = await veilleChannel.messages.fetch(firstDigestId);
    const thread = await digestMessage.startThread({
      name: `Détails veille — ${new Date().toLocaleDateString('fr-FR')}`,
      autoArchiveDuration: 1440,
    });

    for (const { article, id } of threadArticles) {
      try {
        const articlePayload = veilleArticle({
          id,
          title: article.title,
          translatedTitle: article.translatedTitle,
          suggestedAngle: article.suggestedAngle,
          source: article.source,
          url: article.url,
          score: article.score,
        });

        const articleMsgIds = await sendSplit(thread, articlePayload);
        const firstArticleMsgId = articleMsgIds[0];

        if (firstArticleMsgId !== undefined) {
          db.prepare('UPDATE veille_articles SET discord_message_id = ?, discord_thread_id = ? WHERE id = ?')
            .run(firstArticleMsgId, thread.id, id);
        }
      } catch (articleError) {
        const msg = articleError instanceof Error ? articleError.message : String(articleError);
        logger.warn({ error: msg, articleId: id }, 'Failed to send article to thread, skipping');
      }
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
    await sendSplit(targetChannel, alertPayload);
  }

  logger.info(
    {
      collected: filtered.length,
      analyzed: analyzed.length,
      top: topArticles.length,
      tokensIn: totalTokensIn,
      tokensOut: totalTokensOut,
    },
    'Veille pipeline complete',
  );
}

export async function handleVeilleCron(ctx: InstanceContext): Promise<void> {
  await runVeillePipeline(
    ctx.db,
    ctx.channels.veille,
    ctx.channels.logs,
    ctx.channels.logs,
    ctx.id,
    ctx.profile,
  );
}
