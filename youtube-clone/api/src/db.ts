import fs from 'node:fs';
import path from 'node:path';
import sqlite3 from 'sqlite3';
import { open, type Database } from 'sqlite';

export type DB = Database<sqlite3.Database, sqlite3.Statement>;

export async function openDb(storageDir: string): Promise<DB> {
  fs.mkdirSync(storageDir, { recursive: true });
  const dbPath = path.join(storageDir, 'db.sqlite');

  const db = await open({
    filename: dbPath,
    driver: sqlite3.Database
  });

  await db.exec('PRAGMA foreign_keys = ON;');
  await db.exec('PRAGMA journal_mode = WAL;');
  await db.exec('PRAGMA synchronous = NORMAL;');
  await db.exec('PRAGMA busy_timeout = 5000;');

  const schema = fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
  await db.exec(schema);

  return db;
}
