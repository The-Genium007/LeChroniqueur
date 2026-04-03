import type { SqliteDatabase } from '../core/database.js';
import { getLogger } from '../core/logger.js';

// ─── Types ───

export interface ResurfaceCandidate {
  readonly id: number;
  readonly url: string;
  readonly title: string;
  readonly translatedTitle: string | null;
  readonly snippet: string;
  readonly score: number;
  readonly pillar: string | null;
  readonly suggestedAngle: string | null;
  readonly category: string;
  readonly status: string;
  readonly collectedAt: string;
  readonly publishedAt: string | null;
  readonly skipCount: number;
  readonly resurfacedCount: number;
  readonly type: 'skipped' | 'published_old' | 'scored_old';
}

interface ArticleRow {
  id: number;
  url: string;
  title: string;
  translated_title: string | null;
  snippet: string;
  score: number;
  pillar: string | null;
  suggested_angle: string | null;
  category: string;
  status: string;
  collected_at: string;
  published_at: string | null;
  skip_count: number;
  resurfaced_count: number;
}

// ─── Resurfacing queries ───

/**
 * Gets articles that were skipped 1-2 times (not 3+), collected at least 14 days ago.
 * These are "maybe later" articles that deserve another chance.
 */
function getSkippedCandidates(db: SqliteDatabase, limit: number): readonly ResurfaceCandidate[] {
  const rows = db.prepare(`
    SELECT * FROM veille_articles
    WHERE status = 'skipped' AND skip_count < 3
    AND collected_at < datetime('now', '-14 days')
    ORDER BY score DESC
    LIMIT ?
  `).all(limit) as ArticleRow[];

  return rows.map((row) => mapToCandidate(row, 'skipped'));
}

/**
 * Gets articles that were published more than 30 days ago with high scores.
 * These can be recycled with a new angle.
 */
function getPublishedOldCandidates(db: SqliteDatabase, limit: number): readonly ResurfaceCandidate[] {
  const rows = db.prepare(`
    SELECT * FROM veille_articles
    WHERE status IN ('published', 'transformed')
    AND published_at < datetime('now', '-30 days')
    AND score >= 7
    ORDER BY score DESC
    LIMIT ?
  `).all(limit) as ArticleRow[];

  return rows.map((row) => mapToCandidate(row, 'published_old'));
}

/**
 * Gets old articles that were well-scored but never proposed.
 */
function getScoredOldCandidates(db: SqliteDatabase, limit: number): readonly ResurfaceCandidate[] {
  const rows = db.prepare(`
    SELECT * FROM veille_articles
    WHERE status IN ('new', 'scored') AND score >= 7
    AND collected_at < datetime('now', '-7 days')
    ORDER BY score DESC
    LIMIT ?
  `).all(limit) as ArticleRow[];

  return rows.map((row) => mapToCandidate(row, 'scored_old'));
}

function mapToCandidate(row: ArticleRow, type: ResurfaceCandidate['type']): ResurfaceCandidate {
  return {
    id: row.id,
    url: row.url,
    title: row.title,
    translatedTitle: row.translated_title,
    snippet: row.snippet,
    score: row.score,
    pillar: row.pillar,
    suggestedAngle: row.suggested_angle,
    category: row.category,
    status: row.status,
    collectedAt: row.collected_at,
    publishedAt: row.published_at,
    skipCount: row.skip_count,
    resurfacedCount: row.resurfaced_count,
    type,
  };
}

// ─── Public API ───

/**
 * Gets all resurfacing candidates from the database.
 * Returns a mix of skipped, published old, and scored old articles.
 */
export function getResurfaceCandidates(
  db: SqliteDatabase,
  maxCandidates: number = 15,
): readonly ResurfaceCandidate[] {
  const logger = getLogger();

  const perCategory = Math.ceil(maxCandidates / 3);

  const skipped = getSkippedCandidates(db, perCategory);
  const publishedOld = getPublishedOldCandidates(db, perCategory);
  const scoredOld = getScoredOldCandidates(db, perCategory);

  // Merge and deduplicate by article ID
  const seenIds = new Set<number>();
  const candidates: ResurfaceCandidate[] = [];

  for (const list of [skipped, publishedOld, scoredOld]) {
    for (const candidate of list) {
      if (!seenIds.has(candidate.id)) {
        seenIds.add(candidate.id);
        candidates.push(candidate);
      }
    }
  }

  // Sort by score descending, limit to maxCandidates
  candidates.sort((a, b) => b.score - a.score);
  const result = candidates.slice(0, maxCandidates);

  logger.info(
    {
      skipped: skipped.length,
      publishedOld: publishedOld.length,
      scoredOld: scoredOld.length,
      total: result.length,
    },
    'Resurface candidates collected',
  );

  return result;
}

/**
 * Marks an article as resurfaced (increments counter and updates timestamp).
 */
export function markAsResurfaced(db: SqliteDatabase, articleId: number): void {
  db.prepare(`
    UPDATE veille_articles
    SET resurfaced_count = resurfaced_count + 1,
        last_resurfaced_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(articleId);
}

/**
 * Marks an article as hors-contexte (blacklisted, never reproposed).
 */
export function markAsHorsContexte(db: SqliteDatabase, articleId: number): void {
  db.prepare(`
    UPDATE veille_articles
    SET status = 'hors_contexte'
    WHERE id = ?
  `).run(articleId);
}

/**
 * Increments the skip count for an article.
 */
export function incrementSkipCount(db: SqliteDatabase, articleId: number): void {
  db.prepare(`
    UPDATE veille_articles
    SET skip_count = skip_count + 1, status = 'skipped'
    WHERE id = ?
  `).run(articleId);
}

/**
 * Formats resurface candidates for the LLM suggestion prompt.
 * The LLM decides the optimal ratio of fresh vs resurfaced.
 */
export function formatCandidatesForPrompt(candidates: readonly ResurfaceCandidate[]): string {
  if (candidates.length === 0) {
    return 'Aucun contenu ancien à resurfacer.';
  }

  const lines: string[] = [
    `${String(candidates.length)} contenus anciens candidats au resurfacing :`,
    '',
  ];

  for (const c of candidates) {
    const title = c.translatedTitle ?? c.title;
    const typeLabel = c.type === 'skipped' ? '⏭️ Skippé'
      : c.type === 'published_old' ? '♻️ Publié'
      : '🔄 Non proposé';

    lines.push(`[${typeLabel}] "${title}" (score: ${String(c.score)}, collecté: ${c.collectedAt.split('T')[0] ?? c.collectedAt})`);
    if (c.suggestedAngle !== null) {
      lines.push(`  Angle initial : ${c.suggestedAngle}`);
    }
    lines.push('');
  }

  lines.push(
    'Tu peux inclure 0 à N de ces contenus dans tes suggestions.',
    'Si le contenu frais est abondant et de haute qualité, privilégie-le.',
    'Si le contenu frais est faible, inclus plus de resurfacés.',
    'Pour chaque resurfacé utilisé, explique en 2-3 phrases pourquoi il est pertinent maintenant.',
  );

  return lines.join('\n');
}
