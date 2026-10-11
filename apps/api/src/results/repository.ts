import { randomUUID } from 'node:crypto';
import {
  DOWN_AFTER_CONSECUTIVE_FAILURES,
  UPTIME_WINDOW_MS,
  type CheckOutcome,
  type CheckResult,
  type CheckStatus,
  type UptimeSummary,
  type UptimeWindow,
  type Incident,
  type Monitor,
} from '@pulse/shared';
import type { SqliteDatabase } from '../db.js';

type ResultRow = {
  id: string;
  monitor_id: string;
  checked_at: string;
  ok: number;
  status_code: number | null;
  latency_ms: number;
  error: string | null;
  keyword_matched: number | null;
  status: CheckStatus;
};

function toResult(row: ResultRow): CheckResult {
  return {
    id: row.id,
    monitorId: row.monitor_id,
    checkedAt: row.checked_at,
    ok: row.ok === 1,
    statusCode: row.status_code,
    latencyMs: row.latency_ms,
    error: row.error,
    keywordMatched: row.keyword_matched === null ? null : row.keyword_matched === 1,
    status: row.status,
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
type IncidentRow = {
  id: string;
  monitor_id: string;
  monitor_name: string;
  status: 'open' | 'resolved';
  cause: string | null;
  started_at: string;
  resolved_at: string | null;
  duration_seconds: number | null;
};
function toIncident(row: IncidentRow): Incident {
  return {
    id: row.id,
    monitorId: row.monitor_id,
    monitorName: row.monitor_name,
    status: row.status,
    cause: row.cause,
    startedAt: row.started_at,
    resolvedAt: row.resolved_at,
    durationSeconds: row.duration_seconds,
  };
}
export type IncidentEvent = {
  type: 'incident.opened' | 'incident.resolved';
  incident: Incident;
  monitor: Monitor;
};
export type RecordResult = { result: CheckResult; event: IncidentEvent | null } & CheckResult;

export class ResultRepository {
  private readonly recordTransaction: (
    monitorId: string,
    outcome: CheckOutcome,
  ) => RecordResult | undefined;

  constructor(private readonly db: SqliteDatabase) {
    // Prepared once: record() runs for every check.
    const selectFailures = db.prepare('SELECT * FROM monitors WHERE id = ?');
    const insertResult = db.prepare(
      `INSERT INTO check_results (
        id, monitor_id, checked_at, ok, status_code, latency_ms, error, keyword_matched, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const updateMonitor = db.prepare(
      'UPDATE monitors SET status = ?, consecutive_failures = ?, last_checked_at = ? WHERE id = ?',
    );
    const upsertDaily = db.prepare(
      `INSERT INTO daily_uptime (monitor_id, day, total_checks, ok_checks) VALUES (?, substr(?, 1, 10), 1, ?) ON CONFLICT (monitor_id, day) DO UPDATE SET total_checks = total_checks + 1, ok_checks = ok_checks + excluded.ok_checks`,
    );
    const findOpen = db.prepare(
      `SELECT i.*, m.name AS monitor_name FROM incidents i JOIN monitors m ON m.id=i.monitor_id WHERE i.monitor_id = ? AND i.status = 'open'`,
    );
    const insertIncident = db.prepare(
      `INSERT INTO incidents (id, monitor_id, status, cause, started_at) VALUES (?, ?, 'open', ?, ?)`,
    );
    const resolveIncident = db.prepare(
      `UPDATE incidents SET status='resolved', resolved_at=?, duration_seconds=? WHERE id=?`,
    );
    this.recordTransaction = db.transaction((monitorId: string, outcome: CheckOutcome) => {
      const monitor = selectFailures.get(monitorId) as
        ({ consecutive_failures: number } & Record<string, unknown>) | undefined;
      if (!monitor) return undefined;
      const failures = outcome.ok ? 0 : monitor.consecutive_failures + 1;
      const status: CheckStatus = outcome.ok
        ? 'up'
        : failures >= DOWN_AFTER_CONSECUTIVE_FAILURES
          ? 'down'
          : 'degraded';
      const result: CheckResult = { id: randomUUID(), monitorId, ...outcome, status };
      insertResult.run(
        result.id,
        result.monitorId,
        result.checkedAt,
        result.ok ? 1 : 0,
        result.statusCode,
        result.latencyMs,
        result.error,
        result.keywordMatched === null ? null : result.keywordMatched ? 1 : 0,
        result.status,
      );
      updateMonitor.run(status, failures, outcome.checkedAt, monitorId);
      upsertDaily.run(monitorId, outcome.checkedAt, outcome.ok ? 1 : 0);
      let event: IncidentEvent | null = null;
      const open = findOpen.get(monitorId) as IncidentRow | undefined;
      const monitorObject: Monitor = {
        id: String(monitor.id),
        name: String(monitor.name),
        url: String(monitor.url),
        method: monitor.method as Monitor['method'],
        intervalSeconds: Number(monitor.interval_seconds),
        timeoutMs: Number(monitor.timeout_ms),
        expectedStatus: Number(monitor.expected_status),
        keyword: monitor.keyword as string | null,
        enabled: Number(monitor.enabled) === 1,
        public: Number(monitor.public) === 1,
        status,
        lastCheckedAt: outcome.checkedAt,
        createdAt: String(monitor.created_at),
      };
      if (status === 'down' && !open) {
        const incidentId = randomUUID();
        insertIncident.run(incidentId, monitorId, outcome.error, outcome.checkedAt);
        event = {
          type: 'incident.opened',
          incident: {
            id: incidentId,
            monitorId,
            monitorName: monitorObject.name,
            status: 'open',
            cause: outcome.error,
            startedAt: outcome.checkedAt,
            resolvedAt: null,
            durationSeconds: null,
          },
          monitor: monitorObject,
        };
      } else if (status === 'up' && open) {
        const durationSeconds = Math.max(
          0,
          Math.round(
            (new Date(outcome.checkedAt).getTime() - new Date(open.started_at).getTime()) / 1000,
          ),
        );
        resolveIncident.run(outcome.checkedAt, durationSeconds, open.id);
        event = {
          type: 'incident.resolved',
          incident: {
            ...toIncident(open),
            status: 'resolved',
            resolvedAt: outcome.checkedAt,
            durationSeconds,
          },
          monitor: monitorObject,
        };
      }
      return { ...result, result, event };
    });
  }

  record(monitorId: string, outcome: CheckOutcome): RecordResult | undefined {
    return this.recordTransaction(monitorId, outcome);
  }

  listRecent(monitorId: string, limit: number): CheckResult[] {
    return (
      this.db
        .prepare(
          'SELECT * FROM check_results WHERE monitor_id = ? ORDER BY checked_at DESC, rowid DESC LIMIT ?',
        )
        .all(monitorId, limit) as ResultRow[]
    ).map(toResult);
  }

  uptime(monitorId: string, window: UptimeWindow, now = new Date()): UptimeSummary {
    const to = now.toISOString();
    const from = new Date(now.getTime() - UPTIME_WINDOW_MS[window]).toISOString();
    const rows = this.db
      .prepare(
        `SELECT ok, latency_ms FROM check_results
         WHERE monitor_id = ? AND checked_at >= ? AND checked_at <= ? ORDER BY latency_ms ASC`,
      )
      .all(monitorId, from, to) as { ok: number; latency_ms: number }[];
    const totalChecks = rows.length;
    const latencies = rows.filter((row) => row.ok === 1).map((row) => row.latency_ms);
    const okChecks = latencies.length;
    const percentile = (percent: number): number | null => {
      if (latencies.length === 0) return null;
      return latencies[Math.ceil((percent / 100) * latencies.length) - 1] ?? null;
    };
    return {
      monitorId,
      window,
      from,
      to,
      totalChecks,
      okChecks,
      uptimePercent: totalChecks === 0 ? null : round2((100 * okChecks) / totalChecks),
      latencyP50Ms: percentile(50),
      latencyP95Ms: percentile(95),
    };
  }
}
