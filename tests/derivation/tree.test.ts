import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { loadConfig } from '../../src/core/config.js';
import { createLogger } from '../../src/core/logger.js';
import { runMigrations } from '../../src/core/migrations/index.js';
import {
  createTree,
  getTree,
  getTreeBySuggestion,
  updateTreeStatus,
  updateTreeMaster,
  updateTreeMediaId,
  createDerivation,
  getDerivation,
  getDerivationsByTree,
  getDerivationsByStatus,
  getReadyDerivations,
  updateDerivationStatus,
  updateDerivationText,
  updateDerivationMedia,
  invalidateAllDerivations,
  getTreeStats,
} from '../../src/derivation/tree.js';

let db: Database.Database;

beforeEach(() => {
  process.env['DRY_RUN'] = 'true';
  try { loadConfig(); } catch { /* already loaded */ }
  try { createLogger(); } catch { /* already created */ }

  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);

  // Insert a suggestion to reference
  db.prepare(`
    INSERT INTO suggestions (content, pillar, platform, status)
    VALUES ('Test suggestion content', 'trend', 'instagram', 'go')
  `).run();
});

afterEach(() => {
  db.close();
});

describe('derivation tree CRUD', () => {
  it('should create a tree and retrieve it', () => {
    const tree = createTree(db, 1, 'Master text content', 'dark fantasy prompt');

    expect(tree.id).toBe(1);
    expect(tree.suggestionId).toBe(1);
    expect(tree.masterText).toBe('Master text content');
    expect(tree.masterImagePrompt).toBe('dark fantasy prompt');
    expect(tree.status).toBe('draft');
    expect(tree.validatedAt).toBeNull();
  });

  it('should retrieve tree by id', () => {
    createTree(db, 1, 'Master text');
    const retrieved = getTree(db, 1);

    expect(retrieved).toBeDefined();
    expect(retrieved?.masterText).toBe('Master text');
  });

  it('should return undefined for non-existent tree', () => {
    expect(getTree(db, 999)).toBeUndefined();
  });

  it('should retrieve tree by suggestion id', () => {
    createTree(db, 1, 'First master');
    const tree = getTreeBySuggestion(db, 1);

    expect(tree).toBeDefined();
    expect(tree?.masterText).toBe('First master');
  });

  it('should ignore invalidated trees when fetching by suggestion', () => {
    const tree = createTree(db, 1, 'Old master');
    updateTreeStatus(db, tree.id, 'invalidated');

    const result = getTreeBySuggestion(db, 1);
    expect(result).toBeUndefined();
  });

  it('should update tree status', () => {
    const tree = createTree(db, 1, 'Master');
    updateTreeStatus(db, tree.id, 'master_validated');

    const updated = getTree(db, tree.id);
    expect(updated?.status).toBe('master_validated');
    expect(updated?.validatedAt).not.toBeNull();
  });

  it('should update master text', () => {
    const tree = createTree(db, 1, 'Original');
    updateTreeMaster(db, tree.id, 'Modified text', 'new prompt');

    const updated = getTree(db, tree.id);
    expect(updated?.masterText).toBe('Modified text');
    expect(updated?.masterImagePrompt).toBe('new prompt');
  });

  it('should update media id', () => {
    const tree = createTree(db, 1, 'Master');

    // Insert a media row
    db.prepare("INSERT INTO media (type, generator, naming) VALUES ('image', 'imagen', 'test.png')").run();

    updateTreeMediaId(db, tree.id, 1);
    const updated = getTree(db, tree.id);
    expect(updated?.masterMediaId).toBe(1);
  });
});

