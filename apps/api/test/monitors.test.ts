import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { SqliteDatabase } from '../src/db.js';
import { buildTestApp as buildApp } from './helpers.js';
import { buildApp as buildProductionApp } from '../src/app.js';

let app: FastifyInstance | undefined;
type TestApp = FastifyInstance & { db: SqliteDatabase };
const db = () => app as TestApp;
const json = async (method: 'POST' | 'PATCH', url: string, payload: unknown) =>
  app!.inject({
    method,
    url,
    headers: { 'content-type': 'application/json' },
    payload: payload as any,
  });
const create = async (payload: unknown = { name: 'Example', url: 'https://example.com' }) =>
  json('POST', '/api/v1/monitors', payload);
const paths = (response: { json: () => any }) =>
  response.json().error.issues.map((issue: { path: string[] }) => issue.path.join('.'));
afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('monitor collection', () => {
  it('returns an empty data list', async () => {
    app = await buildApp({ databasePath: ':memory:' });
    const response = await app.inject('/api/v1/monitors');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ data: [] });
  });

  it('creates a monitor with defaults and a Location header', async () => {
    app = await buildApp({ databasePath: ':memory:' });
    const response = await create({ name: '  Example  ', url: 'https://example.com' });
    const monitor = response.json().data;
    expect(response.statusCode).toBe(201);
    expect(response.headers.location).toBe(`/api/v1/monitors/${monitor.id}`);
    expect(monitor).toMatchObject({
      name: 'Example',
      method: 'GET',
      intervalSeconds: 60,
      timeoutMs: 10000,
      expectedStatus: 200,
      keyword: null,
      enabled: true,
      public: false,
    });
    expect(monitor.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(monitor.createdAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  });

  it('lists monitors in createdAt and row order', async () => {
    app = await buildApp({ databasePath: ':memory:' });
    await create({ name: 'One', url: 'https://one.example' });
    await create({ name: 'Two', url: 'https://two.example' });
    await create({ name: 'Three', url: 'https://three.example' });
    const monitors = (await app.inject('/api/v1/monitors')).json().data;
    expect(monitors.map((monitor: { name: string }) => monitor.name)).toEqual([
      'One',
      'Two',
      'Three',
    ]);
  });

  it('filters monitors by name or URL, case-insensitively', async () => {
    app = await buildApp({ databasePath: ':memory:' });
    await create({ name: 'Production API', url: 'https://api.example.com/health' });
    await create({ name: 'Website', url: 'https://pulse.example.com/status' });
    await create({ name: 'Development API', url: 'https://dev.example.com/health' });

    const names = async (query: string) =>
      (await app!.inject(`/api/v1/monitors?q=${query}`)).json().data.map((m: { name: string }) =>
        m.name,
      );

    expect(await names('api')).toEqual(['Production API', 'Development API']);
    expect(await names('PULSE.EXAMPLE.COM')).toEqual(['Website']);
  });

  it('treats an empty search query like an omitted search filter', async () => {
    app = await buildApp({ databasePath: ':memory:' });
    await create({ name: 'One', url: 'https://one.example' });
    await create({ name: 'Two', url: 'https://two.example' });

    expect((await app.inject('/api/v1/monitors?q=')).json().data).toEqual(
      (await app.inject('/api/v1/monitors')).json().data,
    );
  });

  it('gets a monitor by UUID', async () => {
    app = await buildApp({ databasePath: ':memory:' });
    const monitor = (await create()).json().data;
    const response = await app.inject(`/api/v1/monitors/${monitor.id}`);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ data: monitor });
  });
});

