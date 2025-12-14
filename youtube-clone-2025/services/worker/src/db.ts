import fs from 'node:fs';
import path from 'node:path';
import sqlite3 from 'sqlite3';
import { open, type Database } from 'sqlite';
import { Pool } from 'pg';

import type { WorkerConfig } from './config.js';
import { compileNamedToPositional, type SqlParams } from './sql.js';

export type Db = {
  kind: 'sqlite' | 'postgres';
  exec: (sql: string) => Promise<void>;
  run: (sql: string, params?: SqlParams) => Promise<{ changes: number }>;
  get: <T>(sql: string, params?: SqlParams) => Promise<T | undefined>;
  all: <T>(sql: string, params?: SqlParams) => Promise<T[]>;
  close: () => Promise<void>;
};

async function applyMigrationsSqlite(db: Database<sqlite3.Database, sqlite3.Statement>, migrationsDir: string): Promise<void> {
  await db.exec('PRAGMA foreign_keys=ON;');
  await db.exec('PRAGMA journal_mode=WAL;');

  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  await db.exec(
    `CREATE TABLE IF NOT EXISTS migrations (
      id TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );`
  );

  for (const f of files) {
    const id = f;
    const row = await db.get<{ id: string }>('SELECT id FROM migrations WHERE id = :id', { ':id': id } as any);
    if (row) continue;

    const sql = fs.readFileSync(path.join(migrationsDir, f), 'utf8');
    await db.exec('BEGIN;');
    try {
      await db.exec(sql);
      await db.run('INSERT INTO migrations (id, applied_at) VALUES (:id, :applied_at)', { ':id': id, ':applied_at': Date.now() } as any);
      await db.exec('COMMIT;');
    } catch (e) {
      await db.exec('ROLLBACK;');
      throw e;
    }
  }
}

async function applyMigrationsPostgres(pool: any, migrationsDir: string): Promise<void> {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS migrations (
      id TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );`
  );

  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const f of files) {
    const id = f;
    const existing = await pool.query('SELECT id FROM migrations WHERE id = $1', [id]);
    if (existing.rowCount && existing.rowCount > 0) continue;

    const sql = fs.readFileSync(path.join(migrationsDir, f), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO migrations (id) VALUES ($1)', [id]);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }
}

export async function openDb(config: WorkerConfig): Promise<Db> {
  if (config.dbDriver === 'sqlite') {
    fs.mkdirSync(path.dirname(config.sqlitePath), { recursive: true });
    const db = await open({ filename: config.sqlitePath, driver: sqlite3.Database });
    await applyMigrationsSqlite(db, config.paths.migrationsSqliteDir);

    return {
      kind: 'sqlite',
      exec: async (sql) => {
        await db.exec(sql);
      },
      run: async (sql, params) => {
        const r = await db.run(sql, params as any);
        return { changes: typeof r.changes === 'number' ? r.changes : 0 };
      },
      get: async <T>(sql: string, params?: SqlParams) => {
        const row = await db.get<T>(sql, params as any);
        return row;
      },
      all: async <T>(sql: string, params?: SqlParams) => {
        const rows = await db.all<T[]>(sql, params as any);
        return rows as any as T[];
      },
      close: async () => {
        await db.close();
      }
    };
  }

  const pool = new Pool({ connectionString: config.databaseUrl });
  await applyMigrationsPostgres(pool, path.resolve(config.paths.repoRoot, 'db/migrations'));

  return {
    kind: 'postgres',
    exec: async (sql) => {
      await pool.query(sql);
    },
    run: async (sql, params) => {
      const compiled = compileNamedToPositional(sql, params);
      const r = await pool.query(compiled.text, compiled.values);
      return { changes: r.rowCount ?? 0 };
    },
    get: async (sql, params) => {
      const compiled = compileNamedToPositional(sql, params);
      const r = await pool.query(compiled.text, compiled.values);
      return (r.rows[0] as any) ?? undefined;
    },
    all: async (sql, params) => {
      const compiled = compileNamedToPositional(sql, params);
      const r = await pool.query(compiled.text, compiled.values);
      return r.rows as any;
    },
    close: async () => {
      await pool.end();
    }
  };
}
