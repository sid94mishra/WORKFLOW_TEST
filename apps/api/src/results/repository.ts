import { randomUUID } from 'node:crypto';
import {
  DOWN_AFTER_CONSECUTIVE_FAILURES,
  UPTIME_WINDOW_MS,
  type CheckOutcome,
  type CheckResult,
  type CheckStatus,
  type UptimeSummary,
  type UptimeWindow,
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

export class ResultRepository {
  private readonly recordTransaction: (
    monitorId: string,
    outcome: CheckOutcome,
  ) => CheckResult | undefined;

  constructor(private readonly db: SqliteDatabase) {
    // Prepared once: record() runs for every check.
    const selectFailures = db.prepare('SELECT consecutive_failures FROM monitors WHERE id = ?');
    const insertResult = db.prepare(
      `INSERT INTO check_results (
        id, monitor_id, checked_at, ok, status_code, latency_ms, error, keyword_matched, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const updateMonitor = db.prepare(
      'UPDATE monitors SET status = ?, consecutive_failures = ?, last_checked_at = ? WHERE id = ?',
    );
    this.recordTransaction = db.transaction((monitorId: string, outcome: CheckOutcome) => {
      const monitor = selectFailures.get(monitorId) as { consecutive_failures: number } | undefined;
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
      return result;
    });
  }

  record(monitorId: string, outcome: CheckOutcome): CheckResult | undefined {
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