describe('derivation CRUD', () => {
  it('should create a derivation', () => {
    const tree = createTree(db, 1, 'Master');
    const deriv = createDerivation(db, tree.id, 'instagram', 'reel', 'video_9_16');

    expect(deriv.id).toBe(1);
    expect(deriv.treeId).toBe(tree.id);
    expect(deriv.platform).toBe('instagram');
    expect(deriv.format).toBe('reel');
    expect(deriv.mediaType).toBe('video_9_16');
    expect(deriv.status).toBe('pending');
  });

  it('should get derivations by tree', () => {
    const tree = createTree(db, 1, 'Master');
    createDerivation(db, tree.id, 'instagram', 'reel', 'video_9_16');
    createDerivation(db, tree.id, 'x', 'tweet', 'image_1_1');
    createDerivation(db, tree.id, 'linkedin', 'post_text_image', 'image_1_1');

    const derivations = getDerivationsByTree(db, tree.id);
    expect(derivations).toHaveLength(3);
  });

  it('should get derivations by status', () => {
    const tree = createTree(db, 1, 'Master');
    const d1 = createDerivation(db, tree.id, 'instagram', 'reel', 'video_9_16');
    createDerivation(db, tree.id, 'x', 'tweet', 'image_1_1');

    updateDerivationStatus(db, d1.id, 'text_validated');

    const validated = getDerivationsByStatus(db, tree.id, 'text_validated');
    expect(validated).toHaveLength(1);
    expect(validated[0]?.platform).toBe('instagram');
  });

  it('should update derivation text', () => {
    const tree = createTree(db, 1, 'Master');
    const deriv = createDerivation(db, tree.id, 'x', 'tweet', 'image_1_1');

    updateDerivationText(db, deriv.id, 'Adapted tweet text #TTRPG');

    const updated = getDerivation(db, deriv.id);
    expect(updated?.adaptedText).toBe('Adapted tweet text #TTRPG');
  });

  it('should update derivation media', () => {
    const tree = createTree(db, 1, 'Master');
    const deriv = createDerivation(db, tree.id, 'instagram', 'story', 'image_9_16_crop');

    db.prepare("INSERT INTO media (type, generator, naming) VALUES ('image', 'crop', 'crop.png')").run();

    updateDerivationMedia(db, deriv.id, 1, 'crop prompt');

    const updated = getDerivation(db, deriv.id);
    expect(updated?.mediaId).toBe(1);
    expect(updated?.mediaPrompt).toBe('crop prompt');
  });

  it('should get ready derivations', () => {
    const tree = createTree(db, 1, 'Master');
    const d1 = createDerivation(db, tree.id, 'x', 'tweet', 'image_1_1');
    const d2 = createDerivation(db, tree.id, 'linkedin', 'post_text_image', 'image_1_1');
    createDerivation(db, tree.id, 'instagram', 'reel', 'video_9_16');

    updateDerivationStatus(db, d1.id, 'ready');
    updateDerivationStatus(db, d2.id, 'text_validated');

    const ready = getReadyDerivations(db, tree.id);
    expect(ready).toHaveLength(2);
  });
});

describe('invalidation', () => {
  it('should invalidate all non-published derivations', () => {
    const tree = createTree(db, 1, 'Master');
    const d1 = createDerivation(db, tree.id, 'x', 'tweet', 'image_1_1');
    const d2 = createDerivation(db, tree.id, 'linkedin', 'post_text_image', 'image_1_1');
    const d3 = createDerivation(db, tree.id, 'instagram', 'reel', 'video_9_16');

    updateDerivationStatus(db, d1.id, 'ready');
    updateDerivationStatus(db, d2.id, 'text_validated');
    updateDerivationStatus(db, d3.id, 'published');

    const count = invalidateAllDerivations(db, tree.id);
    expect(count).toBe(2); // d1 + d2, not d3 (published)

    const d1Updated = getDerivation(db, d1.id);
    expect(d1Updated?.status).toBe('rejected');

    const d3Updated = getDerivation(db, d3.id);
    expect(d3Updated?.status).toBe('published'); // unchanged
  });
});

describe('tree stats', () => {
  it('should return correct counts per status', () => {
    const tree = createTree(db, 1, 'Master');
    const d1 = createDerivation(db, tree.id, 'x', 'tweet', 'image_1_1');
    const d2 = createDerivation(db, tree.id, 'linkedin', 'post_text_image', 'image_1_1');
    createDerivation(db, tree.id, 'instagram', 'reel', 'video_9_16');
    const d4 = createDerivation(db, tree.id, 'tiktok', 'reel', 'video_9_16');

    updateDerivationStatus(db, d1.id, 'ready');
    updateDerivationStatus(db, d2.id, 'rejected');
    updateDerivationStatus(db, d4.id, 'scheduled');

    const stats = getTreeStats(db, tree.id);
    expect(stats.total).toBe(4);
    expect(stats.pending).toBe(1);
    expect(stats.ready).toBe(1);
    expect(stats.rejected).toBe(1);
    expect(stats.scheduled).toBe(1);
    expect(stats.published).toBe(0);
  });
});
