import cron from 'node-cron';
import { getLogger } from './logger.js';
import type { SqliteDatabase } from './database.js';

export interface InstanceJob {
  readonly name: string;
  readonly cronExpression: string;
  readonly runOnMissed: boolean;
  readonly handler: () => Promise<void>;
}

interface RunningJob {
  readonly name: string;
  readonly task: cron.ScheduledTask;
}

/**
 * Per-instance scheduler. Each instance gets its own set of cron jobs
 * with an optional minute offset to avoid simultaneous execution.
 */
export class InstanceScheduler {
  private readonly instanceId: string;
  private readonly db: SqliteDatabase;
  private readonly jobs: RunningJob[] = [];
  private running = false;

  constructor(instanceId: string, db: SqliteDatabase) {
    this.instanceId = instanceId;
    this.db = db;
  }

  /**
   * Start all cron jobs for this instance.
   * Checks for missed jobs and runs them if needed.
   */
  start(jobDefs: readonly InstanceJob[]): void {
    const logger = getLogger();

    if (this.running) {
      logger.warn({ instanceId: this.instanceId }, 'Scheduler already running');
      return;
    }

    for (const def of jobDefs) {
      if (!cron.validate(def.cronExpression)) {
        logger.error({ instanceId: this.instanceId, job: def.name, cron: def.cronExpression }, 'Invalid cron expression, skipping');
        continue;
      }

      const task = cron.schedule(def.cronExpression, () => {
        void this.executeJob(def);
      });

      this.jobs.push({ name: def.name, task });

      logger.info({ instanceId: this.instanceId, job: def.name, cron: def.cronExpression }, 'Cron job scheduled');

      // Check for missed runs
      if (def.runOnMissed) {
        void this.checkMissedRun(def);
      }
    }

    this.running = true;
  }

  /**
   * Stop all cron jobs for this instance.
   */
  stop(): void {
    const logger = getLogger();

    for (const job of this.jobs) {
      job.task.stop();
    }

    this.jobs.length = 0;
    this.running = false;

    logger.info({ instanceId: this.instanceId }, 'Instance scheduler stopped');
  }

  isRunning(): boolean {
    return this.running;
  }

  private async executeJob(def: InstanceJob): Promise<void> {
    const logger = getLogger();
    const startTime = Date.now();

    logger.info({ instanceId: this.instanceId, job: def.name }, 'Cron job starting');

    try {
      await def.handler();

      const durationMs = Date.now() - startTime;
      this.recordRun(def.name, 'success');

      logger.info({ instanceId: this.instanceId, job: def.name, durationMs }, 'Cron job completed');
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.recordRun(def.name, 'error', msg);

      logger.error({ instanceId: this.instanceId, job: def.name, error: msg }, 'Cron job failed');
    }
  }

  private async checkMissedRun(def: InstanceJob): Promise<void> {
    const logger = getLogger();

    let lastRun: { last_run_at: string } | undefined;
    try {
      lastRun = this.db.prepare(
        'SELECT last_run_at FROM cron_runs WHERE job_name = ?',
      ).get(def.name) as { last_run_at: string } | undefined;
    } catch (dbError) {
      const msg = dbError instanceof Error ? dbError.message : String(dbError);
      if (msg.includes('not open') || msg.includes('database connection')) {
        logger.warn({ instanceId: this.instanceId, job: def.name }, 'Database closed, skipping missed run check');
        return;
      }
      throw dbError;
    }

    if (lastRun === undefined) {
      // Never run before — run now
      logger.info({ instanceId: this.instanceId, job: def.name }, 'First run (never executed before)');
      await this.executeJob(def);
      return;
    }

    const lastRunDate = new Date(lastRun.last_run_at);
    const now = new Date();
    const hoursSinceLastRun = (now.getTime() - lastRunDate.getTime()) / (1000 * 60 * 60);

    // If last run was more than 25 hours ago, it's missed
    if (hoursSinceLastRun > 25) {
      logger.info(
        { instanceId: this.instanceId, job: def.name, hoursSinceLastRun: Math.round(hoursSinceLastRun) },
        'Missed cron job, running catch-up',
      );
      await this.executeJob(def);
    }
  }

  private recordRun(jobName: string, status: string, error?: string): void {
    try {
      this.db.prepare(`
        INSERT INTO cron_runs (job_name, last_run_at, status, error)
        VALUES (?, datetime('now'), ?, ?)
        ON CONFLICT(job_name)
        DO UPDATE SET last_run_at = datetime('now'), status = excluded.status, error = excluded.error
      `).run(jobName, status, error ?? null);
    } catch (dbError) {
      // DB might be closed if instance was deleted during job execution
      const msg = dbError instanceof Error ? dbError.message : String(dbError);
      if (msg.includes('not open') || msg.includes('database connection')) {
        getLogger().warn({ instanceId: this.instanceId, job: jobName }, 'Database closed, skipping cron run record');
      } else {
        throw dbError;
      }
    }
  }
}

/**
 * Apply a minute offset to a cron expression.
 * E.g., "0 7 * * *" with offset 3 → "3 7 * * *"
 */
export function applyCronOffset(cronExpr: string, offsetMinutes: number): string {
  if (offsetMinutes === 0) return cronExpr;

  const parts = cronExpr.split(' ');
  if (parts.length < 5) return cronExpr;

  const minute = parseInt(parts[0] ?? '0', 10);
  if (isNaN(minute)) return cronExpr;

  parts[0] = String((minute + offsetMinutes) % 60);
  return parts.join(' ');
}
