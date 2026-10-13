import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp } from './helpers.js';
import type { FastifyInstance } from 'fastify';
let app: FastifyInstance;
afterEach(async () => {
  await app?.close();
});
describe('maintenance routes', () => {
  it('creates, validates, updates and deletes a maintenance window', async () => {
    app = await buildTestApp({ databasePath: ':memory:', scheduler: false });
    const body = {
      title: 'work',
      monitorIds: 'all',
      startsAt: '2026-10-13T10:00:00.000Z',
      endsAt: '2026-10-13T10:30:00.000Z',
      repeat: null,
    };
    const made = await app.inject({ method: 'POST', url: '/api/v1/maintenance', payload: body });
    expect(made.statusCode).toBe(201);
    expect(made.headers.location).toMatch(/maintenance/);
    const id = made.json().data.id;
    const updated = await app.inject({
      method: 'PATCH',
      url: `/api/v1/maintenance/${id}`,
      payload: { title: 'renamed' },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().data.title).toBe('renamed');
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/api/v1/maintenance/${id}`,
          payload: { endsAt: '2026-10-13T09:00:00.000Z' },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await app.inject({ method: 'DELETE', url: `/api/v1/maintenance/${id}` })).statusCode,
    ).toBe(204);
    expect((await app.inject(`/api/v1/maintenance/${id}`)).statusCode).toBe(404);
  });
});
