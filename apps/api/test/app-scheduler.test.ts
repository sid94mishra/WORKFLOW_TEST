import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';

const outcome = {
  checkedAt: '2026-10-11T00:00:00.000Z',
  ok: true,
  statusCode: 200,
  latencyMs: 1,
  error: null,
  keywordMatched: null,
};

let app: FastifyInstance | undefined;

afterEach(async () => {
  vi.useRealTimers();
  if (app) await app.close();
  app = undefined;
});

describe('buildApp scheduler wiring', () => {
  it('records a scheduled result when the monitor is not patched while the check runs', async () => {
    const runCheck = vi.fn(async () => outcome);
    app = await buildApp({
      databasePath: ':memory:',
      scheduler: { maxConcurrency: 1, allowPrivate: true, runCheck, random: () => 0.5 },
    });
    await app.ready();
    vi.useFakeTimers({
      toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
    });
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/monitors',
      headers: { 'content-type': 'application/json' },
      payload: { name: 'Scheduled', url: 'https://example.test' },
    });
    const id = created.json().data.id as string;
    await vi.advanceTimersByTimeAsync(3_000);
    expect(runCheck).toHaveBeenCalledTimes(1);
    expect((await app.inject(`/api/v1/monitors/${id}`)).json().data).toMatchObject({
      status: 'up',
      lastCheckedAt: outcome.checkedAt,
    });
    expect((await app.inject(`/api/v1/monitors/${id}/results`)).json().data).toHaveLength(1);
  });

  it('does not record an in-flight result after a target-changing patch', async () => {
    let resolveCheck!: (value: typeof outcome) => void;
    const runCheck = vi.fn(
      () => new Promise<typeof outcome>((resolve) => (resolveCheck = resolve)),
    );
    app = await buildApp({
      databasePath: ':memory:',
      scheduler: { maxConcurrency: 1, allowPrivate: true, runCheck, random: () => 0.5 },
    });
    await app.ready();
    vi.useFakeTimers({
      toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
    });
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/monitors',
      headers: { 'content-type': 'application/json' },
      payload: { name: 'Scheduled', url: 'https://a.example.test' },
    });
    const id = created.json().data.id as string;
    await vi.advanceTimersByTimeAsync(3_000);
    expect(runCheck).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://a.example.test' }),
    );

    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/v1/monitors/${id}`,
      headers: { 'content-type': 'application/json' },
      payload: { url: 'https://b.example.test' },
    });
    expect(patch.json().data.status).toBe('pending');

    resolveCheck(outcome);
    await vi.advanceTimersByTimeAsync(0);
    expect((await app.inject(`/api/v1/monitors/${id}`)).json().data).toMatchObject({
      status: 'pending',
      lastCheckedAt: null,
    });
    expect((await app.inject(`/api/v1/monitors/${id}/results`)).json().data).toEqual([]);
    const database = (
      app as FastifyInstance & {
        db: { prepare(sql: string): { all(): unknown[] } };
      }
    ).db;
    expect(database.prepare('SELECT * FROM incidents').all()).toEqual([]);
  });

  it('does not close the database until an in-flight check has recorded', async () => {
    let resolveCheck!: () => void;
    const runCheck = vi.fn(
      () => new Promise<typeof outcome>((resolve) => (resolveCheck = () => resolve(outcome))),
    );
    app = await buildApp({
      databasePath: ':memory:',
      scheduler: { maxConcurrency: 1, allowPrivate: true, runCheck, random: () => 0 },
    });
    await app.inject({
      method: 'POST',
      url: '/api/v1/monitors',
      headers: { 'content-type': 'application/json' },
      payload: { name: 'Closing', url: 'https://example.test' },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(runCheck).toHaveBeenCalledTimes(1);

    const database = (app as FastifyInstance & { db: { prepare(sql: string): { get(): unknown } } })
      .db;
    const closing = app.close();
    expect(() => database.prepare('SELECT 1').get()).not.toThrow();
    resolveCheck();
    await closing;
    expect(() => database.prepare('SELECT 1').get()).toThrow();
    app = undefined;
  });

  it('keeps checks independent from a hanging notification and shuts down without retries', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() => new Promise<Response>(() => {}));
    const runCheck = vi.fn(async (monitor: { id: string }) => ({
      ...outcome,
      ok: false,
      statusCode: null,
      error: `failure-${monitor.id}`,
    }));
    app = await buildApp({
      databasePath: ':memory:',
      egress: {
        resolveHost: async () => [{ address: '203.0.113.10', family: 4 }],
        fetch: fetch as never,
      },
      scheduler: { maxConcurrency: 2, runCheck, random: () => 0 },
    });
    await app.ready();
    vi.useFakeTimers({
      toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
    });
    const createMonitor = async (name: string) =>
      (
        await app!.inject({
          method: 'POST',
          url: '/api/v1/monitors',
          headers: { 'content-type': 'application/json' },
          payload: { name, url: 'https://monitor.test' },
        })
      ).json().data;
    const first = await createMonitor('First');
    const second = await createMonitor('Second');
    await app.inject({
      method: 'POST',
      url: '/api/v1/channels',
      headers: { 'content-type': 'application/json' },
      payload: {
        name: 'Ops',
        kind: 'webhook',
        url: 'https://hooks.test/hook',
        monitorIds: [first.id],
      },
    });
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(54_000);
    await vi.advanceTimersByTimeAsync(54_000);
    expect(runCheck).toHaveBeenCalledTimes(6);
    expect((app.scheduler as { inFlight: number }).inFlight).toBe(0);
    expect(second.id).toBeDefined();
    expect(fetch).toHaveBeenCalledTimes(1);
    const closing = app.close();
    await vi.advanceTimersByTimeAsync(10_000);
    await closing;
    expect(fetch).toHaveBeenCalledTimes(1);
    app = undefined;
  });
});
