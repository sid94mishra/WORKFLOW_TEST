import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type SqliteDatabase } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { MonitorRepository } from '../src/monitors/repository.js';
import { ResultRepository } from '../src/results/repository.js';

let db: SqliteDatabase;
let monitors: MonitorRepository;
let results: ResultRepository;
const monitorId = '00000000-0000-4000-8000-000000000000';
const outcome = (ok: boolean, checkedAt: string) => ({
  checkedAt,
  ok,
  statusCode: ok ? 200 : null,
  latencyMs: 1,
  error: ok ? null : 'unreachable',
  keywordMatched: null,
});

beforeEach(() => {
  db = openDatabase(':memory:');
  migrate(db);
  monitors = new MonitorRepository(db);
  results = new ResultRepository(db);
  monitors.create({
    id: monitorId,
    name: 'Example',
    url: 'https://example.test',
    method: 'GET',
    intervalSeconds: 60,
    timeoutMs: 1000,
    expectedStatus: 200,
    keyword: null,
    enabled: true,
    public: true,
    createdAt: '2026-10-11T00:00:00.000Z',
  });
});
afterEach(() => db.close());

describe('incident lifecycle', () => {
  it('opens on down, resolves on recovery, and writes daily uptime', () => {
    expect(results.record(monitorId, outcome(false, '2026-10-11T00:00:00.000Z'))?.event).toBeNull();
    expect(results.record(monitorId, outcome(false, '2026-10-11T00:01:00.000Z'))?.event).toBeNull();
    const opened = results.record(monitorId, outcome(false, '2026-10-11T00:02:00.000Z'))!;
    expect(opened.event).toMatchObject({
      type: 'incident.opened',
      incident: { cause: 'unreachable' },
    });
    const resolved = results.record(monitorId, outcome(true, '2026-10-11T00:04:30.000Z'))!;
    expect(resolved.event).toMatchObject({
      type: 'incident.resolved',
      incident: { durationSeconds: 150 },
    });
    expect(db.prepare('SELECT total_checks, ok_checks FROM daily_uptime').get()).toEqual({
      total_checks: 4,
      ok_checks: 1,
    });
  });

  it('keeps one incident stable, never opens for flapping, and opens a new one after recovery', () => {
    const fail = (at: number, error = `failure-${at}`) =>
      results.record(monitorId, { ...outcome(false, `2026-10-11T00:0${at}:00.000Z`), error });
    fail(0);
    fail(1);
    expect(fail(2)?.event?.type).toBe('incident.opened');
    const first = db.prepare("SELECT * FROM incidents WHERE status='open'").get() as {
      id: string;
      started_at: string;
      cause: string;
    };
    expect(fail(3)?.event).toBeNull();
    expect(fail(4)?.event).toBeNull();
    expect(db.prepare("SELECT * FROM incidents WHERE status='open'").get()).toMatchObject(first);

    const resolved = results.record(monitorId, outcome(true, '2026-10-11T00:10:30.000Z'))!;
    expect(resolved.event?.type).toBe('incident.resolved');
    expect(
      db
        .prepare('SELECT status,resolved_at,duration_seconds FROM incidents WHERE id=?')
        .get(first.id),
    ).toEqual({
      status: 'resolved',
      resolved_at: '2026-10-11T00:10:30.000Z',
      duration_seconds: 510,
    });
    expect(results.record(monitorId, outcome(true, '2026-10-11T00:11:00.000Z'))?.event).toBeNull();
    expect(results.record(monitorId, outcome(false, '2026-10-11T00:12:00.000Z'))?.event).toBeNull();
    expect(results.record(monitorId, outcome(false, '2026-10-11T00:13:00.000Z'))?.event).toBeNull();
    const reopened = results.record(monitorId, outcome(false, '2026-10-11T00:14:00.000Z'))!;
    expect(reopened.event?.type).toBe('incident.opened');
    expect(reopened.event?.incident.id).not.toBe(first.id);

    const flapId = '00000000-0000-4000-8000-000000000001';
    monitors.create({
      id: flapId,
      name: 'Flapping',
      url: 'https://flap.example',
      method: 'GET',
      intervalSeconds: 60,
      timeoutMs: 1000,
      expectedStatus: 200,
      keyword: null,
      enabled: true,
      public: false,
      createdAt: '2026-10-11T00:00:00.000Z',
    });
    for (let n = 0; n < 3; n++) {
      results.record(flapId, outcome(false, `2026-10-11T01:0${n}:00.000Z`));
      results.record(flapId, outcome(true, `2026-10-11T01:0${n}:30.000Z`));
    }
    expect(
      db.prepare('SELECT count(*) AS count FROM incidents WHERE monitor_id=?').get(flapId),
    ).toEqual({ count: 0 });
  });

  it('enforces one open incident and cascades monitor deletion', () => {
    const incidentId = '00000000-0000-4000-8000-000000000010';
    db.prepare(
      "INSERT INTO incidents (id,monitor_id,status,cause,started_at) VALUES (?,?,'open',?,?)",
    ).run(incidentId, monitorId, 'failed', '2026-10-11T00:00:00.000Z');
    expect(() =>
      db
        .prepare(
          "INSERT INTO incidents (id,monitor_id,status,cause,started_at) VALUES (?,?,'open',?,?)",
        )
        .run(
          '00000000-0000-4000-8000-000000000011',
          monitorId,
          'again',
          '2026-10-11T00:01:00.000Z',
        ),
    ).toThrow();
    monitors.delete(monitorId);
    expect(
      db.prepare('SELECT count(*) AS count FROM incidents WHERE monitor_id=?').get(monitorId),
    ).toEqual({ count: 0 });
  });
});
