import type { SqliteDatabase } from '../core/database.js';
import { getLogger } from '../core/logger.js';
import { complete } from '../services/anthropic.js';
import { recordAnthropicUsage } from '../budget/tracker.js';
import { getEngagementBySchedule, getPublicationCountByPlatform } from './aggregator.js';
import { formatSeasonalContext } from './seasonality.js';

// ─── Constants ───

const MIN_PUBLICATIONS_THRESHOLD = 6;

const DAY_NAMES = ['Dimanche', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi'] as const;

// ─── Types ───

export interface OptimalSlot {
  readonly platform: string;
  readonly dayOfWeek: number;
  readonly hour: number;
  readonly score: number;
  readonly sampleSize: number;
  readonly seasonContext: string | null;
}

export interface SlotRecommendation {
  readonly platform: string;
  readonly currentSlots: readonly OptimalSlot[];
  readonly recommendedSlots: readonly RecommendedSlot[];
  readonly reasoning: string;
  readonly hasEnoughData: boolean;
  readonly publicationCount: number;
}

interface RecommendedSlot {
  readonly dayOfWeek: number;
  readonly hour: number;
  readonly confidence: 'high' | 'medium' | 'low';
}

interface AISlotAnalysis {
  recommendations: Array<{
    platform: string;
    slots: Array<{
      dayOfWeek: number;
      hour: number;
      confidence: 'high' | 'medium' | 'low';
    }>;
    reasoning: string;
  }>;
}

interface OptimalSlotRow {
  platform: string;
  day_of_week: number;
  hour: number;
  score: number;
  sample_size: number;
  season_context: string | null;
}

// ─── Slot optimization ───

/**
 * Runs the weekly slot optimization analysis.
 * Returns recommendations per platform.
 */
export async function analyzeAndRecommendSlots(
  db: SqliteDatabase,
  configuredPlatforms: readonly string[],
): Promise<readonly SlotRecommendation[]> {
  const logger = getLogger();
  const pubCounts = getPublicationCountByPlatform(db);
  const recommendations: SlotRecommendation[] = [];

  for (const platform of configuredPlatforms) {
    const count = pubCounts.get(platform) ?? 0;
    const hasEnoughData = count >= MIN_PUBLICATIONS_THRESHOLD;
    const currentSlots = getCurrentSlots(db, platform);

    if (!hasEnoughData) {
      recommendations.push({
        platform,
        currentSlots,
        recommendedSlots: [],
        reasoning: `${String(count)}/${String(MIN_PUBLICATIONS_THRESHOLD)} publications — données insuffisantes pour optimiser les créneaux`,
        hasEnoughData: false,
        publicationCount: count,
      });
      continue;
    }

    const engagement = getEngagementBySchedule(db, platform);
    recommendations.push({
      platform,
      currentSlots,
      recommendedSlots: engagement.slice(0, 3).map((e) => ({
        dayOfWeek: e.dayOfWeek,
        hour: e.hour,
        confidence: e.totalPosts >= 5 ? 'high' : e.totalPosts >= 3 ? 'medium' : 'low',
      })),
      reasoning: `Top créneaux basés sur ${String(count)} publications`,
      hasEnoughData: true,
      publicationCount: count,
    });
  }

  logger.info(
    { platforms: configuredPlatforms.length, withData: recommendations.filter((r) => r.hasEnoughData).length },
    'Slot analysis complete',
  );

  return recommendations;
}

/**
 * Uses Claude to analyze engagement data and recommend optimal slots.
 * Called once per week during the rapport hebdomadaire.
 */
export async function aiAnalyzeSlots(
  db: SqliteDatabase,
  configuredPlatforms: readonly string[],
  persona: string,
): Promise<{ analysis: readonly SlotRecommendation[]; aiReasoning: string }> {
  const logger = getLogger();

  const pubCounts = getPublicationCountByPlatform(db);
  const seasonalContext = formatSeasonalContext(new Date());

  // Build engagement data summary for each platform
  const platformData: string[] = [];
  const platformsWithData: string[] = [];

  for (const platform of configuredPlatforms) {
    const count = pubCounts.get(platform) ?? 0;
    if (count < MIN_PUBLICATIONS_THRESHOLD) continue;

    platformsWithData.push(platform);
    const engagement = getEngagementBySchedule(db, platform);

    const lines = [`## ${platform} (${String(count)} publications)`];
    for (const e of engagement.slice(0, 10)) {
      const dayName = DAY_NAMES[e.dayOfWeek] ?? 'Inconnu';
      lines.push(`  ${dayName} ${String(e.hour)}h — engagement moyen: ${String(Math.round(e.avgEngagement))} (${String(e.totalPosts)} posts)`);
    }
    platformData.push(lines.join('\n'));
  }

  if (platformsWithData.length === 0) {
    return {
      analysis: await analyzeAndRecommendSlots(db, configuredPlatforms),
      aiReasoning: 'Pas assez de données pour une analyse IA.',
    };
  }

  const currentSlots: string[] = [];
  for (const platform of platformsWithData) {
    const slots = getCurrentSlots(db, platform);
    if (slots.length > 0) {
      const slotStr = slots.map((s) => {
        const dayName = DAY_NAMES[s.dayOfWeek] ?? 'Inconnu';
        return `${dayName} ${String(s.hour)}h (score: ${String(Math.round(s.score * 100) / 100)})`;
      }).join(', ');
      currentSlots.push(`${platform}: ${slotStr}`);
    }
  }

  const systemPrompt = [
    persona,
    '',
    '## Tâche',
    'Analyse les données d\'engagement de nos publications sur les réseaux sociaux et recommande les meilleurs créneaux de publication.',
    '',
    '## Contexte saisonnier',
    seasonalContext,
    '',
    '## Créneaux actuels',
    currentSlots.length > 0 ? currentSlots.join('\n') : 'Aucun créneau défini.',
    '',
    '## Format de sortie (JSON strict)',
    '```json',
    '{ "recommendations": [{ "platform": "...", "slots": [{ "dayOfWeek": 0-6, "hour": 0-23, "confidence": "high|medium|low" }], "reasoning": "..." }] }',
    '```',
    'dayOfWeek: 0=Dimanche, 1=Lundi, ..., 6=Samedi',
    'Recommande 2-3 créneaux par plateforme.',
    'Retourne UNIQUEMENT le JSON.',
  ].join('\n');

  const userMessage = platformData.join('\n\n');

  logger.debug({ platforms: platformsWithData }, 'AI slot analysis');

  const response = await complete(systemPrompt, userMessage, {
    maxTokens: 2048,
    temperature: 0.5,
  });

  recordAnthropicUsage(db, response.tokensIn, response.tokensOut);

  const cleaned = response.text.replace(/^```json?\n?/m, '').replace(/\n?```$/m, '').trim();
  const parsed = JSON.parse(cleaned) as AISlotAnalysis;

  // Build recommendations
  const recommendations: SlotRecommendation[] = [];

  for (const platform of configuredPlatforms) {
    const count = pubCounts.get(platform) ?? 0;
    const currentPlatformSlots = getCurrentSlots(db, platform);
    const aiRec = parsed.recommendations.find((r) => r.platform === platform);

    recommendations.push({
      platform,
      currentSlots: currentPlatformSlots,
      recommendedSlots: aiRec?.slots ?? [],
      reasoning: aiRec?.reasoning ?? (count < MIN_PUBLICATIONS_THRESHOLD
        ? `${String(count)}/${String(MIN_PUBLICATIONS_THRESHOLD)} publications — données insuffisantes`
        : 'Pas de recommandation IA'),
      hasEnoughData: count >= MIN_PUBLICATIONS_THRESHOLD,
      publicationCount: count,
    });
  }

  return {
    analysis: recommendations,
    aiReasoning: parsed.recommendations.map((r) => `**${r.platform}**: ${r.reasoning}`).join('\n'),
  };
}

// ─── Slot CRUD ───

export function getCurrentSlots(db: SqliteDatabase, platform: string): readonly OptimalSlot[] {
  const rows = db.prepare(`
    SELECT * FROM optimal_slots WHERE platform = ? ORDER BY score DESC
  `).all(platform) as OptimalSlotRow[];

  return rows.map((row) => ({
    platform: row.platform,
    dayOfWeek: row.day_of_week,
    hour: row.hour,
    score: row.score,
    sampleSize: row.sample_size,
    seasonContext: row.season_context,
  }));
}

export function applyRecommendedSlots(
  db: SqliteDatabase,
  recommendations: readonly SlotRecommendation[],
): void {
  const logger = getLogger();

  const upsert = db.prepare(`
    INSERT INTO optimal_slots (platform, day_of_week, hour, score, sample_size, season_context)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(platform, day_of_week, hour) DO UPDATE SET
      score = excluded.score,
      sample_size = excluded.sample_size,
      season_context = excluded.season_context,
      updated_at = CURRENT_TIMESTAMP
  `);

  for (const rec of recommendations) {
    if (!rec.hasEnoughData) continue;

    for (const slot of rec.recommendedSlots) {
      const confidenceScore = slot.confidence === 'high' ? 1.0 : slot.confidence === 'medium' ? 0.7 : 0.4;
      upsert.run(
        rec.platform,
        slot.dayOfWeek,
        slot.hour,
        confidenceScore,
        rec.publicationCount,
        formatSeasonalContext(new Date()),
      );
    }
  }

  logger.info('Optimal slots updated');
}

/**
 * Gets the best slot for a platform (for scheduling suggestions).
 */
export function getBestSlot(db: SqliteDatabase, platform: string): { dayOfWeek: number; hour: number } | undefined {
  const row = db.prepare(`
    SELECT day_of_week, hour FROM optimal_slots
    WHERE platform = ?
    ORDER BY score DESC
    LIMIT 1
  `).get(platform) as { day_of_week: number; hour: number } | undefined;

  if (row === undefined) return undefined;

  return { dayOfWeek: row.day_of_week, hour: row.hour };
}

/**
 * Formats slot recommendations for the rapport hebdomadaire.
 */
export function formatSlotRecommendations(recommendations: readonly SlotRecommendation[]): string {
  const lines: string[] = ['**⏰ Créneaux de publication**', ''];

  for (const rec of recommendations) {
    if (!rec.hasEnoughData) {
      lines.push(`📊 **${rec.platform}** — ${rec.reasoning}`);
      continue;
    }

    const slots = rec.recommendedSlots.map((s) => {
      const dayName = DAY_NAMES[s.dayOfWeek] ?? 'Inconnu';
      const conf = s.confidence === 'high' ? '🟢' : s.confidence === 'medium' ? '🟡' : '🔴';
      return `${conf} ${dayName} ${String(s.hour)}h`;
    }).join(' · ');

    lines.push(`📊 **${rec.platform}** — ${slots}`);
    lines.push(`   _${rec.reasoning}_`);
  }

  return lines.join('\n');
}
