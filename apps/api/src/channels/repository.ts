import { randomUUID } from 'node:crypto';
import type { Channel, ChannelCreate, ChannelUpdate, DeliveryAttempt } from '@pulse/shared';
import type { SqliteDatabase } from '../db.js';
type ChannelRow = {
  id: string;
  name: string;
  kind: Channel['kind'];
  url: string;
  enabled: number;
  created_at: string;
};
type AttemptRow = {
  id: string;
  channel_id: string;
  incident_id: string | null;
  event: DeliveryAttempt['event'];
  attempt: number;
  attempted_at: string;
  ok: number;
  status_code: number | null;
  latency_ms: number;
  error: string | null;
};
const channel = (row: ChannelRow, monitorIds: string[]): Channel => ({
  id: row.id,
  name: row.name,
  kind: row.kind,
  url: row.url,
  enabled: row.enabled === 1,
  createdAt: row.created_at,
  monitorIds,
});
const attempt = (r: AttemptRow): DeliveryAttempt => ({
  id: r.id,
  channelId: r.channel_id,
  incidentId: r.incident_id,
  event: r.event,
  attempt: r.attempt,
  attemptedAt: r.attempted_at,
  ok: r.ok === 1,
  statusCode: r.status_code,
  latencyMs: r.latency_ms,
  error: r.error,
});
export class ChannelRepository {
  constructor(private readonly db: SqliteDatabase) {}
  private ids(id: string) {
    return (
      this.db
        .prepare(
          `SELECT mc.monitor_id FROM monitor_channels mc JOIN monitors m ON m.id=mc.monitor_id WHERE mc.channel_id=? ORDER BY m.created_at ASC,m.rowid ASC`,
        )
        .all(id) as { monitor_id: string }[]
    ).map((x) => x.monitor_id);
  }
  private map(row: ChannelRow | undefined) {
    return row && channel(row, this.ids(row.id));
  }
  list() {
    return (
      this.db
        .prepare('SELECT * FROM notification_channels ORDER BY created_at ASC,rowid ASC')
        .all() as ChannelRow[]
    ).map((r) => this.map(r)!);
  }
  get(id: string) {
    return this.map(
      this.db.prepare('SELECT * FROM notification_channels WHERE id=?').get(id) as
        ChannelRow | undefined,
    );
  }
  create(input: ChannelCreate & { id: string; createdAt: string }) {
    return this.db.transaction(() => {
      this.db
        .prepare(
          'INSERT INTO notification_channels (id,name,kind,url,enabled,created_at) VALUES (@id,@name,@kind,@url,@enabled,@createdAt)',
        )
        .run({ ...input, enabled: input.enabled ? 1 : 0 });
      this.setMonitors(input.id, input.monitorIds);
      return this.get(input.id)!;
    })();
  }
  update(id: string, patch: ChannelUpdate) {
    return this.db.transaction(() => {
      const fields: Record<string, string> = {
        name: 'name',
        kind: 'kind',
        url: 'url',
        enabled: 'enabled',
      };
      const sets: string[] = [];
      const values: unknown[] = [];
      for (const [k, v] of Object.entries(patch)) {
        if (k === 'monitorIds' || v === undefined) continue;
        sets.push(`${fields[k]}=?`);
        values.push(k === 'enabled' ? (v ? 1 : 0) : v);
      }
      if (sets.length)
        this.db
          .prepare(`UPDATE notification_channels SET ${sets.join(',')} WHERE id=?`)
          .run(...values, id);
      if (patch.monitorIds) this.setMonitors(id, patch.monitorIds);
      return this.get(id)!;
    })();
  }
  delete(id: string) {
    return this.db.prepare('DELETE FROM notification_channels WHERE id=?').run(id).changes > 0;
  }
  setMonitors(id: string, ids: string[]) {
    this.db.prepare('DELETE FROM monitor_channels WHERE channel_id=?').run(id);
    const insert = this.db.prepare(
      'INSERT INTO monitor_channels (monitor_id,channel_id) VALUES (?,?)',
    );
    for (const monitorId of [...new Set(ids)]) insert.run(monitorId, id);
  }
  listEnabledForMonitor(monitorId: string) {
    return (
      this.db
        .prepare(
          `SELECT c.* FROM notification_channels c JOIN monitor_channels mc ON mc.channel_id=c.id WHERE mc.monitor_id=? AND c.enabled=1 ORDER BY c.created_at,c.rowid`,
        )
        .all(monitorId) as ChannelRow[]
    ).map((r) => this.map(r)!);
  }
}
export class DeliveryRepository {
  constructor(private readonly db: SqliteDatabase) {}
  record(
    value: Omit<DeliveryAttempt, 'id'> & Partial<Pick<DeliveryAttempt, 'id'>>,
  ): DeliveryAttempt {
    const data = {
      ...value,
      id: value.id ?? randomUUID(),
      error: value.error?.slice(0, 500) ?? null,
    };
    this.db.transaction(() => {
      this.db
        .prepare(
          'INSERT INTO delivery_attempts (id,channel_id,incident_id,event,attempt,attempted_at,ok,status_code,latency_ms,error) VALUES (@id,@channelId,@incidentId,@event,@attempt,@attemptedAt,@ok,@statusCode,@latencyMs,@error)',
        )
        .run({ ...data, ok: data.ok ? 1 : 0 });
      this.db
        .prepare(
          `DELETE FROM delivery_attempts WHERE channel_id=? AND id NOT IN (SELECT id FROM delivery_attempts WHERE channel_id=? ORDER BY attempted_at DESC,rowid DESC LIMIT 20)`,
        )
        .run(data.channelId, data.channelId);
    })();
    return data;
  }
  listRecent(channelId: string) {
    return (
      this.db
        .prepare(
          'SELECT * FROM delivery_attempts WHERE channel_id=? ORDER BY attempted_at DESC,rowid DESC LIMIT 20',
        )
        .all(channelId) as AttemptRow[]
    ).map(attempt);
  }
}
