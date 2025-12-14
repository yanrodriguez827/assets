import crypto from 'node:crypto';
import type { Db } from './db.js';
import { Queue as BullQueue } from 'bullmq';
import IORedis from 'ioredis';

export type Queue = {
  kind: 'sqlite' | 'redis' | 'memory';
  enqueueTranscode: (videoId: string) => Promise<void>;
};

export function createSqliteQueue(db: Db): Queue {
  return {
    kind: 'sqlite',
    enqueueTranscode: async (videoId) => {
      const id = crypto.randomUUID();
      const now = Date.now();
      await db.run(
        `INSERT INTO jobs (id, type, payload_json, status, locked_by, locked_at, attempts, last_error, created_at, updated_at)
         VALUES (:id, 'transcode', :payload_json, 'queued', NULL, NULL, 0, NULL, :created_at, :updated_at)`,
        {
          id,
          payload_json: JSON.stringify({ videoId }),
          created_at: now,
          updated_at: now
        }
      );
    }
  };
}

export function createMemoryQueue(_db: Db): Queue {
  return {
    kind: 'memory',
    enqueueTranscode: async () => {
      // In-memory queue is not cross-process; this exists for single-process demos.
      return;
    }
  };
}

export function createRedisQueue(redisUrl: string): Queue {
  const connection = new (IORedis as any)(redisUrl, { maxRetriesPerRequest: null });
  const q = new BullQueue('transcode', { connection });

  return {
    kind: 'redis',
    enqueueTranscode: async (videoId) => {
      await q.add('transcode', { videoId }, { attempts: 3, removeOnComplete: 1000, removeOnFail: 1000 });
    }
  };
}
