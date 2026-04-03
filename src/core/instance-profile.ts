import type { SqliteDatabase } from './database.js';

// ─── Types ───

export interface InstanceProfile {
  readonly projectName: string;
  readonly projectNiche: string;
  readonly projectDescription: string;
  readonly projectLanguage: string;
  readonly projectUrl: string | null;
  readonly targetPlatforms: readonly string[];
  readonly targetFormats: readonly string[];
  readonly contentTypes: readonly string[];
  readonly includeDomains: readonly string[];
  readonly excludeDomains: readonly string[];
  readonly negativeKeywords: readonly string[];
  readonly pillars: readonly string[];
  readonly onboardingContext: string;
  readonly calibratedExamples: readonly CalibratedExample[] | null;
  readonly calibratedAt: string | null;
}

export interface CalibratedExample {
  readonly title: string;
  readonly expectedScore: number;
  readonly reasoning: string;
}

// ─── DB row shape ───

interface ProfileRow {
  project_name: string;
  project_niche: string;
  project_description: string;
  project_language: string;
  project_url: string | null;
  target_platforms: string;
  target_formats: string;
  content_types: string;
  include_domains: string;
  exclude_domains: string;
  negative_keywords: string;
  pillars: string;
  onboarding_context: string;
  calibrated_examples: string | null;
  calibrated_at: string | null;
}

// ─── Helpers ───

function parseJsonArray(json: string): readonly string[] {
  try {
    const parsed: unknown = JSON.parse(json);
    if (Array.isArray(parsed)) return parsed as string[];
  } catch {
    // ignore
  }
  return [];
}

function rowToProfile(row: ProfileRow): InstanceProfile {
  let calibrated: readonly CalibratedExample[] | null = null;
  if (row.calibrated_examples !== null) {
    try {
      calibrated = JSON.parse(row.calibrated_examples) as CalibratedExample[];
    } catch {
      // ignore
    }
  }

  return {
    projectName: row.project_name,
    projectNiche: row.project_niche,
    projectDescription: row.project_description,
    projectLanguage: row.project_language,
    projectUrl: row.project_url,
    targetPlatforms: parseJsonArray(row.target_platforms),
    targetFormats: parseJsonArray(row.target_formats),
    contentTypes: parseJsonArray(row.content_types),
    includeDomains: parseJsonArray(row.include_domains),
    excludeDomains: parseJsonArray(row.exclude_domains),
    negativeKeywords: parseJsonArray(row.negative_keywords),
    pillars: parseJsonArray(row.pillars),
    onboardingContext: row.onboarding_context,
    calibratedExamples: calibrated,
    calibratedAt: row.calibrated_at,
  };
}

// ─── CRUD ───

export function getProfile(db: SqliteDatabase): InstanceProfile | undefined {
  const row = db.prepare('SELECT * FROM instance_profile WHERE id = 1').get() as ProfileRow | undefined;
  if (row === undefined) return undefined;
  return rowToProfile(row);
}

export function saveProfile(db: SqliteDatabase, profile: Omit<InstanceProfile, 'calibratedExamples' | 'calibratedAt'>): void {
  db.prepare(`
    INSERT INTO instance_profile (
      id, project_name, project_niche, project_description, project_language,
      project_url, target_platforms, target_formats, content_types,
      include_domains, exclude_domains, negative_keywords, pillars,
      onboarding_context, updated_at
    ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      project_name = excluded.project_name,
      project_niche = excluded.project_niche,
      project_description = excluded.project_description,
      project_language = excluded.project_language,
      project_url = excluded.project_url,
      target_platforms = excluded.target_platforms,
      target_formats = excluded.target_formats,
      content_types = excluded.content_types,
      include_domains = excluded.include_domains,
      exclude_domains = excluded.exclude_domains,
      negative_keywords = excluded.negative_keywords,
      pillars = excluded.pillars,
      onboarding_context = excluded.onboarding_context,
      updated_at = excluded.updated_at
  `).run(
    profile.projectName,
    profile.projectNiche,
    profile.projectDescription,
    profile.projectLanguage,
    profile.projectUrl,
    JSON.stringify(profile.targetPlatforms),
    JSON.stringify(profile.targetFormats),
    JSON.stringify(profile.contentTypes),
    JSON.stringify(profile.includeDomains),
    JSON.stringify(profile.excludeDomains),
    JSON.stringify(profile.negativeKeywords),
    JSON.stringify(profile.pillars),
    profile.onboardingContext,
  );
}

export function saveCalibratedExamples(db: SqliteDatabase, examples: readonly CalibratedExample[]): void {
  db.prepare(`
    UPDATE instance_profile
    SET calibrated_examples = ?, calibrated_at = datetime('now'), updated_at = datetime('now')
    WHERE id = 1
  `).run(JSON.stringify(examples));
}

/**
 * Build a fallback profile from existing instance data (for V2 instances without instance_profile).
 */
export function buildFallbackProfile(instanceName: string): InstanceProfile {
  return {
    projectName: instanceName,
    projectNiche: '',
    projectDescription: '',
    projectLanguage: 'fr',
    projectUrl: null,
    targetPlatforms: ['tiktok', 'instagram'],
    targetFormats: ['reel', 'carousel', 'story', 'post'],
    contentTypes: [],
    includeDomains: [],
    excludeDomains: [],
    negativeKeywords: [],
    pillars: ['trend', 'tuto', 'community', 'product'],
    onboardingContext: '',
    calibratedExamples: null,
    calibratedAt: null,
  };
}

// ─── Config overrides upsert ───

export function upsertConfigOverride(db: SqliteDatabase, key: string, value: string): void {
  db.prepare(`
    INSERT INTO config_overrides (key, value, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = excluded.updated_at
  `).run(key, value);
}
