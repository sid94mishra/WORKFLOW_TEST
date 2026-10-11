import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type SqliteDatabase = Database.Database;

const IN_MEMORY = ':memory:';

export function openDatabase(path: string): SqliteDatabase {
  // Create the parent directory (e.g. ./data) so the default path works on first start.
  if (path !== IN_MEMORY) mkdirSync(dirname(path), { recursive: true });

  const db = new Database(path);
  db.pragma('foreign_keys = ON');
  if (path !== IN_MEMORY) db.pragma('journal_mode = WAL');
  return db;
}
