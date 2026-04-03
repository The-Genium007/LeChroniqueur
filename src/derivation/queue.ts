import type { SqliteDatabase } from '../core/database.js';
import { getLogger } from '../core/logger.js';

// ─── Types ───

export type JobType = 'text_adaptation' | 'image_generation' | 'video_generation' | 'image_crop' | 'carousel_generation' | 'thread_generation' | 'article_generation';
export type JobStatus = 'queued' | 'processing' | 'completed' | 'failed' | 'retrying';

export interface QueueJob {
  readonly id: number;
  readonly type: JobType;
  readonly derivationId: number | null;
  readonly treeId: number;
  readonly priority: number;
  readonly payload: string;
  readonly status: JobStatus;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly result: string | null;
  readonly error: string | null;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
}

interface QueueJobRow {
  id: number;
  type: string;
  derivation_id: number | null;
  tree_id: number;
  priority: number;
  payload: string;
  status: string;
  attempts: number;
  max_attempts: number;
  result: string | null;
  error: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

// ─── Priority constants ───

export const PRIORITIES = {
  TEXT_ADAPTATION: 10,
  THREAD_GENERATION: 10,
  ARTICLE_GENERATION: 10,
  CAROUSEL_GENERATION: 8,
  IMAGE_CROP: 5,
  IMAGE_GENERATION: 3,
  VIDEO_GENERATION: 1,
} as const;

// ─── Row mapper ───

function mapJobRow(row: QueueJobRow): QueueJob {
  return {
    id: row.id,
    type: row.type as JobType,
    derivationId: row.derivation_id,
    treeId: row.tree_id,
    priority: row.priority,
    payload: row.payload,
    status: row.status as JobStatus,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    result: row.result,
    error: row.error,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

// ─── Queue operations ───

export function enqueueJob(
  db: SqliteDatabase,
  type: JobType,
  treeId: number,
  payload: unknown,
  derivationId?: number,
  priority?: number,
): QueueJob {
  const resolvedPriority = priority ?? getPriorityForType(type);

  const result = db.prepare(`
    INSERT INTO generation_queue (type, derivation_id, tree_id, priority, payload, status)
    VALUES (?, ?, ?, ?, ?, 'queued')
  `).run(type, derivationId ?? null, treeId, resolvedPriority, JSON.stringify(payload));

  const job = getJob(db, Number(result.lastInsertRowid));
  if (job === undefined) {
    throw new Error(`Failed to retrieve newly created job ${String(Number(result.lastInsertRowid))}`);
  }
  return job;
}

export function getJob(db: SqliteDatabase, id: number): QueueJob | undefined {
  const row = db.prepare('SELECT * FROM generation_queue WHERE id = ?').get(id) as QueueJobRow | undefined;
  return row !== undefined ? mapJobRow(row) : undefined;
}

/**
 * Gets the next job to process: highest priority first, then oldest first.
 */
export function dequeueNext(db: SqliteDatabase): QueueJob | undefined {
  const row = db.prepare(`
    SELECT * FROM generation_queue
    WHERE status = 'queued'
    ORDER BY priority DESC, created_at ASC
    LIMIT 1
  `).get() as QueueJobRow | undefined;

  return row !== undefined ? mapJobRow(row) : undefined;
}

export function markProcessing(db: SqliteDatabase, id: number): void {
  db.prepare(`
    UPDATE generation_queue
    SET status = 'processing', started_at = CURRENT_TIMESTAMP, attempts = attempts + 1
    WHERE id = ?
  `).run(id);
}

export function markCompleted(db: SqliteDatabase, id: number, result?: unknown): void {
  db.prepare(`
    UPDATE generation_queue
    SET status = 'completed', completed_at = CURRENT_TIMESTAMP, result = ?
    WHERE id = ?
  `).run(result !== undefined ? JSON.stringify(result) : null, id);
}

export function markFailed(db: SqliteDatabase, id: number, error: string): void {
  const job = getJob(db, id);
  if (job === undefined) return;

  const nextStatus = job.attempts < job.maxAttempts ? 'queued' : 'failed';

  db.prepare(`
    UPDATE generation_queue
    SET status = ?, error = ?, completed_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(nextStatus, error, id);
}

/**
 * Resets stuck processing jobs (e.g. after crash) back to queued.
 */
export function resetStuckJobs(db: SqliteDatabase): number {
  const logger = getLogger();

  const result = db.prepare(`
    UPDATE generation_queue
    SET status = 'queued', started_at = NULL
    WHERE status = 'processing'
  `).run();

  if (result.changes > 0) {
    logger.info({ count: result.changes }, 'Reset stuck queue jobs after restart');
  }

  return result.changes;
}

export function getQueuedCount(db: SqliteDatabase, treeId?: number): number {
  if (treeId !== undefined) {
    const row = db.prepare(
      'SELECT COUNT(*) as count FROM generation_queue WHERE tree_id = ? AND status IN (?, ?)',
    ).get(treeId, 'queued', 'processing') as { count: number };
    return row.count;
  }

  const row = db.prepare(
    'SELECT COUNT(*) as count FROM generation_queue WHERE status IN (?, ?)',
  ).get('queued', 'processing') as { count: number };
  return row.count;
}

export function getJobsByTree(db: SqliteDatabase, treeId: number): readonly QueueJob[] {
  const rows = db.prepare(
    'SELECT * FROM generation_queue WHERE tree_id = ? ORDER BY priority DESC, created_at ASC',
  ).all(treeId) as QueueJobRow[];
  return rows.map(mapJobRow);
}

export function clearTreeJobs(db: SqliteDatabase, treeId: number): number {
  const result = db.prepare(
    'DELETE FROM generation_queue WHERE tree_id = ? AND status IN (?, ?)',
  ).run(treeId, 'queued', 'failed');
  return result.changes;
}

// ─── Queue processor ───

export type JobHandler = (job: QueueJob) => Promise<unknown>;

interface QueueProcessorOptions {
  readonly pollIntervalMs?: number;
  readonly onJobComplete?: (job: QueueJob, result: unknown) => Promise<void>;
  readonly onJobFailed?: (job: QueueJob, error: string) => Promise<void>;
}

/**
 * Creates a sequential queue processor that runs jobs one at a time.
 * Returns start/stop controls.
 */
export function createQueueProcessor(
  db: SqliteDatabase,
  handler: JobHandler,
  options?: QueueProcessorOptions,
): { start: () => void; stop: () => void; isRunning: () => boolean } {
  const logger = getLogger();
  const pollInterval = options?.pollIntervalMs ?? 3000;

  let running = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  async function processNext(): Promise<boolean> {
    const job = dequeueNext(db);
    if (job === undefined) return false;

    logger.info(
      { jobId: job.id, type: job.type, treeId: job.treeId, attempt: job.attempts + 1 },
      'Processing queue job',
    );

    markProcessing(db, job.id);

    try {
      const result = await handler(job);
      markCompleted(db, job.id, result);

      logger.info({ jobId: job.id, type: job.type }, 'Queue job completed');

      if (options?.onJobComplete !== undefined) {
        await options.onJobComplete(job, result);
      }

      return true;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      markFailed(db, job.id, errorMsg);

      const updatedJob = getJob(db, job.id);
      const willRetry = updatedJob !== undefined && updatedJob.status === 'queued';

      logger.error(
        { jobId: job.id, type: job.type, error: errorMsg, willRetry },
        'Queue job failed',
      );

      if (!willRetry && options?.onJobFailed !== undefined) {
        await options.onJobFailed(job, errorMsg);
      }

      // Backoff before retrying: 5s, 15s, 45s
      if (willRetry) {
        const backoffMs = Math.pow(3, job.attempts) * 5000;
        await new Promise<void>((resolve) => { setTimeout(resolve, backoffMs); });
      }

      return true;
    }
  }

  function poll(): void {
    if (!running) return;

    processNext()
      .then((hadWork) => {
        if (!running) return;
        // If we did work, immediately check for more. Otherwise, wait.
        const delay = hadWork ? 100 : pollInterval;
        timer = setTimeout(poll, delay);
      })
      .catch((error) => {
        const msg = error instanceof Error ? error.message : String(error);
        // If database connection is closed, stop the processor gracefully
        if (msg.includes('not open') || msg.includes('database connection')) {
          logger.warn('Database connection closed, stopping queue processor');
          running = false;
          return;
        }
        logger.error({ error: msg }, 'Queue poll error');
        if (running) {
          timer = setTimeout(poll, pollInterval);
        }
      });
  }

  return {
    start(): void {
      if (running) return;
      running = true;
      resetStuckJobs(db);
      logger.info('Queue processor started');
      poll();
    },
    stop(): void {
      running = false;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      logger.info('Queue processor stopped');
    },
    isRunning(): boolean {
      return running;
    },
  };
}

// ─── Helpers ───

function getPriorityForType(type: JobType): number {
  switch (type) {
    case 'text_adaptation': return PRIORITIES.TEXT_ADAPTATION;
    case 'thread_generation': return PRIORITIES.THREAD_GENERATION;
    case 'article_generation': return PRIORITIES.ARTICLE_GENERATION;
    case 'carousel_generation': return PRIORITIES.CAROUSEL_GENERATION;
    case 'image_crop': return PRIORITIES.IMAGE_CROP;
    case 'image_generation': return PRIORITIES.IMAGE_GENERATION;
    case 'video_generation': return PRIORITIES.VIDEO_GENERATION;
  }
}
