import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/core/migrations/index.js';

// Mock node-cron
vi.mock('node-cron', () => {
  const tasks: Array<{ stop: () => void }> = [];
  return {
    default: {
      validate: vi.fn(() => true),
      schedule: vi.fn((_expr: string, _cb: () => void) => {
        const task = { stop: vi.fn() };
        tasks.push(task);
        return task;
      }),
      // expose for test assertions
      _tasks: tasks,
    },
  };
});

// Mock logger
vi.mock('../../src/core/logger.js', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { createScheduler, type SchedulerJob } from '../../src/core/scheduler.js';
import cron from 'node-cron';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  vi.clearAllMocks();
});

afterEach(() => {
  db.close();
});

describe('createScheduler', () => {
  it('should schedule all valid jobs on start', () => {
    const jobs: SchedulerJob[] = [
      { name: 'job-a', cronExpression: '0 7 * * *', handler: async () => {}, runOnMissed: false },
      { name: 'job-b', cronExpression: '0 8 * * *', handler: async () => {}, runOnMissed: false },
    ];

    const scheduler = createScheduler(db, jobs);
    scheduler.start();

    expect(cron.schedule).toHaveBeenCalledTimes(2);
    expect(cron.validate).toHaveBeenCalledTimes(2);
  });

  it('should skip jobs with invalid cron expressions', () => {
    vi.mocked(cron.validate).mockReturnValueOnce(false);

    const jobs: SchedulerJob[] = [
      { name: 'bad-cron', cronExpression: 'invalid', handler: async () => {}, runOnMissed: false },
    ];

    const scheduler = createScheduler(db, jobs);
    scheduler.start();

    expect(cron.validate).toHaveBeenCalledWith('invalid');
    expect(cron.schedule).not.toHaveBeenCalled();
  });

  it('should stop all tasks on stop()', () => {
    const jobs: SchedulerJob[] = [
      { name: 'job-a', cronExpression: '0 7 * * *', handler: async () => {}, runOnMissed: false },
    ];

    const scheduler = createScheduler(db, jobs);
    scheduler.start();
    scheduler.stop();

    // The mock task's stop() should have been called
    const scheduledTask = vi.mocked(cron.schedule).mock.results[0]?.value as { stop: ReturnType<typeof vi.fn> };
    expect(scheduledTask.stop).toHaveBeenCalled();
  });
});

describe('runJob', () => {
  it('should execute a job by name and record success', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const jobs: SchedulerJob[] = [
      { name: 'test-job', cronExpression: '0 7 * * *', handler, runOnMissed: false },
    ];

    const scheduler = createScheduler(db, jobs);
    await scheduler.runJob('test-job');

    expect(handler).toHaveBeenCalledOnce();

    const run = db.prepare('SELECT * FROM cron_runs WHERE job_name = ?').get('test-job') as {
      job_name: string;
      status: string;
      error: string | null;
    } | undefined;

    expect(run).toBeDefined();
    expect(run?.status).toBe('success');
    expect(run?.error).toBeNull();
  });

  it('should record error when job handler throws', async () => {
    const handler = vi.fn().mockRejectedValue(new Error('boom'));
    const jobs: SchedulerJob[] = [
      { name: 'failing-job', cronExpression: '0 7 * * *', handler, runOnMissed: false },
    ];

    const scheduler = createScheduler(db, jobs);
    await scheduler.runJob('failing-job');

    const run = db.prepare('SELECT * FROM cron_runs WHERE job_name = ?').get('failing-job') as {
      status: string;
      error: string | null;
    } | undefined;

    expect(run).toBeDefined();
    expect(run?.status).toBe('error');
    expect(run?.error).toBe('boom');
  });

  it('should throw when job name is not found', async () => {
    const scheduler = createScheduler(db, []);
    await expect(scheduler.runJob('nonexistent')).rejects.toThrow('Job "nonexistent" not found');
  });

  it('should update existing cron_runs row on re-run (upsert)', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const jobs: SchedulerJob[] = [
      { name: 'upsert-job', cronExpression: '0 7 * * *', handler, runOnMissed: false },
    ];

    const scheduler = createScheduler(db, jobs);
    await scheduler.runJob('upsert-job');
    await scheduler.runJob('upsert-job');

    const rows = db.prepare('SELECT * FROM cron_runs WHERE job_name = ?').all('upsert-job');
    expect(rows).toHaveLength(1);
  });
});

describe('missed job recovery', () => {
  it('should run a missed job when no previous run exists', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const jobs: SchedulerJob[] = [
      { name: 'missed-job', cronExpression: '0 7 * * *', handler, runOnMissed: true },
    ];

    const scheduler = createScheduler(db, jobs);
    scheduler.start();

    // Give the async executeJob a tick to start
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(handler).toHaveBeenCalledOnce();
  });

  it('should run a missed job when last run was >24h ago', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const jobs: SchedulerJob[] = [
      { name: 'old-job', cronExpression: '0 7 * * *', handler, runOnMissed: true },
    ];

    // Insert a stale run from 48h ago
    const staleDate = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
    db.prepare('INSERT INTO cron_runs (job_name, last_run_at, status) VALUES (?, ?, ?)').run(
      'old-job',
      staleDate,
      'success',
    );

    const scheduler = createScheduler(db, jobs);
    scheduler.start();

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(handler).toHaveBeenCalledOnce();
  });

  it('should NOT run a missed job when last run was <24h ago', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const jobs: SchedulerJob[] = [
      { name: 'recent-job', cronExpression: '0 7 * * *', handler, runOnMissed: true },
    ];

    // Insert a recent run from 1h ago
    const recentDate = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
    db.prepare('INSERT INTO cron_runs (job_name, last_run_at, status) VALUES (?, ?, ?)').run(
      'recent-job',
      recentDate,
      'success',
    );

    const scheduler = createScheduler(db, jobs);
    scheduler.start();

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(handler).not.toHaveBeenCalled();
  });

  it('should NOT run a job with runOnMissed=false even if never ran', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const jobs: SchedulerJob[] = [
      { name: 'no-recover', cronExpression: '0 7 * * *', handler, runOnMissed: false },
    ];

    const scheduler = createScheduler(db, jobs);
    scheduler.start();

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(handler).not.toHaveBeenCalled();
  });
});
