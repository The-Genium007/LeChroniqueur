import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { loadConfig } from '../../src/core/config.js';
import { createLogger } from '../../src/core/logger.js';
import { runMigrations } from '../../src/core/migrations/index.js';
import {
  getCascadeOrder,
  getFilteredCascade,
  findPlatformFormat,
  createDerivationsForTree,
  groupBySharedMedia,
} from '../../src/derivation/cascade.js';
import { createTree, getDerivationsByTree } from '../../src/derivation/tree.js';

let db: Database.Database;

beforeEach(() => {
  process.env['DRY_RUN'] = 'true';
  try { loadConfig(); } catch { /* already loaded */ }
  try { createLogger(); } catch { /* already created */ }

  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);

  db.prepare(`
    INSERT INTO suggestions (content, pillar, platform, status)
    VALUES ('Test suggestion', 'trend', 'both', 'go')
  `).run();
});

afterEach(() => {
  db.close();
});

describe('cascade order', () => {
  it('should have a fixed order with all platform formats', () => {
    const order = getCascadeOrder();
    expect(order.length).toBeGreaterThan(15);

    // First should be video formats
    expect(order[0]?.platform).toBe('tiktok');
    expect(order[0]?.format).toBe('reel');
    expect(order[0]?.group).toBe('video');

    // Last should be articles
    const last = order[order.length - 1];
    expect(last?.group).toBe('article');
  });

  it('should have all expected groups', () => {
    const order = getCascadeOrder();
    const groups = new Set(order.map((e) => e.group));

    expect(groups).toContain('video');
    expect(groups).toContain('carousel');
    expect(groups).toContain('post_image');
    expect(groups).toContain('thread');
    expect(groups).toContain('story');
    expect(groups).toContain('pin');
    expect(groups).toContain('article');
  });
});

describe('filtered cascade', () => {
  it('should filter by configured platforms', () => {
    const filtered = getFilteredCascade(['tiktok', 'instagram']);

    // Should only contain tiktok and instagram entries
    expect(filtered.every((e) => e.platform === 'tiktok' || e.platform === 'instagram')).toBe(true);
    expect(filtered.length).toBeGreaterThan(3); // reel + carousel + post + story at minimum
  });

  it('should return empty for no platforms', () => {
    const filtered = getFilteredCascade([]);
    expect(filtered).toHaveLength(0);
  });

  it('should handle single platform', () => {
    const filtered = getFilteredCascade(['x']);

    expect(filtered.length).toBeGreaterThan(0);
    expect(filtered.every((e) => e.platform === 'x')).toBe(true);
  });

  it('should preserve cascade order', () => {
    const filtered = getFilteredCascade(['tiktok', 'instagram', 'linkedin']);
    const fullOrder = getCascadeOrder();

    // Indices in filtered should match relative order in full cascade
    let lastFullIndex = -1;
    for (const entry of filtered) {
      const fullIndex = fullOrder.findIndex(
        (e) => e.platform === entry.platform && e.format === entry.format,
      );
      expect(fullIndex).toBeGreaterThan(lastFullIndex);
      lastFullIndex = fullIndex;
    }
  });
});

describe('findPlatformFormat', () => {
  it('should find a known format', () => {
    const format = findPlatformFormat('tiktok', 'reel');

    expect(format).toBeDefined();
    expect(format?.platform).toBe('tiktok');
    expect(format?.mediaType).toBe('video_9_16');
    expect(format?.emoji).toBe('📱');
  });

  it('should return undefined for unknown format', () => {
    expect(findPlatformFormat('unknown', 'format')).toBeUndefined();
  });
});

describe('createDerivationsForTree', () => {
  it('should create derivation records for configured platforms', () => {
    const tree = createTree(db, 1, 'Master text');
    const derivations = createDerivationsForTree(db, tree.id, ['tiktok', 'instagram']);

    expect(derivations.length).toBeGreaterThan(0);
    expect(derivations.every((d) => d.status === 'pending')).toBe(true);

    // Verify stored in DB
    const dbDerivations = getDerivationsByTree(db, tree.id);
    expect(dbDerivations).toHaveLength(derivations.length);
  });

  it('should create correct media types', () => {
    const tree = createTree(db, 1, 'Master text');
    const derivations = createDerivationsForTree(db, tree.id, ['tiktok', 'instagram', 'x']);

    const reels = derivations.filter((d) => d.format === 'reel');
    expect(reels.every((d) => d.mediaType === 'video_9_16')).toBe(true);

    const tweets = derivations.filter((d) => d.format === 'tweet');
    expect(tweets.every((d) => d.mediaType === 'image_1_1')).toBe(true);

    const stories = derivations.filter((d) => d.format === 'story');
    expect(stories.every((d) => d.mediaType === 'image_9_16_crop')).toBe(true);
  });
});

describe('groupBySharedMedia', () => {
  it('should group derivations by media sharing characteristics', () => {
    const tree = createTree(db, 1, 'Master text');
    const derivations = createDerivationsForTree(db, tree.id, ['tiktok', 'instagram', 'facebook', 'youtube']);

    const groups = groupBySharedMedia(derivations);

    // Video group should contain all reel/short formats
    const videoGroup = groups.get('video') ?? [];
    expect(videoGroup.length).toBeGreaterThanOrEqual(3); // tiktok, instagram, facebook reels + youtube short
  });
});
