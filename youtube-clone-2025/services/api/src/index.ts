import 'dotenv/config';

import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { createFsStorage, createS3Storage } from './storage.js';
import { createMemoryQueue, createRedisQueue, createSqliteQueue } from './queue.js';
import { createApp } from './app.js';

const config = loadConfig();
const db = await openDb(config);

const storage =
  config.storageDriver === 's3'
    ? createS3Storage({
        endpoint: config.s3.endpoint,
        region: config.s3.region,
        accessKeyId: config.s3.accessKeyId,
        secretAccessKey: config.s3.secretAccessKey,
        bucket: config.s3.bucket,
        publicBaseUrl: config.s3.publicBaseUrl
      })
    : createFsStorage(config.fsStorageDir, config.publicBaseUrl);
await storage.ensureDirs();

const queue =
  config.queueDriver === 'redis'
    ? createRedisQueue(config.redisUrl)
    : config.queueDriver === 'memory'
      ? createMemoryQueue(db)
      : createSqliteQueue(db);

if (queue.kind === 'sqlite' && db.kind !== 'sqlite') {
  throw new Error('QUEUE_DRIVER=sqlite requires DB_DRIVER=sqlite');
}

const app = createApp(config, db, storage, queue);

app.listen(config.port, () => {
  console.log(`youtube-clone-2025 api listening on http://localhost:${config.port}`);
  console.log(`db: ${db.kind}  storage: ${storage.kind}  queue: ${queue.kind}`);
});
