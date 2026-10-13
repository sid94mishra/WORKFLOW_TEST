import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type SqliteDatabase } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { MaintenanceRepository } from '../src/maintenance/repository.js';
import { MonitorRepository } from '../src/monitors/repository.js';
import { ResultRepository } from '../src/results/repository.js';

const id = '00000000-0000-4000-8000-000000000000';
let db: SqliteDatabase, maintenance: MaintenanceRepository, results: ResultRepository;
const at = (value: string, ok = false) => ({
  checkedAt: value,
  ok,
  statusCode: ok ? 200 : null,
  latencyMs: 10,
  error: ok ? null : 'failed',
  keywordMatched: null,
});
beforeEach(() => {
  db = openDatabase(':memory:');
  migrate(db);
  const monitors = new MonitorRepository(db);
  monitors.create({
    id,
    name: 'Mon',
    url: 'https://example.test',
    method: 'GET',
    intervalSeconds: 60,
    timeoutMs: 1000,
    expectedStatus: 200,
    keyword: null,
    enabled: true,
    public: false,
    createdAt: '2026-10-13T00:00:00.000Z',
  });
  maintenance = new MaintenanceRepository(db);
  maintenance.create(
    {
      id: '10000000-0000-4000-8000-000000000000',
      title: 'work',
      monitorIds: [id],
      startsAt: '2026-10-13T10:00:00.000Z',
      endsAt: '2026-10-13T10:30:00.000Z',
      repeat: null,
      createdAt: '2026-10-13T00:00:00.000Z',
    },
    null,
  );
  results = new ResultRepository(db, maintenance);
});
afterEach(() => db.close());
describe('maintenance suppression', () => {
  it('records down checks but creates no incident during maintenance, then opens immediately afterwards', () => {
    results.record(id, at('2026-10-13T10:01:00.000Z'));
    results.record(id, at('2026-10-13T10:02:00.000Z'));
    const inside = results.record(id, at('2026-10-13T10:03:00.000Z'))!;
    expect(inside).toMatchObject({ status: 'down', event: null, suppressed: 'incident.opened' });
    expect(db.prepare('SELECT count(*) count FROM check_results').get()).toEqual({ count: 3 });
    expect(db.prepare('SELECT count(*) count FROM incidents').get()).toEqual({ count: 0 });
    const after = results.record(id, at('2026-10-13T10:31:00.000Z'))!;
    expect(after.event).toMatchObject({
      type: 'incident.opened',
      incident: { startedAt: '2026-10-13T10:31:00.000Z' },
    });
  });
  it('resolves an existing incident in maintenance without emitting an event', () => {
    results.record(id, at('2026-10-13T09:50:00.000Z'));
    results.record(id, at('2026-10-13T09:51:00.000Z'));
    results.record(id, at('2026-10-13T09:52:00.000Z'));
    expect(results.record(id, at('2026-10-13T10:01:00.000Z', true))).toMatchObject({
      event: null,
      suppressed: 'incident.resolved',
    });
    expect(db.prepare('SELECT status FROM incidents').get()).toEqual({ status: 'resolved' });
  });
});
