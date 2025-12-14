import path from 'node:path';
import { z } from 'zod';

const EnvSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  PUBLIC_BASE_URL: z.string().url().default('http://localhost:4000'),
  CORS_ORIGIN: z.string().min(1).default('http://localhost:4000'),

  DB_DRIVER: z.enum(['sqlite', 'postgres']).default('sqlite'),
  SQLITE_PATH: z.string().default('../../data/dev.sqlite'),
  DATABASE_URL: z.string().default('postgresql://youtube:youtube@localhost:5432/youtube'),

  STORAGE_DRIVER: z.enum(['fs', 's3']).default('fs'),
  FS_STORAGE_DIR: z.string().default('../../data/storage'),

  QUEUE_DRIVER: z.enum(['sqlite', 'redis', 'memory']).default('sqlite'),
  REDIS_URL: z.string().default('redis://localhost:6379'),

  S3_ENDPOINT: z.string().default('http://localhost:9000'),
  S3_REGION: z.string().default('us-east-1'),
  S3_ACCESS_KEY_ID: z.string().default('minio'),
  S3_SECRET_ACCESS_KEY: z.string().default('minio12345'),
  S3_BUCKET: z.string().default('youtube'),
  S3_PUBLIC_BASE_URL: z.string().default('http://localhost:9000/youtube'),

  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  COOKIE_SECRET: z.string().min(32),

  UPLOAD_MAX_BYTES: z.coerce.number().int().min(1).default(1073741824)
});

export type AppConfig = {
  port: number;
  publicBaseUrl: string;
  corsOrigin: string;

  dbDriver: 'sqlite' | 'postgres';
  sqlitePath: string;
  databaseUrl: string;

  storageDriver: 'fs' | 's3';
  fsStorageDir: string;

  queueDriver: 'sqlite' | 'redis' | 'memory';
  redisUrl: string;

  s3: {
    endpoint: string;
    region: string;
    accessKeyId: string;
    secretAccessKey: string;
    bucket: string;
    publicBaseUrl: string;
  };

  jwtAccessSecret: string;
  jwtRefreshSecret: string;
  cookieSecret: string;

  uploadMaxBytes: number;

  paths: {
    repoRoot: string;
    webDir: string;
    migrationsSqliteDir: string;
  };
};

export function loadConfig(): AppConfig {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment:\n${msg}`);
  }

  const e = parsed.data;

  const repoRoot = path.resolve(process.cwd(), '../..');
  const webDir = path.resolve(repoRoot, 'web');
  const migrationsSqliteDir = path.resolve(repoRoot, 'db/migrations_sqlite');

  return {
    port: e.PORT,
    publicBaseUrl: e.PUBLIC_BASE_URL,
    corsOrigin: e.CORS_ORIGIN,

    dbDriver: e.DB_DRIVER,
    sqlitePath: path.resolve(process.cwd(), e.SQLITE_PATH),
    databaseUrl: e.DATABASE_URL,

    storageDriver: e.STORAGE_DRIVER,
    fsStorageDir: path.resolve(process.cwd(), e.FS_STORAGE_DIR),

    queueDriver: e.QUEUE_DRIVER,
    redisUrl: e.REDIS_URL,

    s3: {
      endpoint: e.S3_ENDPOINT,
      region: e.S3_REGION,
      accessKeyId: e.S3_ACCESS_KEY_ID,
      secretAccessKey: e.S3_SECRET_ACCESS_KEY,
      bucket: e.S3_BUCKET,
      publicBaseUrl: e.S3_PUBLIC_BASE_URL
    },

    jwtAccessSecret: e.JWT_ACCESS_SECRET,
    jwtRefreshSecret: e.JWT_REFRESH_SECRET,
    cookieSecret: e.COOKIE_SECRET,

    uploadMaxBytes: e.UPLOAD_MAX_BYTES,

    paths: {
      repoRoot,
      webDir,
      migrationsSqliteDir
    }
  };
}
