import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { CheckResultSchema } from '@pulse/shared';
import { buildApp } from '../src/app.js';

let app: FastifyInstance | undefined;
const create = async () => {
  const response = await app!.inject({
    method: 'POST',
    url: '/api/v1/monitors',
    headers: { 'content-type': 'application/json' },
    payload: { name: 'Example', url: 'https://example.test' },
  });
  return response.json().data as { id: string };
};
afterEach(async () => {
  await app?.close();
  app = undefined;
  vi.useRealTimers();
});

describe('result endpoints', () => {
  it('returns empty results and uptime summaries and validates only after monitor lookup', async () => {
    app = await buildApp({ databasePath: ':memory:' });
    const monitor = await create();
    expect((await app.inject(`/api/v1/monitors/${monitor.id}/results`)).json()).toEqual({
      data: [],
    });
    for (const window of ['24h', '7d', '30d']) {
      expect(
        (await app.inject(`/api/v1/monitors/${monitor.id}/uptime?window=${window}`)).json().data,
      ).toMatchObject({
        window,
        totalChecks: 0,
        okChecks: 0,
        uptimePercent: null,
        latencyP50Ms: null,
        latencyP95Ms: null,
      });
    }
    for (const limit of ['0', '501', 'abc']) {
      const response = await app.inject(`/api/v1/monitors/${monitor.id}/results?limit=${limit}`);
      expect(response.statusCode).toBe(400);
      expect(response.json().error.issues[0].path).toEqual(['limit']);
    }
    const missing = await app.inject('/api/v1/monitors/not-a-uuid/results?limit=0');
    expect(missing.statusCode).toBe(404);
    const unknown = await app.inject(
      '/api/v1/monitors/00000000-0000-4000-8000-000000000001/results?limit=abc',
    );
    expect(unknown.statusCode).toBe(404);
  });

  it('orders recent rows and calculates inclusive uptime percentiles', async () => {
    app = await buildApp({ databasePath: ':memory:' });
    const monitor = await create();
    const database = (
      app as FastifyInstance & {
        db: { prepare(sql: string): { run(...args: unknown[]): unknown } };
      }
    ).db;
    vi.useFakeTimers();
    const now = new Date('2026-10-11T12:00:00.000Z');
    vi.setSystemTime(now);
    const insert = database.prepare(
      'INSERT INTO check_results (id, monitor_id, checked_at, ok, status_code, latency_ms, error, keyword_matched, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    const rows: Array<[string, number, number, number]> = [
      ['one', -10, 1, 100],
      ['two', -5, 1, 200],
      ['three', -1, 0, 999],
    ];
    for (const [index, [, offset, ok, latency]] of rows.entries()) {
      insert.run(
        `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
        monitor.id,
        new Date(now.getTime() + offset).toISOString(),
        ok,
        ok ? 200 : null,
        latency,
        ok ? null : 'failed',
        null,
        ok ? 'up' : 'degraded',
      );
    }
    insert.run(
      '00000000-0000-4000-8000-000000000004',
      monitor.id,
      new Date(now.getTime() - 86_400_000).toISOString(),
      1,
      200,
      300,
      null,
      null,
      'up',
    );
    insert.run(
      '00000000-0000-4000-8000-000000000005',
      monitor.id,
      new Date(now.getTime() - 86_400_001).toISOString(),
      1,
      200,
      400,
      null,
      null,
      'up',
    );
    const listed = (await app.inject(`/api/v1/monitors/${monitor.id}/results?limit=2`)).json().data;
    expect(listed).toHaveLength(2);
    expect(listed[0].latencyMs).toBe(999);
    expect(listed.map((item: unknown) => CheckResultSchema.safeParse(item).success)).toEqual([
      true,
      true,
    ]);
    expect((await app.inject(`/api/v1/monitors/${monitor.id}/results`)).json().data).toHaveLength(
      5,
    );
    expect(
      (await app.inject(`/api/v1/monitors/${monitor.id}/results?limit=500`)).json().data,
    ).toHaveLength(5);
    const uptime = (await app.inject(`/api/v1/monitors/${monitor.id}/uptime`)).json().data;
    expect(uptime).toMatchObject({
      window: '24h',
      totalChecks: 4,
      okChecks: 3,
      uptimePercent: 75,
      latencyP50Ms: 200,
      latencyP95Ms: 300,
    });
    const invalidWindow = await app.inject(`/api/v1/monitors/${monitor.id}/uptime?window=1h`);
    expect(invalidWindow.statusCode).toBe(400);
    expect(invalidWindow.json().error.issues[0].path).toEqual(['window']);
  });
});
