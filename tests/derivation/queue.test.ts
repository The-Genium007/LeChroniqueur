import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { loadConfig } from '../../src/core/config.js';
import { createLogger } from '../../src/core/logger.js';
import { runMigrations } from '../../src/core/migrations/index.js';
import {
  enqueueJob,
  getJob,
  dequeueNext,
  markProcessing,
  markCompleted,
  markFailed,
  resetStuckJobs,
  getQueuedCount,
  getJobsByTree,
  clearTreeJobs,
  PRIORITIES,
} from '../../src/derivation/queue.js';
import { createTree } from '../../src/derivation/tree.js';

let db: Database.Database;

beforeEach(() => {
  process.env['DRY_RUN'] = 'true';
  try { loadConfig(); } catch { /* already loaded */ }
  try { createLogger(); } catch { /* already created */ }

  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);

  // Insert a suggestion + tree
  db.prepare("INSERT INTO suggestions (content, pillar, platform, status) VALUES ('test', 'trend', 'both', 'go')").run();
  createTree(db, 1, 'Master text');
});

afterEach(() => {
  db.close();
});

describe('enqueue and dequeue', () => {
  it('should enqueue a job', () => {
    const job = enqueueJob(db, 'text_adaptation', 1, { text: 'hello' });

    expect(job.id).toBe(1);
    expect(job.type).toBe('text_adaptation');
    expect(job.treeId).toBe(1);
    expect(job.status).toBe('queued');
    expect(job.priority).toBe(PRIORITIES.TEXT_ADAPTATION);
    expect(job.attempts).toBe(0);
  });

  it('should dequeue highest priority first', () => {
    enqueueJob(db, 'video_generation', 1, { video: true }); // priority 1
    enqueueJob(db, 'text_adaptation', 1, { text: true });   // priority 10
    enqueueJob(db, 'image_generation', 1, { image: true }); // priority 3

    const next = dequeueNext(db);
    expect(next?.type).toBe('text_adaptation');
  });

  it('should dequeue oldest first at same priority', () => {
    enqueueJob(db, 'text_adaptation', 1, { first: true });
    enqueueJob(db, 'text_adaptation', 1, { second: true });

    const next = dequeueNext(db);
    const payload = JSON.parse(next?.payload ?? '{}') as Record<string, boolean>;
    expect(payload['first']).toBe(true);
  });

  it('should return undefined when queue is empty', () => {
    expect(dequeueNext(db)).toBeUndefined();
  });
});

describe('job lifecycle', () => {
  it('should mark job as processing', () => {
    const job = enqueueJob(db, 'text_adaptation', 1, {});
    markProcessing(db, job.id);

    const updated = getJob(db, job.id);
    expect(updated?.status).toBe('processing');
    expect(updated?.attempts).toBe(1);
    expect(updated?.startedAt).not.toBeNull();
  });

  it('should mark job as completed', () => {
    const job = enqueueJob(db, 'text_adaptation', 1, {});
    markProcessing(db, job.id);
    markCompleted(db, job.id, { result: 'done' });

    const updated = getJob(db, job.id);
    expect(updated?.status).toBe('completed');
    expect(updated?.completedAt).not.toBeNull();
    expect(updated?.result).toContain('done');
  });

  it('should retry failed job if under max attempts', () => {
    const job = enqueueJob(db, 'text_adaptation', 1, {});
    markProcessing(db, job.id); // attempts = 1
    markFailed(db, job.id, 'API timeout');

    const updated = getJob(db, job.id);
    expect(updated?.status).toBe('queued'); // back to queued for retry
    expect(updated?.error).toBe('API timeout');
  });

  it('should mark as failed after max attempts', () => {
    const job = enqueueJob(db, 'text_adaptation', 1, {});

    // Simulate 3 attempts
    for (let i = 0; i < 3; i++) {
      markProcessing(db, job.id);
      markFailed(db, job.id, `Attempt ${String(i + 1)} failed`);
    }

    const updated = getJob(db, job.id);
    expect(updated?.status).toBe('failed');
    expect(updated?.attempts).toBe(3);
  });
});

describe('resetStuckJobs', () => {
  it('should reset processing jobs to queued', () => {
    const job = enqueueJob(db, 'text_adaptation', 1, {});
    markProcessing(db, job.id);

    const count = resetStuckJobs(db);
    expect(count).toBe(1);

    const updated = getJob(db, job.id);
    expect(updated?.status).toBe('queued');
  });

  it('should not affect completed or failed jobs', () => {
    const j1 = enqueueJob(db, 'text_adaptation', 1, {});
    const j2 = enqueueJob(db, 'image_generation', 1, {});

    markProcessing(db, j1.id);
    markCompleted(db, j1.id);

    markProcessing(db, j2.id);
    markFailed(db, j2.id, 'error');
    markProcessing(db, j2.id);
    markFailed(db, j2.id, 'error');
    markProcessing(db, j2.id);
    markFailed(db, j2.id, 'error'); // 3rd attempt → failed

    const count = resetStuckJobs(db);
    expect(count).toBe(0);
  });
});

describe('queue queries', () => {
  it('should count queued jobs', () => {
    enqueueJob(db, 'text_adaptation', 1, {});
    enqueueJob(db, 'image_generation', 1, {});
    enqueueJob(db, 'video_generation', 1, {});

    expect(getQueuedCount(db)).toBe(3);
    expect(getQueuedCount(db, 1)).toBe(3);
  });

  it('should get jobs by tree', () => {
    enqueueJob(db, 'text_adaptation', 1, {});
    enqueueJob(db, 'image_generation', 1, {});

    const jobs = getJobsByTree(db, 1);
    expect(jobs).toHaveLength(2);
    // Should be ordered by priority desc
    expect(jobs[0]?.priority).toBeGreaterThanOrEqual(jobs[1]?.priority ?? 0);
  });

  it('should clear queued and failed jobs for a tree', () => {
    const j1 = enqueueJob(db, 'text_adaptation', 1, {});
    enqueueJob(db, 'image_generation', 1, {});

    markProcessing(db, j1.id);
    markCompleted(db, j1.id); // This one should NOT be cleared

    const cleared = clearTreeJobs(db, 1);
    expect(cleared).toBe(1); // Only the queued one
  });
});

describe('priority constants', () => {
  it('should have text adaptation as highest priority', () => {
    expect(PRIORITIES.TEXT_ADAPTATION).toBeGreaterThan(PRIORITIES.IMAGE_GENERATION);
    expect(PRIORITIES.IMAGE_GENERATION).toBeGreaterThan(PRIORITIES.VIDEO_GENERATION);
  });

  it('should have image crop higher than generation', () => {
    expect(PRIORITIES.IMAGE_CROP).toBeGreaterThan(PRIORITIES.IMAGE_GENERATION);
  });
});
