import path from 'node:path';
import { z } from 'zod';

const EnvSchema = z.object({
  DB_DRIVER: z.enum(['sqlite', 'postgres']).default('sqlite'),
  SQLITE_PATH: z.string().default('../../data/dev.sqlite'),
  DATABASE_URL: z.string().default('postgresql://youtube:youtube@localhost:5432/youtube'),

  STORAGE_DRIVER: z.enum(['fs', 's3']).default('fs'),
  FS_STORAGE_DIR: z.string().default('../../data/storage'),

  QUEUE_DRIVER: z.enum(['sqlite', 'redis', 'memory']).default('sqlite'),
  REDIS_URL: z.string().default('redis://localhost:6379'),

  FFMPEG_THREADS: z.coerce.number().int().min(1).max(16).default(2)
});

export type WorkerConfig = {
  dbDriver: 'sqlite' | 'postgres';
  sqlitePath: string;
  databaseUrl: string;

  storageDriver: 'fs' | 's3';
  fsStorageDir: string;

  queueDriver: 'sqlite' | 'redis' | 'memory';
  redisUrl: string;

  ffmpegThreads: number;

  paths: {
    repoRoot: string;
    migrationsSqliteDir: string;
  };
};

export function loadWorkerConfig(): WorkerConfig {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment:\n${msg}`);
  }

  const e = parsed.data;
  const repoRoot = path.resolve(process.cwd(), '../..');
  const migrationsSqliteDir = path.resolve(repoRoot, 'db/migrations_sqlite');

  return {
    dbDriver: e.DB_DRIVER,
    sqlitePath: path.resolve(process.cwd(), e.SQLITE_PATH),
    databaseUrl: e.DATABASE_URL,

    storageDriver: e.STORAGE_DRIVER,
    fsStorageDir: path.resolve(process.cwd(), e.FS_STORAGE_DIR),

    queueDriver: e.QUEUE_DRIVER,
    redisUrl: e.REDIS_URL,

    ffmpegThreads: e.FFMPEG_THREADS,

    paths: {
      repoRoot,
      migrationsSqliteDir
    }
  };
}
