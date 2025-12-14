import 'dotenv/config';

import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';

import { loadWorkerConfig } from './config.js';
import { openDb } from './db.js';
import { createFsStorage, createS3Storage } from './storage.js';
import { createRedisQueue, createSqliteQueue } from './queue.js';
import { probeMedia, transcodeToHls } from './ffmpeg.js';

const config = loadWorkerConfig();
const db = await openDb(config);

const storage =
  config.storageDriver === 's3'
    ? createS3Storage({
        endpoint: process.env.S3_ENDPOINT || 'http://localhost:9000',
        region: process.env.S3_REGION || 'us-east-1',
        accessKeyId: process.env.S3_ACCESS_KEY_ID || 'minio',
        secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || 'minio12345',
        bucket: process.env.S3_BUCKET || 'youtube'
      })
    : createFsStorage(config.fsStorageDir);
await storage.ensureDirs();

const queue = config.queueDriver === 'redis' ? createRedisQueue(config.redisUrl) : createSqliteQueue(db);

if (queue.kind === 'sqlite' && db.kind !== 'sqlite') {
  throw new Error('QUEUE_DRIVER=sqlite requires DB_DRIVER=sqlite');
}

const workerId = crypto.randomUUID();

async function safeRmDir(dir: string) {
  await fs.promises.rm(dir, { recursive: true, force: true });
}

async function processTranscode(videoId: string) {
  const v = await db.get<any>(`SELECT id, original_object_key FROM videos WHERE id = :id`, { id: videoId });
  if (!v) throw new Error('video_missing');

  const originalKey = String(v.original_object_key || '');
  if (!originalKey) throw new Error('original_key_missing');

  const tmpBase = path.join(config.fsStorageDir, 'tmp');
  await fs.promises.mkdir(tmpBase, { recursive: true });
  const tmpOriginal = path.join(tmpBase, `orig_${videoId}_${Date.now()}`);
  const tmpOut = path.join(tmpBase, `hls_${videoId}_${Date.now()}`);

  await safeRmDir(tmpOut);
  await fs.promises.rm(tmpOriginal, { force: true }).catch(() => {});

  // Download original into local tmp file for ffmpeg
  if (storage.kind === 'fs') {
    const p = storage.resolveFsPathForKey!(originalKey);
    await fs.promises.copyFile(p, tmpOriginal);
  } else {
    await storage.downloadObjectToFile(originalKey, tmpOriginal);
  }

  const info = await probeMedia(tmpOriginal);
  await transcodeToHls(tmpOriginal, tmpOut, config.ffmpegThreads);

  const indexPath = path.join(tmpOut, 'index.m3u8');
  if (!fs.existsSync(indexPath)) throw new Error('hls_missing');

  const hlsPrefix = `hls/${videoId}`;
  await storage.deletePrefix(hlsPrefix);
  await storage.uploadDirToPrefix(tmpOut, hlsPrefix);

  const masterKey = `${hlsPrefix}/index.m3u8`;

  await db.run(
    `UPDATE videos
     SET status = 'ready', hls_master_object_key = :hls_master_object_key, duration_seconds = :duration_seconds, width = :width, height = :height
     WHERE id = :id`,
    {
      id: videoId,
      hls_master_object_key: masterKey,
      duration_seconds: info.durationSeconds,
      width: info.width,
      height: info.height
    }
  );

  await safeRmDir(tmpOut);
  await fs.promises.rm(tmpOriginal, { force: true }).catch(() => {});
}

async function loop() {
  while (true) {
    const job = await queue.pollAndLockNext(workerId);
    if (!job) {
      await new Promise((r) => setTimeout(r, 1000));
      continue;
    }

    try {
      if (job.type !== 'transcode') {
        await queue.markFailed(job.id, 'unknown_job_type', false);
        continue;
      }

      const videoId = String(job.payload?.videoId || '');
      if (!videoId) {
        await queue.markFailed(job.id, 'missing_videoId', false);
        continue;
      }

      await db.run(`UPDATE videos SET status = 'processing' WHERE id = :id`, { id: videoId });
      await processTranscode(videoId);
      await queue.markDone(job.id);

      console.log(`[worker] transcoded ${videoId}`);
    } catch (e: any) {
      const msg = typeof e?.message === 'string' ? e.message : 'transcode_failed';
      const retry = job.attempts < 2;

      try {
        const videoId = String(job.payload?.videoId || '');
        if (videoId) await db.run(`UPDATE videos SET status = 'failed' WHERE id = :id`, { id: videoId });
      } catch {
        // ignore
      }

      await queue.markFailed(job.id, msg.slice(0, 2000), retry);
      console.error(`[worker] job failed ${job.id}: ${msg}`);
    }
  }
}

console.log(`[worker] started ${workerId} db=${db.kind} storage=${storage.kind} queue=${queue.kind}`);
if (queue.kind === 'redis') {
  await queue.startRedisWorker!(async (payload) => {
    const videoId = String(payload?.videoId || '');
    if (!videoId) throw new Error('missing_videoId');
    await db.run(`UPDATE videos SET status = 'processing' WHERE id = :id`, { id: videoId });
    await processTranscode(videoId);
  });
} else {
  await loop();
}
