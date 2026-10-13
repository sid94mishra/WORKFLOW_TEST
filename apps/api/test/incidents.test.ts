import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { IncidentSchema } from '@pulse/shared';
import { buildTestApp as buildApp } from './helpers.js';

let app: FastifyInstance | undefined;
const json = (method: 'POST', url: string, payload: unknown) =>
  app!.inject({
    method,
    url,
    headers: { 'content-type': 'application/json' },
    payload: payload as any,
  });
afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('incident routes', () => {
  it('orders, filters, limits, validates, and returns incident schemas', async () => {
    app = await buildApp({ databasePath: ':memory:' });
    const monitor = (
      await json('POST', '/api/v1/monitors', { name: 'Example', url: 'https://example.test' })
    ).json().data;
    const other = (
      await json('POST', '/api/v1/monitors', { name: 'Other', url: 'https://other.test' })
    ).json().data;
    const db = (app as FastifyInstance & { db: any }).db;
    const insert = db.prepare(
      'INSERT INTO incidents (id,monitor_id,status,cause,started_at,resolved_at,duration_seconds) VALUES (?,?,?,?,?,?,?)',
    );
    insert.run(
      '00000000-0000-4000-8000-000000000001',
      monitor.id,
      'resolved',
      'old',
      '2026-10-09T00:00:00.000Z',
      '2026-10-09T00:02:00.000Z',
      120,
    );
    insert.run(
      '00000000-0000-4000-8000-000000000002',
      monitor.id,
      'open',
      'new',
      '2026-10-11T00:00:00.000Z',
      null,
      null,
    );
    insert.run(
      '00000000-0000-4000-8000-000000000003',
      other.id,
      'open',
      'other',
      '2026-10-10T00:00:00.000Z',
      null,
      null,
    );
    const response = await app.inject('/api/v1/incidents?limit=2');
    expect(response.statusCode).toBe(200);
    const data = response.json().data;
    expect(data.map((x: { id: string }) => x.id)).toEqual([
      '00000000-0000-4000-8000-000000000002',
      '00000000-0000-4000-8000-000000000003',
    ]);
    expect(data.every((x: unknown) => IncidentSchema.safeParse(x).success)).toBe(true);
    expect(
      (await app.inject('/api/v1/incidents?status=resolved&monitorId=' + monitor.id)).json().data,
    ).toHaveLength(1);
    expect(
      (await app.inject('/api/v1/incidents?monitorId=00000000-0000-4000-8000-000000000099')).json(),
    ).toEqual({ data: [] });
    for (const query of ['status=bad', 'monitorId=bad', 'limit=0', 'limit=201', 'limit=nope']) {
      const invalid = await app.inject(`/api/v1/incidents?${query}`);
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json().error.issues[0].path).toEqual([query.split('=')[0]]);
    }
  });

  it('gets incidents and returns the same 404 envelope for unknown and malformed ids', async () => {
    app = await buildApp({ databasePath: ':memory:' });
    const ids = ['not-a-uuid', '00000000-0000-4000-8000-000000000099'];
    const responses = await Promise.all(ids.map((id) => app!.inject(`/api/v1/incidents/${id}`)));
    expect(responses.map((r) => [r.statusCode, r.body])).toEqual([
      [404, responses[0]!.body],
      [404, responses[1]!.body],
    ]);
    expect((await app.inject('/api/v1/incidents')).json()).toEqual({ data: [] });
  });
});
