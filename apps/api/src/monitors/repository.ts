import type { Monitor, MonitorCreate, MonitorUpdate } from '@pulse/shared';
import type { SqliteDatabase } from '../db.js';

type Row = {
  id: string;
  name: string;
  url: string;
  method: Monitor['method'];
  interval_seconds: number;
  timeout_ms: number;
  expected_status: number;
  keyword: string | null;
  enabled: number;
  public: number;
  status: Monitor['status'];
  last_checked_at: string | null;
  created_at: string;
  config_version: number;
};

export type MonitorSnapshot = Monitor & { configVersion: number };

/** camelCase field → snake_case column for every updatable field. */
const COLUMNS: Record<keyof MonitorUpdate, string> = {
  name: 'name',
  url: 'url',
  method: 'method',
  intervalSeconds: 'interval_seconds',
  timeoutMs: 'timeout_ms',
  expectedStatus: 'expected_status',
  keyword: 'keyword',
  enabled: 'enabled',
  public: 'public',
};

function toMonitor(row: Row): Monitor {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    method: row.method,
    intervalSeconds: row.interval_seconds,
    timeoutMs: row.timeout_ms,
    expectedStatus: row.expected_status,
    keyword: row.keyword,
    enabled: row.enabled === 1,
    public: row.public === 1,
    status: row.status,
    lastCheckedAt: row.last_checked_at,
    createdAt: row.created_at,
  };
}

function toSnapshot(row: Row): MonitorSnapshot {
  return { ...toMonitor(row), configVersion: row.config_version };
}

export class MonitorRepository {
  constructor(private readonly db: SqliteDatabase) {}

  list(): Monitor[] {
    return (
      this.db.prepare('SELECT * FROM monitors ORDER BY created_at ASC, rowid ASC').all() as Row[]
    ).map(toMonitor);
  }

  listEnabled(): MonitorSnapshot[] {
    return (
      this.db
        .prepare('SELECT * FROM monitors WHERE enabled = 1 ORDER BY created_at ASC, rowid ASC')
        .all() as Row[]
    ).map(toSnapshot);
  }

  get(id: string): Monitor | undefined {
    const row = this.db.prepare('SELECT * FROM monitors WHERE id = ?').get(id) as Row | undefined;
    return row && toMonitor(row);
  }

  create(input: MonitorCreate & Pick<Monitor, 'id' | 'createdAt'>): MonitorSnapshot {
    this.db
      .prepare(
        `
          INSERT INTO monitors (
            id, name, url, method, interval_seconds, timeout_ms,
            expected_status, keyword, enabled, public, created_at
          ) VALUES (
            @id, @name, @url, @method, @intervalSeconds, @timeoutMs,
            @expectedStatus, @keyword, @enabled, @public, @createdAt
          )
        `,
      )
      .run({ ...input, enabled: input.enabled ? 1 : 0, public: input.public ? 1 : 0 });
    return this.getSnapshot(input.id)!;
  }

  update(id: string, patch: MonitorUpdate): MonitorSnapshot {
    // Keys come from the strict MonitorUpdateSchema, so only whitelisted columns reach the SQL.
    const columns: string[] = [];
    const values: unknown[] = [];
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      columns.push(`${COLUMNS[key as keyof MonitorUpdate]} = ?`);
      values.push(key === 'enabled' || key === 'public' ? (value ? 1 : 0) : value);
    }
    if (
      ['url', 'method', 'timeoutMs', 'expectedStatus', 'keyword'].some(
        (key) => patch[key as keyof MonitorUpdate] !== undefined,
      )
    ) {
      columns.push(
        "status = 'pending'",
        'consecutive_failures = 0',
        'config_version = config_version + 1',
      );
    }
    if (columns.length > 0) {
      this.db.prepare(`UPDATE monitors SET ${columns.join(', ')} WHERE id = ?`).run(...values, id);
    }
    return this.getSnapshot(id)!;
  }

  private getSnapshot(id: string): MonitorSnapshot | undefined {
    const row = this.db.prepare('SELECT * FROM monitors WHERE id = ?').get(id) as Row | undefined;
    return row && toSnapshot(row);
  }

  delete(id: string): boolean {
    return this.db.transaction(() => {
      const changed = this.db.prepare('DELETE FROM monitors WHERE id = ?').run(id).changes > 0;
      this.db
        .prepare(
          'DELETE FROM maintenance_windows WHERE all_monitors=0 AND NOT EXISTS (SELECT 1 FROM maintenance_window_monitors mwm WHERE mwm.window_id=maintenance_windows.id)',
        )
        .run();
      return changed;
    })();
  }
}
