import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp } from './helpers.js';
import type { FastifyInstance } from 'fastify';
let app: FastifyInstance;
afterEach(async () => {
  await app?.close();
});
describe('maintenance display', () => {
  it('always includes maintenance fields in public monitor and status payloads', async () => {
    app = await buildTestApp({ databasePath: ':memory:', scheduler: false });
    expect((await app.inject('/api/v1/monitors')).json().data).toEqual([]);
    const page = (await app.inject('/api/v1/status')).json().data;
    expect(page).toHaveProperty('upcomingMaintenance');
  });
});
