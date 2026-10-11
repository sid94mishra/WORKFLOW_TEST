import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type SqliteDatabase } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { MonitorRepository } from '../src/monitors/repository.js';
import { ResultRepository } from '../src/results/repository.js';

let db: SqliteDatabase;
let monitors: MonitorRepository;
let results: ResultRepository;
const id = '00000000-0000-4000-8000-000000000000';
const create = () =>
  monitors.create({
    id,
    name: 'Example',
    url: 'https://example.test',
    method: 'GET',
    intervalSeconds: 60,
    timeoutMs: 1000,
    expectedStatus: 200,
    keyword: null,
    enabled: true,
    createdAt: '2026-10-11T00:00:00.000Z',
  });
const outcome = (ok: boolean) => ({
  checkedAt: new Date().toISOString(),
  ok,
  statusCode: ok ? 200 : null,
  latencyMs: 10,
  error: ok ? null : 'failed',
  keywordMatched: null,
});

beforeEach(() => {
  db = openDatabase(':memory:');
  migrate(db);
  monitors = new MonitorRepository(db);
  results = new ResultRepository(db);
});
afterEach(() => db.close());

describe('result repository', () => {
  it('persists the degraded/down/up state machine and does nothing for deleted monitors', () => {
    create();
    expect(results.record(id, outcome(false))?.status).toBe('degraded');
    expect(results.record(id, outcome(false))?.status).toBe('degraded');
    expect(results.record(id, outcome(false))?.status).toBe('down');
    expect(results.record(id, outcome(true))?.status).toBe('up');
    expect(monitors.get(id)).toMatchObject({ status: 'up', lastCheckedAt: expect.any(String) });
    monitors.delete(id);
    expect(results.record(id, outcome(false))).toBeUndefined();
  });

  it('resets status only when a check-affecting monitor field changes', () => {
    create();
    results.record(id, outcome(false));
    expect(monitors.update(id, { name: 'Renamed' }).status).toBe('degraded');
    expect(monitors.update(id, { url: 'https://other.test' })).toMatchObject({ status: 'pending' });
  });
});
