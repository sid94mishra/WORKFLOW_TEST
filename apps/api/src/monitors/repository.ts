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
  status: Monitor['status'];
  last_checked_at: string | null;
  created_at: string;
};

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
    status: row.status,
    lastCheckedAt: row.last_checked_at,
    createdAt: row.created_at,
  };
}

export class MonitorRepository {
  constructor(private readonly db: SqliteDatabase) {}

  list(): Monitor[] {
    return (
      this.db.prepare('SELECT * FROM monitors ORDER BY created_at ASC, rowid ASC').all() as Row[]
    ).map(toMonitor);
  }

  listEnabled(): Monitor[] {
    return (
      this.db
        .prepare('SELECT * FROM monitors WHERE enabled = 1 ORDER BY created_at ASC, rowid ASC')
        .all() as Row[]
    ).map(toMonitor);
  }

  get(id: string): Monitor | undefined {
    const row = this.db.prepare('SELECT * FROM monitors WHERE id = ?').get(id) as Row | undefined;
    return row && toMonitor(row);
  }

  create(input: MonitorCreate & Pick<Monitor, 'id' | 'createdAt'>): Monitor {
    this.db
      .prepare(
        `
          INSERT INTO monitors (
            id, name, url, method, interval_seconds, timeout_ms,
            expected_status, keyword, enabled, created_at
          ) VALUES (
            @id, @name, @url, @method, @intervalSeconds, @timeoutMs,
            @expectedStatus, @keyword, @enabled, @createdAt
          )
        `,
      )
      .run({ ...input, enabled: input.enabled ? 1 : 0 });
    return this.get(input.id)!;
  }

  update(id: string, patch: MonitorUpdate): Monitor {
    // Keys come from the strict MonitorUpdateSchema, so only whitelisted columns reach the SQL.
    const columns: string[] = [];
    const values: unknown[] = [];
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      columns.push(`${COLUMNS[key as keyof MonitorUpdate]} = ?`);
      values.push(key === 'enabled' ? (value ? 1 : 0) : value);
    }
    if (
      ['url', 'method', 'timeoutMs', 'expectedStatus', 'keyword'].some(
        (key) => patch[key as keyof MonitorUpdate] !== undefined,
      )
    ) {
      columns.push("status = 'pending'", 'consecutive_failures = 0');
    }
    if (columns.length > 0) {
      this.db.prepare(`UPDATE monitors SET ${columns.join(', ')} WHERE id = ?`).run(...values, id);
    }
    return this.get(id)!;
  }

  delete(id: string): boolean {
    return this.db.prepare('DELETE FROM monitors WHERE id = ?').run(id).changes > 0;
  }
}
