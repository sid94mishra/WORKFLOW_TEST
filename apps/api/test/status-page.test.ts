import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { StatusPageSchema } from '@pulse/shared';
import { buildApp } from '../src/app.js';
import { MonitorRepository } from '../src/monitors/repository.js';
import { ResultRepository } from '../src/results/repository.js';

let app: FastifyInstance | undefined;
const outcome = (ok: boolean, checkedAt: string, error = 'private cause') => ({
  checkedAt,
  ok,
  statusCode: ok ? 200 : null,
  latencyMs: 1,
  error: ok ? null : error,
  keywordMatched: null,
});
const create = (name: string, publicFlag: boolean) =>
  app!.inject({
    method: 'POST',
    url: '/api/v1/monitors',
    headers: { 'content-type': 'application/json' },
    payload: { name, url: `https://${name.toLowerCase()}.test`, public: publicFlag },
  });
afterEach(async () => {
  vi.useRealTimers();
  await app?.close();
  app = undefined;
});

describe('public status page', () => {
  it('builds 90 UTC bars, matches HTML and JSON, hides private data, and lists public incidents', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-11T00:30:00.000Z'));
    app = await buildApp({ databasePath: ':memory:' });
    const publicMonitor = (await create('Public', true)).json().data;
    const privateMonitor = (await create('Private', false)).json().data;
    const db = (app as FastifyInstance & { db: any }).db;
    const results = new ResultRepository(db);
    results.record(publicMonitor.id, outcome(true, '2026-07-13T12:00:00.000Z'));
    results.record(publicMonitor.id, outcome(true, '2026-10-10T23:59:59.999Z'));
    results.record(publicMonitor.id, outcome(false, '2026-10-11T00:00:00.000Z', 'secret outage')); // degraded
    for (const at of [
      '2026-10-11T00:01:00.000Z',
      '2026-10-11T00:02:00.000Z',
      '2026-10-11T00:03:00.000Z',
    ])
      results.record(privateMonitor.id, outcome(false, at, 'private secret'));
    const monitorRepository = new MonitorRepository(db);
    const pageResponse = await app.inject('/api/v1/status');
    const page = pageResponse.json().data;
    expect(pageResponse.headers['cache-control']).toBe('public, max-age=30');
    expect(StatusPageSchema.safeParse(page).success).toBe(true);
    expect(page.generatedAt).toBe('2026-10-11T00:30:00.000Z');
    expect(page.monitors).toHaveLength(1);
    expect(page.monitors[0]).toMatchObject({ id: publicMonitor.id, status: 'degraded' });
    expect(page.monitors[0].days).toHaveLength(90);
    expect(page.monitors[0].days[0].date).toBe('2026-07-14');
    expect(page.monitors[0].days.at(-1).date).toBe('2026-10-11');
    expect(page.monitors[0].days.find((d: any) => d.date === '2026-10-10')).toMatchObject({
      totalChecks: 1,
      okChecks: 1,
      uptimePercent: 100,
    });
    expect(page.monitors[0].days.find((d: any) => d.date === '2026-10-11')).toMatchObject({
      totalChecks: 1,
      okChecks: 0,
      uptimePercent: 0,
    });
    expect(page.monitors[0].days.find((d: any) => d.date === '2026-07-13')).toBeUndefined();
    expect(page.monitors[0].days.filter((d: any) => d.uptimePercent === null).length).toBe(88);
    expect(page.incidents.open).toEqual([]);
    expect(page.overall).toBe('degraded');
    expect(monitorRepository.get(privateMonitor.id)).toMatchObject({ public: false });

    const htmlResponse = await app.inject('/status');
    const html = htmlResponse.body;
    expect(htmlResponse.headers['content-type']).toContain('text/html');
    expect(htmlResponse.headers['content-security-policy']).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'",
    );
    expect(html).toContain(`data-monitor-id="${publicMonitor.id}"`);
    expect(html).toContain('data-status="degraded"');
    expect(html).not.toContain('Private');
    expect(html).not.toContain('private.test');
    expect(html).not.toContain('secret outage');
    expect(html).not.toContain('<script');
    expect((html.match(/class="bar bar-/g) ?? []).length).toBe(90);
    expect(html).toContain('2026-10-10: 100%');
    expect(html).toContain('2026-10-11: 0%');
  });

  it('orders and limits public resolved incidents while ignoring paused monitors', async () => {
    app = await buildApp({ databasePath: ':memory:' });
    const publicMonitor = (await create('Public', true)).json().data;
    const paused = (await create('Paused', true)).json().data;
    const db = (app as FastifyInstance & { db: any }).db;
    const insert = db.prepare(
      'INSERT INTO incidents (id,monitor_id,status,cause,started_at,resolved_at,duration_seconds) VALUES (?,?,?,?,?,?,?)',
    );
    for (let n = 0; n < 12; n++)
      insert.run(
        `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
        publicMonitor.id,
        'resolved',
        'secret',
        `2026-01-${String((n % 9) + 1).padStart(2, '0')}T00:00:00.000Z`,
        `2026-02-${String((n % 9) + 1).padStart(2, '0')}T00:00:00.000Z`,
        1,
      );
    insert.run(
      '20000000-0000-4000-8000-000000000001',
      paused.id,
      'open',
      'secret',
      '2026-10-11T00:00:00.000Z',
      null,
      null,
    );
    const page = (await app.inject('/api/v1/status')).json().data;
    expect(page.incidents.resolved).toHaveLength(10);
    expect(page.incidents.resolved.every((i: any) => i.monitorId === publicMonitor.id)).toBe(true);
    expect(JSON.stringify(page)).not.toContain('secret');
  });
});
