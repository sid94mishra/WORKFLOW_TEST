import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase, type SqliteDatabase } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { MaintenanceRepository } from '../src/maintenance/repository.js';
import { MonitorRepository } from '../src/monitors/repository.js';

let db: SqliteDatabase;
let maintenance: MaintenanceRepository;
let monitors: MonitorRepository;

const createdAt = '2026-10-13T00:00:00.000Z';
const monitorIds: [string, string, string] = [
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000002',
  '00000000-0000-4000-8000-000000000003',
];

const createMonitor = (id: string) =>
  monitors.create({
    id,
    name: id,
    url: `https://${id}.example.test`,
    method: 'GET',
    intervalSeconds: 60,
    timeoutMs: 1000,
    expectedStatus: 200,
    keyword: null,
    enabled: true,
    public: false,
    createdAt,
  });

const save = (id: string, monitorIds: string[] | 'all', startsAt: string, endsAt: string) =>
  maintenance.create(
    { id, title: id, monitorIds, startsAt, endsAt, repeat: null, createdAt },
    null,
  );

const monitorRowsStatement = (repository: MaintenanceRepository) =>
  (
    repository as unknown as {
      selectMonitorRows: { all: (...params: unknown[]) => unknown[] };
    }
  ).selectMonitorRows;

beforeEach(() => {
  db = openDatabase(':memory:');
  migrate(db);
  monitors = new MonitorRepository(db);
  monitorIds.forEach(createMonitor);
  maintenance = new MaintenanceRepository(db);
});

afterEach(() => db.close());

describe('maintenance repository', () => {
  it('does not read monitor rows when no relevant maintenance windows exist', () => {
    for (let i = 0; i < 10; i += 1) {
      const id = `10000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
      const startsAt = i % 2 === 0 ? '2026-10-10T10:00:00.000Z' : '2026-10-14T10:00:00.000Z';
      const endsAt = i % 2 === 0 ? '2026-10-10T11:00:00.000Z' : '2026-10-14T11:00:00.000Z';
      save(id, [monitorIds[i % monitorIds.length]!], startsAt, endsAt);
    }

    const monitorRows = vi.spyOn(monitorRowsStatement(maintenance), 'all');

    expect(maintenance.listRelevant('2026-10-13T10:00:00.000Z')).toEqual([]);
    expect(monitorRows).not.toHaveBeenCalled();
  });

  it('loads monitor rows only for active relevant maintenance windows', () => {
    const activeId = '20000000-0000-4000-8000-000000000000';
    save(
      '10000000-0000-4000-8000-000000000000',
      [monitorIds[0]],
      '2026-10-10T10:00:00.000Z',
      '2026-10-10T11:00:00.000Z',
    );
    save(
      activeId,
      [monitorIds[2], monitorIds[1]],
      '2026-10-13T09:00:00.000Z',
      '2026-10-13T11:00:00.000Z',
    );
    save(
      '30000000-0000-4000-8000-000000000000',
      [monitorIds[0]],
      '2026-10-14T10:00:00.000Z',
      '2026-10-14T11:00:00.000Z',
    );
    const monitorRows = vi.spyOn(monitorRowsStatement(maintenance), 'all');

    expect(maintenance.listRelevant('2026-10-13T10:00:00.000Z')).toMatchObject([
      { id: activeId, monitorIds: [monitorIds[2], monitorIds[1]] },
    ]);
    expect(monitorRows).toHaveBeenCalledTimes(1);
    expect(monitorRows).toHaveBeenCalledWith(JSON.stringify([activeId]));
  });

  it('preserves all-monitor and ordered monitor-list results across lookups', () => {
    const listedId = '40000000-0000-4000-8000-000000000000';
    const allId = '50000000-0000-4000-8000-000000000000';
    save(
      listedId,
      [monitorIds[2], monitorIds[0], monitorIds[1]],
      '2026-10-13T09:00:00.000Z',
      '2026-10-13T11:00:00.000Z',
    );
    save(allId, 'all', '2026-10-13T10:00:00.000Z', '2026-10-13T12:00:00.000Z');

    expect(maintenance.listRelevant('2026-10-13T10:30:00.000Z')).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: allId, monitorIds: 'all' })]),
    );
    expect(
      maintenance.listOverlapping('2026-10-13T10:15:00.000Z', '2026-10-13T10:45:00.000Z'),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: listedId,
          monitorIds: [monitorIds[2], monitorIds[0], monitorIds[1]],
        }),
      ]),
    );
    expect(maintenance.list()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: listedId,
          monitorIds: [monitorIds[2], monitorIds[0], monitorIds[1]],
        }),
      ]),
    );
    expect(maintenance.get(listedId)).toMatchObject({
      monitorIds: [monitorIds[2], monitorIds[0], monitorIds[1]],
    });
  });
});