describe('monitor validation and errors', () => {
  it.each([
    ['bad URL', { name: 'x', url: 'ftp://example.com' }, ['url']],
    [
      'interval too low',
      { name: 'x', url: 'https://x.test', intervalSeconds: 29 },
      ['intervalSeconds'],
    ],
    ['unknown key', { name: 'x', url: 'https://x.test', extra: true }, ['']],
    ['client id', { name: 'x', url: 'https://x.test', id: 'not-allowed' }, ['']],
    [
      'client createdAt',
      { name: 'x', url: 'https://x.test', createdAt: '2026-01-01T00:00:00.000Z' },
      [''],
    ],
    ['client status', { name: 'x', url: 'https://x.test', status: 'up' }, ['']],
    [
      'client lastCheckedAt',
      { name: 'x', url: 'https://x.test', lastCheckedAt: '2026-01-01T00:00:00.000Z' },
      [''],
    ],
    [
      'HEAD keyword',
      { name: 'x', url: 'https://x.test', method: 'HEAD', keyword: 'body' },
      ['keyword'],
    ],
  ])('rejects %s with validation issue paths', async (_label, payload, expected) => {
    app = await buildApp({ databasePath: ':memory:' });
    const response = await create(payload);
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_ERROR');
    expect(paths(response)).toEqual(expect.arrayContaining(expected));
  });

  it('rejects malformed JSON with BAD_REQUEST', async () => {
    app = await buildApp({ databasePath: ':memory:' });
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/monitors',
      headers: { 'content-type': 'application/json' },
      payload: '{"name":',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('BAD_REQUEST');
  });

  it('rejects a non-JSON body with UNSUPPORTED_MEDIA_TYPE', async () => {
    app = await buildApp({ databasePath: ':memory:' });
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/monitors',
      headers: { 'content-type': 'text/plain' },
      payload: 'hello',
    });
    expect(response.statusCode).toBe(415);
    expect(response.json().error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
  });

  it('validates a body-less POST without content type as undefined (400 VALIDATION_ERROR)', async () => {
    app = await buildApp({ databasePath: ':memory:' });
    const response = await app.inject({ method: 'POST', url: '/api/v1/monitors' });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects an empty JSON body with BAD_REQUEST', async () => {
    app = await buildApp({ databasePath: ':memory:' });
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/monitors',
      headers: { 'content-type': 'application/json' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatchObject({
      code: 'BAD_REQUEST',
      message: 'Malformed JSON body',
    });
  });

  it('keeps 413 for oversized bodies instead of reporting 415', async () => {
    app = await buildApp({ databasePath: ':memory:' });
    const response = await json('POST', '/api/v1/monitors', `"${'a'.repeat(1_100_000)}"`);
    expect(response.statusCode).toBe(413);
    expect(response.json().error.code).toBe('BAD_REQUEST');
  });

  it('rejects a non-JSON PATCH body with UNSUPPORTED_MEDIA_TYPE', async () => {
    app = await buildApp({ databasePath: ':memory:' });
    const monitor = (await create()).json().data;
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/v1/monitors/${monitor.id}`,
      headers: { 'content-type': 'text/plain' },
      payload: 'hello',
    });
    expect(response.statusCode).toBe(415);
    expect(response.json().error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
  });

  it('hides internal error details in 500 responses', async () => {
    app = await buildProductionApp({
      databasePath: ':memory:',
      auth: {
        admin: { email: 'test-admin@example.com', password: 'test-password-that-is-long-enough' },
        sessionSecret: 't'.repeat(32),
        scryptParams: { N: 1024, r: 8, p: 1 },
      },
    });
    app.get('/boom', async () => {
      throw new Error('secret internals');
    });
    const response = await app.inject('/boom');
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
    });
  });

  it('returns NOT_FOUND for malformed and unknown IDs', async () => {
    app = await buildApp({ databasePath: ':memory:' });
    for (const id of ['not-a-uuid', '00000000-0000-4000-8000-000000000000']) {
      const response = await app.inject(`/api/v1/monitors/${id}`);
      expect(response.statusCode).toBe(404);
      expect(response.json().error.code).toBe('NOT_FOUND');
    }
  });

  it('gives unknown routes the NOT_FOUND envelope', async () => {
    app = await buildApp({ databasePath: ':memory:' });
    const response = await app.inject('/unknown-route');
    expect(response.statusCode).toBe(404);
    expect(response.json().error).toMatchObject({ code: 'NOT_FOUND', message: 'Route not found' });
  });
});

describe('monitor updates and deletion', () => {
  it('patches partially and persists the full updated monitor', async () => {
    app = await buildApp({ databasePath: ':memory:' });
    const original = (
      await create({ name: 'Old', url: 'https://old.example', keyword: 'old' })
    ).json().data;
    const response = await json('PATCH', `/api/v1/monitors/${original.id}`, {
      name: 'New',
      enabled: false,
    });
    const updated = response.json().data;
    expect(response.statusCode).toBe(200);
    expect(updated).toMatchObject({ ...original, name: 'New', enabled: false });
    expect((await app.inject(`/api/v1/monitors/${original.id}`)).json().data).toEqual(updated);
  });

  it('updates the public flag without resetting the monitor status', async () => {
    app = await buildApp({ databasePath: ':memory:' });
    const monitor = (await create()).json().data;
    const database = db().db;
    database
      .prepare("UPDATE monitors SET status='down', consecutive_failures=3 WHERE id=?")
      .run(monitor.id);
    const response = await json('PATCH', `/api/v1/monitors/${monitor.id}`, { public: true });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({ public: true, status: 'down' });
  });

  it('clears keyword when patched to null', async () => {
    app = await buildApp({ databasePath: ':memory:' });
    const monitor = (await create({ name: 'Keyword', url: 'https://x.test', keyword: 'x' })).json()
      .data;
    const response = await json('PATCH', `/api/v1/monitors/${monitor.id}`, { keyword: null });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.keyword).toBeNull();
  });

  it('increments config_version only when a target field changes', async () => {
    app = await buildApp({ databasePath: ':memory:' });
    const configVersion = (id: string) =>
      (
        db().db.prepare('SELECT config_version FROM monitors WHERE id = ?').get(id) as {
          config_version: number;
        }
      ).config_version;
    const targetPatches = [
      { url: 'https://other.example' },
      { method: 'POST' },
      { timeoutMs: 2000 },
      { expectedStatus: 201 },
      { keyword: 'healthy' },
    ];

    for (const patch of targetPatches) {
      const monitor = (await create()).json().data;
      expect(configVersion(monitor.id)).toBe(0);
      const response = await json('PATCH', `/api/v1/monitors/${monitor.id}`, patch);
      expect(response.statusCode).toBe(200);
      expect(response.json().data).not.toHaveProperty('configVersion');
      expect(configVersion(monitor.id)).toBe(1);
    }

    const monitor = (await create()).json().data;
    const response = await json('PATCH', `/api/v1/monitors/${monitor.id}`, {
      name: 'Renamed',
      intervalSeconds: 30,
      enabled: false,
      public: true,
    });
    expect(response.statusCode).toBe(200);
    expect(configVersion(monitor.id)).toBe(0);
  });

  it('rejects an empty patch', async () => {
    app = await buildApp({ databasePath: ':memory:' });
    const monitor = (await create()).json().data;
    const response = await json('PATCH', `/api/v1/monitors/${monitor.id}`, {});
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_ERROR');
    expect(paths(response)).toContain('');
  });

  it('rejects read-only status fields in a patch', async () => {
    app = await buildApp({ databasePath: ':memory:' });
    const post = await create({
      name: 'Example',
      url: 'https://example.com',
      status: 'up',
      lastCheckedAt: new Date().toISOString(),
    });
    expect(post.statusCode).toBe(400);
    const monitor = (await create()).json().data;
    const response = await json('PATCH', `/api/v1/monitors/${monitor.id}`, { status: 'up' });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_ERROR');
    const lastCheckedAt = await json('PATCH', `/api/v1/monitors/${monitor.id}`, {
      lastCheckedAt: new Date().toISOString(),
    });
    expect(lastCheckedAt.statusCode).toBe(400);
    expect(lastCheckedAt.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('validates HEAD keyword against the merged monitor', async () => {
    app = await buildApp({ databasePath: ':memory:' });
    const monitor = (await create({ name: 'Keyword', url: 'https://x.test', keyword: 'x' })).json()
      .data;
    const response = await json('PATCH', `/api/v1/monitors/${monitor.id}`, { method: 'HEAD' });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_ERROR');
    expect(paths(response)).toContain('keyword');
  });

  it('checks patch target existence before validating its body', async () => {
    app = await buildApp({ databasePath: ':memory:' });
    const response = await json('PATCH', '/api/v1/monitors/00000000-0000-4000-8000-000000000000', {
      unknown: true,
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('NOT_FOUND');
  });

  it('deletes a monitor and returns 404 afterward', async () => {
    app = await buildApp({ databasePath: ':memory:' });
    const monitor = (await create()).json().data;
    const deleted = await app.inject({ method: 'DELETE', url: `/api/v1/monitors/${monitor.id}` });
    expect(deleted.statusCode).toBe(204);
    expect(deleted.body).toBe('');
    expect((await app.inject(`/api/v1/monitors/${monitor.id}`)).statusCode).toBe(404);
  });

  it('returns 404 when deleting an unknown monitor', async () => {
    app = await buildApp({ databasePath: ':memory:' });
    const response = await app.inject({
      method: 'DELETE',
      url: '/api/v1/monitors/00000000-0000-4000-8000-000000000000',
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('NOT_FOUND');
  });

  it('cascades check results when deleting a monitor', async () => {
    app = await buildApp({ databasePath: ':memory:' });
    const monitor = (await create()).json().data;
    db()
      .db.prepare(
        'INSERT INTO check_results (id, monitor_id, checked_at, ok, latency_ms) VALUES (?, ?, ?, ?, ?)',
      )
      .run('result-1', monitor.id, monitor.createdAt, 1, 10);
    await app.inject({ method: 'DELETE', url: `/api/v1/monitors/${monitor.id}` });
    expect(
      db().db.prepare('SELECT * FROM check_results WHERE id = ?').get('result-1'),
    ).toBeUndefined();
  });
});
