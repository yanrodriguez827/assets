import type { Db } from './db.js';
import { Queue as BullQueue, Worker as BullWorker } from 'bullmq';
import IORedis from 'ioredis';

export type Job = { id: string; type: string; payload: any; attempts: number };

export type Queue = {
  kind: 'sqlite' | 'redis' | 'memory';
  pollAndLockNext: (workerId: string) => Promise<Job | null>;
  markDone: (jobId: string) => Promise<void>;
  markFailed: (jobId: string, error: string, retry: boolean) => Promise<void>;
  startRedisWorker?: (handler: (payload: any) => Promise<void>) => Promise<void>;
};

export function createSqliteQueue(db: Db): Queue {
  return {
    kind: 'sqlite',
    pollAndLockNext: async (workerId) => {
      // Lock a queued job using a transaction.
      await db.exec('BEGIN IMMEDIATE;');
      try {
        const row = await db.get<any>(
          `SELECT id, type, payload_json, attempts FROM jobs
           WHERE status = 'queued'
           ORDER BY created_at ASC
           LIMIT 1`
        );
        if (!row) {
          await db.exec('COMMIT;');
          return null;
        }

        const now = Date.now();
        await db.run(
          `UPDATE jobs
           SET status = 'processing', locked_by = :locked_by, locked_at = :locked_at, updated_at = :updated_at
           WHERE id = :id`,
          { locked_by: workerId, locked_at: now, updated_at: now, id: row.id }
        );

        await db.exec('COMMIT;');

        let payload: any = null;
        try {
          payload = JSON.parse(row.payload_json);
        } catch {
          payload = null;
        }

        return { id: row.id, type: row.type, payload, attempts: row.attempts };
      } catch (e) {
        await db.exec('ROLLBACK;');
        throw e;
      }
    },
    markDone: async (jobId) => {
      const now = Date.now();
      await db.run(`UPDATE jobs SET status = 'done', updated_at = :updated_at WHERE id = :id`, { updated_at: now, id: jobId });
    },
    markFailed: async (jobId, error, retry) => {
      const now = Date.now();
      if (retry) {
        await db.run(
          `UPDATE jobs
           SET status = 'queued', attempts = attempts + 1, last_error = :last_error, locked_by = NULL, locked_at = NULL, updated_at = :updated_at
           WHERE id = :id`,
          { last_error: error, updated_at: now, id: jobId }
        );
        return;
      }

      await db.run(
        `UPDATE jobs
         SET status = 'failed', attempts = attempts + 1, last_error = :last_error, locked_by = NULL, locked_at = NULL, updated_at = :updated_at
         WHERE id = :id`,
        { last_error: error, updated_at: now, id: jobId }
      );
    }
  };
}

export function createMemoryQueue(): Queue {
  return {
    kind: 'memory',
    pollAndLockNext: async () => null,
    markDone: async () => {},
    markFailed: async () => {}
  };
}

export function createRedisQueue(redisUrl: string): Queue {
  const connection = new (IORedis as any)(redisUrl, { maxRetriesPerRequest: null });
  const q = new BullQueue('transcode', { connection });

  return {
    kind: 'redis',
    pollAndLockNext: async () => null,
    markDone: async () => {},
    markFailed: async () => {},
    startRedisWorker: async (handler) => {
      new BullWorker(
        'transcode',
        async (job) => {
          await handler(job.data);
        },
        { connection, concurrency: 2 }
      );

      // Keep process alive.
      await new Promise<void>(() => {});
    }
  };
}
