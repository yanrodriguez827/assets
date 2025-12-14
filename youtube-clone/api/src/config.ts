import path from 'node:path';
import { z } from 'zod';

const EnvSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  WEB_DIR: z.string().default('../web'),
  STORAGE_DIR: z.string().default('../storage'),
  JWT_SECRET: z.string().min(32),
  JWT_EXPIRES_IN: z.string().min(1).default('7d'),
  CORS_ORIGIN: z.string().min(1).optional()
});

export type AppConfig = {
  port: number;
  webDir: string;
  storageDir: string;
  jwtSecret: string;
  jwtExpiresIn: string;
  corsOrigin: string;
};

export function loadConfig(): AppConfig {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment:\n${msg}`);
  }

  const e = parsed.data;
  if (e.JWT_SECRET === 'change-me') {
    throw new Error('JWT_SECRET must be changed and must be at least 32 characters');
  }

  const webDir = path.resolve(process.cwd(), e.WEB_DIR);
  const storageDir = path.resolve(process.cwd(), e.STORAGE_DIR);
  const corsOrigin = e.CORS_ORIGIN ?? `http://localhost:${e.PORT}`;

  return {
    port: e.PORT,
    webDir,
    storageDir,
    jwtSecret: e.JWT_SECRET,
    jwtExpiresIn: e.JWT_EXPIRES_IN,
    corsOrigin
  };
}
