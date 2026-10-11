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
        expect.objectContaining({ name: 'config_version' }),
      ]),
    );
    expect(db.prepare('SELECT version FROM schema_migrations ORDER BY version').all()).toEqual([
      { version: 1 },
      { version: 2 },
      { version: 3 },
      { version: 4 },
    ]);
  });

  it('applies migration 003 to a v2 database and backfills daily uptime', () => {
    db.exec(
      `CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);`,
    );
    db.exec(readFileSync(new URL('../migrations/001_init.sql', import.meta.url), 'utf8'));
    db.prepare('INSERT INTO schema_migrations VALUES (?, ?, ?)').run(
      1,
      '001_init.sql',
      '2026-01-01T00:00:00.000Z',
    );
    db.exec(readFileSync(new URL('../migrations/002_scheduler.sql', import.meta.url), 'utf8'));
    db.prepare('INSERT INTO schema_migrations VALUES (?, ?, ?)').run(
      2,
      '002_scheduler.sql',
      '2026-01-01T00:00:00.000Z',
    );
    const monitorId = '00000000-0000-4000-8000-000000000001';
    db.prepare(
      `INSERT INTO monitors (id,name,url,method,interval_seconds,timeout_ms,expected_status,keyword,enabled,status,consecutive_failures,last_checked_at,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      monitorId,
      'Example',
      'https://example.test',
      'GET',
      60,
      1000,
      200,
      null,
      1,
      'up',
      0,
      null,
      '2026-01-01T00:00:00.000Z',
    );
    const result = db.prepare(
      'INSERT INTO check_results (id,monitor_id,checked_at,ok,status_code,latency_ms,error,keyword_matched,status) VALUES (?,?,?,?,?,?,?,?,?)',
    );
    result.run('one', monitorId, '2026-10-10T23:59:59.999Z', 1, 200, 1, null, null, 'up');
    result.run('two', monitorId, '2026-10-11T00:00:00.000Z', 0, null, 1, 'down', null, 'down');
    migrate(db);
    expect(
      db.prepare('SELECT monitor_id,day,total_checks,ok_checks FROM daily_uptime').all(),
    ).toEqual([
      { monitor_id: monitorId, day: '2026-10-10', total_checks: 1, ok_checks: 1 },
      { monitor_id: monitorId, day: '2026-10-11', total_checks: 1, ok_checks: 0 },
    ]);
  });

  it('applies migration 004 to a v3 database with config_version defaulting to zero', () => {
    db.exec(
      'CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);',
    );
    for (const version of [1, 2, 3]) {
      const name = `${String(version).padStart(3, '0')}_${
        version === 1 ? 'init' : version === 2 ? 'scheduler' : 'incidents_notifications'
      }.sql`;
      db.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
      db.prepare('INSERT INTO schema_migrations VALUES (?, ?, ?)').run(
        version,
        name,
        '2026-01-01T00:00:00.000Z',
      );
    }
    db.prepare(
      `INSERT INTO monitors (id,name,url,method,interval_seconds,timeout_ms,expected_status,keyword,enabled,public,status,consecutive_failures,last_checked_at,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      '00000000-0000-4000-8000-000000000001',
      'Example',
      'https://example.test',
      'GET',
      60,
      1000,
      200,
      null,
      1,
      0,
      'pending',
      0,
      null,
      '2026-01-01T00:00:00.000Z',
    );

    migrate(db);
    expect(db.prepare('SELECT config_version FROM monitors').all()).toEqual([
      { config_version: 0 },
    ]);
    expect(db.prepare('SELECT version FROM schema_migrations ORDER BY version').all()).toEqual([
      { version: 1 },
      { version: 2 },
      { version: 3 },
      { version: 4 },
    ]);
  });

  it('enables foreign keys on open', () => {
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  });
});
