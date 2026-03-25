import cron from 'node-cron';
import type { SqliteDatabase } from './database.js';
import { getLogger } from './logger.js';

export interface SchedulerJob {
  readonly name: string;
  readonly cronExpression: string;
  readonly handler: () => Promise<void>;
  readonly runOnMissed: boolean;
}

interface CronRunRow {
  job_name: string;
  last_run_at: string;
  status: string;
  error: string | null;
}

export interface Scheduler {
  start(): void;
  stop(): void;
  runJob(name: string): Promise<void>;
}

export function createScheduler(db: SqliteDatabase, jobs: readonly SchedulerJob[]): Scheduler {
  const logger = getLogger();
  const tasks: cron.ScheduledTask[] = [];

  function recordRun(jobName: string, status: string, error?: string): void {
    db.prepare(`
      INSERT INTO cron_runs (job_name, last_run_at, status, error)
      VALUES (?, datetime('now'), ?, ?)
      ON CONFLICT(job_name) DO UPDATE SET
        last_run_at = datetime('now'),
        status = excluded.status,
        error = excluded.error
    `).run(jobName, status, error ?? null);
  }

  function getLastRun(jobName: string): CronRunRow | undefined {
    return db.prepare('SELECT * FROM cron_runs WHERE job_name = ?').get(jobName) as
      | CronRunRow
      | undefined;
  }

  async function executeJob(job: SchedulerJob): Promise<void> {
    logger.info({ job: job.name }, 'Cron job starting');
    try {
      await job.handler();
      recordRun(job.name, 'success');
      logger.info({ job: job.name }, 'Cron job completed');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      recordRun(job.name, 'error', message);
      logger.error({ job: job.name, error: message }, 'Cron job failed');
    }
  }

  function checkMissedJobs(): void {
    for (const job of jobs) {
      if (!job.runOnMissed) {
        continue;
      }

      const lastRun = getLastRun(job.name);

      if (lastRun === undefined) {
        logger.info({ job: job.name }, 'No previous run found, executing now');
        void executeJob(job);
        continue;
      }

      const lastRunDate = new Date(lastRun.last_run_at);
      const now = new Date();
      const hoursSinceLastRun = (now.getTime() - lastRunDate.getTime()) / (1000 * 60 * 60);

      // If last run was more than 24h ago, run immediately
      if (hoursSinceLastRun > 24) {
        logger.info(
          { job: job.name, lastRun: lastRun.last_run_at, hoursSince: Math.round(hoursSinceLastRun) },
          'Missed job detected, executing now',
        );
        void executeJob(job);
      }
    }
  }

  return {
    start(): void {
      logger.info({ jobCount: jobs.length }, 'Starting scheduler');

      // Check for missed jobs first
      checkMissedJobs();

      // Schedule all jobs
      for (const job of jobs) {
        if (!cron.validate(job.cronExpression)) {
          logger.error({ job: job.name, cron: job.cronExpression }, 'Invalid cron expression');
          continue;
        }

        const task = cron.schedule(
          job.cronExpression,
          () => {
            void executeJob(job);
          },
          { timezone: 'Europe/Paris' },
        );

        tasks.push(task);
        logger.info({ job: job.name, cron: job.cronExpression }, 'Job scheduled');
      }
    },

    stop(): void {
      for (const task of tasks) {
        task.stop();
      }
      tasks.length = 0;
      logger.info('Scheduler stopped');
    },

    async runJob(name: string): Promise<void> {
      const job = jobs.find((j) => j.name === name);
      if (job === undefined) {
        throw new Error(`Job "${name}" not found`);
      }
      await executeJob(job);
    },
  };
}
