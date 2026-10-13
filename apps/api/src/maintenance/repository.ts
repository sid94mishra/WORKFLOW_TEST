import type {
  MaintenanceCreatedBy,
  MaintenanceTarget,
  MaintenanceWindowCreate,
} from '@pulse/shared';
import type { SqliteDatabase } from '../db.js';

type DbRow = {
  id: string;
  title: string;
  all_monitors: number;
  starts_at: string;
  ends_at: string;
  repeat_weekdays: string | null;
  repeat_start_time: string | null;
  repeat_duration_minutes: number | null;
  created_by_user_id: string | null;
  created_by_api_key_id: string | null;
  created_at: string;
  updated_at: string;
};
export type MaintenanceRow = MaintenanceTarget & {
  createdBy: MaintenanceCreatedBy | null;
  createdAt: string;
  updatedAt: string;
};
const map = (r: DbRow, ids: string[]): MaintenanceRow => ({
  id: r.id,
  title: r.title,
  monitorIds: r.all_monitors ? 'all' : ids,
  startsAt: r.starts_at,
  endsAt: r.ends_at,
  repeat:
    r.repeat_weekdays === null
      ? null
      : {
          weekdays: r.repeat_weekdays.split(',').map(Number),
          startTime: r.repeat_start_time!,
          durationMinutes: r.repeat_duration_minutes!,
        },
  createdBy: r.created_by_user_id
    ? { kind: 'user', id: r.created_by_user_id }
    : r.created_by_api_key_id
      ? { kind: 'apiKey', id: r.created_by_api_key_id }
      : null,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});
export class MaintenanceRepository {
  private readonly selectAll;
  private readonly selectOne;
  private readonly selectRelevant;
  private readonly selectOverlapping;
  private readonly selectMonitorRows;
  private readonly deleteMonitorRows;
  private readonly insertMonitorRow;
  private readonly deleteWindow;
  private readonly saveWindow;
  constructor(private readonly db: SqliteDatabase) {
    this.selectAll = db.prepare(
      'SELECT * FROM maintenance_windows ORDER BY starts_at DESC,rowid DESC',
    );
    this.selectOne = db.prepare('SELECT * FROM maintenance_windows WHERE id=?');
    this.selectRelevant = db.prepare(
      'SELECT * FROM maintenance_windows WHERE starts_at<=? AND ends_at>?',
    );
    this.selectOverlapping = db.prepare(
      'SELECT * FROM maintenance_windows WHERE starts_at<? AND ends_at>?',
    );
    this.selectMonitorRows = db.prepare(
      'SELECT window_id,monitor_id FROM maintenance_window_monitors ORDER BY rowid',
    );
    this.deleteMonitorRows = db.prepare(
      'DELETE FROM maintenance_window_monitors WHERE window_id=?',
    );
    this.insertMonitorRow = db.prepare(
      'INSERT INTO maintenance_window_monitors(window_id,monitor_id) VALUES (?,?)',
    );
    this.deleteWindow = db.prepare('DELETE FROM maintenance_windows WHERE id=?');
    this.saveWindow = db.prepare(
      `INSERT INTO maintenance_windows (id,title,all_monitors,starts_at,ends_at,repeat_weekdays,repeat_start_time,repeat_duration_minutes,created_by_user_id,created_by_api_key_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,all_monitors=excluded.all_monitors,starts_at=excluded.starts_at,ends_at=excluded.ends_at,repeat_weekdays=excluded.repeat_weekdays,repeat_start_time=excluded.repeat_start_time,repeat_duration_minutes=excluded.repeat_duration_minutes,updated_at=excluded.updated_at`,
    );
  }
  private rows(statement: { all(...params: unknown[]): unknown[] }, ...params: unknown[]) {
    const ids = new Map<string, string[]>();
    for (const row of this.selectMonitorRows.all() as { window_id: string; monitor_id: string }[])
      ids.set(row.window_id, [...(ids.get(row.window_id) ?? []), row.monitor_id]);
    return (statement.all(...params) as DbRow[]).map((r) => map(r, ids.get(r.id) ?? []));
  }
  list() {
    return this.rows(this.selectAll);
  }
  get(id: string) {
    return this.rows(this.selectOne, id)[0];
  }
  listRelevant(at: string) {
    return this.rows(this.selectRelevant, at, at);
  }
  listOverlapping(from: string, to: string) {
    return this.rows(this.selectOverlapping, to, from);
  }
  create(
    input: MaintenanceWindowCreate & { id: string; createdAt: string },
    by: MaintenanceCreatedBy | null,
  ) {
    this.save(input, by, input.createdAt);
    return this.get(input.id)!;
  }
  update(id: string, input: MaintenanceWindowCreate) {
    const old = this.get(id)!;
    this.save({ ...input, id, createdAt: old.createdAt }, old.createdBy, new Date().toISOString());
    return this.get(id)!;
  }
  private save(
    input: MaintenanceWindowCreate & { id: string; createdAt: string },
    by: MaintenanceCreatedBy | null,
    updatedAt: string,
  ) {
    this.db.transaction(() => {
      this.saveWindow.run(
        input.id,
        input.title,
        input.monitorIds === 'all' ? 1 : 0,
        new Date(input.startsAt).toISOString(),
        new Date(input.endsAt).toISOString(),
        input.repeat?.weekdays.join(',') ?? null,
        input.repeat?.startTime ?? null,
        input.repeat?.durationMinutes ?? null,
        by?.kind === 'user' ? by.id : null,
        by?.kind === 'apiKey' ? by.id : null,
        input.createdAt,
        updatedAt,
      );
      this.deleteMonitorRows.run(input.id);
      if (input.monitorIds !== 'all') {
        for (const m of input.monitorIds) this.insertMonitorRow.run(input.id, m);
      }
    })();
  }
  delete(id: string) {
    return this.deleteWindow.run(id).changes > 0;
  }
}
