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
  it('starts scheduled checks and records their status', async () => {
    const runCheck = vi.fn(async () => outcome);
    app = await buildApp({
      databasePath: ':memory:',
      scheduler: { maxConcurrency: 1, allowPrivate: true, runCheck, random: () => 0 },
    });
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/monitors',
      headers: { 'content-type': 'application/json' },
      payload: { name: 'Scheduled', url: 'https://example.test' },
    });
    const id = created.json().data.id as string;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(runCheck).toHaveBeenCalledTimes(1);
    expect((await app.inject(`/api/v1/monitors/${id}`)).json().data).toMatchObject({
      status: 'up',
      lastCheckedAt: outcome.checkedAt,
    });
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
});
