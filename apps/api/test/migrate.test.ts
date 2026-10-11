import { readFileSync, readdirSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type SqliteDatabase } from '../src/db.js';
import { migrate } from '../src/migrate.js';

let db: SqliteDatabase;
beforeEach(() => {
  db = openDatabase(':memory:');
});
afterEach(() => {
  db.close();
});

const tableNames = () =>
  (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as {
      name: string;
    }[]
  ).map((row) => row.name);

describe('migrate', () => {
  it('creates the schema and the tracking table', () => {
    migrate(db);
    expect(tableNames()).toEqual(
      expect.arrayContaining(['check_results', 'monitors', 'schema_migrations']),
    );
  });

  it('records each applied migration with version, name and an ISO timestamp', () => {
    migrate(db);
    const rows = db
      .prepare('SELECT version, name, applied_at FROM schema_migrations ORDER BY version')
      .all() as { version: number; name: string; applied_at: string }[];
    const files = readdirSync(new URL('../migrations/', import.meta.url))
      .filter((name) => /^\d{3}_.+\.sql$/.test(name))
      .sort();
    expect(rows.map((row) => row.name)).toEqual(files);
    expect(rows[0]).toMatchObject({ version: 1, name: '001_init.sql' });
    for (const row of rows) {
      expect(new Date(row.applied_at).toISOString()).toBe(row.applied_at);
    }
  });

  it('is idempotent: a second run applies nothing', () => {
    migrate(db);
    const before = db.prepare('SELECT * FROM schema_migrations').all();
    expect(() => migrate(db)).not.toThrow();
    expect(db.prepare('SELECT * FROM schema_migrations').all()).toEqual(before);
  });

  it('applies scheduler migration on a version 1 database', () => {
    db.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL
      );
    `);
    db.exec(readFileSync(new URL('../migrations/001_init.sql', import.meta.url), 'utf8'));
    db.prepare('INSERT INTO schema_migrations VALUES (?, ?, ?)').run(
      1,
      '001_init.sql',
      '2026-01-01T00:00:00.000Z',
    );
    migrate(db);
    expect(db.prepare('PRAGMA table_info(monitors)').all()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'status' }),
        expect.objectContaining({ name: 'last_checked_at' }),
      ]),
    );
    expect(db.prepare('SELECT version FROM schema_migrations ORDER BY version').all()).toEqual([
      { version: 1 },
      { version: 2 },
    ]);
  });

  it('enables foreign keys on open', () => {
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  });
});
