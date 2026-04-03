import type { SqliteDatabase } from '../core/database.js';
import { getLogger } from '../core/logger.js';
import { createDerivation, type Derivation } from './tree.js';

// ─── Platform format definitions ───

export interface PlatformFormat {
  readonly platform: string;
  readonly format: string;
  readonly mediaType: 'video_9_16' | 'image_1_1' | 'image_9_16_crop' | 'carousel_slides' | 'none';
  readonly emoji: string;
  readonly label: string;
  readonly group: 'video' | 'carousel' | 'post_image' | 'thread' | 'story' | 'pin' | 'article';
}

/**
 * Fixed cascade order — determines the sequence in which derivations are generated.
 * All instances use the same order. Only platforms present in the instance config are used.
 */
const CASCADE_ORDER: readonly PlatformFormat[] = [
  // 1. Reels / Videos (same 9:16 video)
  { platform: 'tiktok', format: 'reel', mediaType: 'video_9_16', emoji: '📱', label: 'TikTok Reel', group: 'video' },
  { platform: 'instagram', format: 'reel', mediaType: 'video_9_16', emoji: '📸', label: 'Instagram Reel', group: 'video' },
  { platform: 'facebook', format: 'reel', mediaType: 'video_9_16', emoji: '📘', label: 'Facebook Reel', group: 'video' },
  { platform: 'youtube', format: 'short', mediaType: 'video_9_16', emoji: '📺', label: 'YouTube Short', group: 'video' },

  // 2. Carousel
  { platform: 'instagram', format: 'carousel', mediaType: 'carousel_slides', emoji: '📸', label: 'Instagram Carousel', group: 'carousel' },

  // 3. Posts with image (reuse master 1:1)
  { platform: 'x', format: 'tweet', mediaType: 'image_1_1', emoji: '🐦', label: 'X Tweet', group: 'post_image' },
  { platform: 'linkedin', format: 'post_text_image', mediaType: 'image_1_1', emoji: '💼', label: 'LinkedIn Post', group: 'post_image' },
  { platform: 'facebook', format: 'post_image', mediaType: 'image_1_1', emoji: '📘', label: 'Facebook Post', group: 'post_image' },
  { platform: 'threads', format: 'post_image', mediaType: 'image_1_1', emoji: '🧵', label: 'Threads Post', group: 'post_image' },
  { platform: 'bluesky', format: 'post_image', mediaType: 'image_1_1', emoji: '🦋', label: 'Bluesky Post', group: 'post_image' },
  { platform: 'mastodon', format: 'toot', mediaType: 'image_1_1', emoji: '🐘', label: 'Mastodon Toot', group: 'post_image' },

  // 4. Thread (multi-tweets)
  { platform: 'x', format: 'thread', mediaType: 'image_1_1', emoji: '🐦', label: 'X Thread', group: 'thread' },

  // 5. Stories (same 9:16 crop, multi-platform)
  { platform: 'instagram', format: 'story', mediaType: 'image_9_16_crop', emoji: '📸', label: 'Instagram Story', group: 'story' },
  { platform: 'youtube', format: 'story', mediaType: 'image_9_16_crop', emoji: '📺', label: 'YouTube Story', group: 'story' },
  { platform: 'facebook', format: 'story', mediaType: 'image_9_16_crop', emoji: '📘', label: 'Facebook Story', group: 'story' },
  { platform: 'x', format: 'story', mediaType: 'image_9_16_crop', emoji: '🐦', label: 'X Story', group: 'story' },

  // 6. Pins
  { platform: 'pinterest', format: 'pin', mediaType: 'image_9_16_crop', emoji: '📌', label: 'Pinterest Pin', group: 'pin' },

  // 7. Articles (long format)
  { platform: 'reddit', format: 'article', mediaType: 'image_1_1', emoji: '🤖', label: 'Reddit Post', group: 'article' },
  { platform: 'linkedin', format: 'article', mediaType: 'none', emoji: '💼', label: 'LinkedIn Article', group: 'article' },
];

/**
 * Returns the full cascade order definition.
 */
export function getCascadeOrder(): readonly PlatformFormat[] {
  return CASCADE_ORDER;
}

/**
 * Filters the cascade to only include platforms configured for this instance.
 */
export function getFilteredCascade(configuredPlatforms: readonly string[]): readonly PlatformFormat[] {
  const platformSet = new Set(configuredPlatforms);
  return CASCADE_ORDER.filter((entry) => platformSet.has(entry.platform));
}

/**
 * Look up a platform format definition by platform + format.
 */
export function findPlatformFormat(platform: string, format: string): PlatformFormat | undefined {
  return CASCADE_ORDER.find((entry) => entry.platform === platform && entry.format === format);
}

/**
 * Creates all derivation records for a tree based on configured platforms.
 * Returns the created derivations in cascade order.
 */
export function createDerivationsForTree(
  db: SqliteDatabase,
  treeId: number,
  configuredPlatforms: readonly string[],
): readonly Derivation[] {
  const logger = getLogger();
  const cascade = getFilteredCascade(configuredPlatforms);

  logger.info(
    { treeId, platforms: configuredPlatforms, derivationCount: cascade.length },
    'Creating derivations for tree',
  );

  const derivations: Derivation[] = [];

  for (const entry of cascade) {
    const derivation = createDerivation(db, treeId, entry.platform, entry.format, entry.mediaType);
    derivations.push(derivation);
  }

  return derivations;
}

/**
 * Groups derivations by their media sharing characteristics.
 * Derivations in the same group can share the same generated media.
 */
export function groupBySharedMedia(derivations: readonly Derivation[]): Map<string, readonly Derivation[]> {
  const groups = new Map<string, Derivation[]>();

  for (const derivation of derivations) {
    const format = findPlatformFormat(derivation.platform, derivation.format);
    if (format === undefined) continue;

    const key = format.group;
    const existing = groups.get(key);
    if (existing !== undefined) {
      existing.push(derivation);
    } else {
      groups.set(key, [derivation]);
    }
  }

  return groups;
}
