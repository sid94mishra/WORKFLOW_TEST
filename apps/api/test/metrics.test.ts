import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { FastifyInstance } from 'fastify';
let app: FastifyInstance;
afterEach(async () => {
  await app?.close();
});
describe('metrics', () => {
  it('requires auth by default and emits Prometheus content when public', async () => {
    app = await buildApp({
      databasePath: ':memory:',
      scheduler: false,
      auth: {
        admin: { email: 'a@example.test', password: 'x'.repeat(12) },
        sessionSecret: 'x'.repeat(32),
        scryptParams: { N: 1024, r: 8, p: 1 },
      },
    });
    const denied = await app.inject('/metrics');
    expect(denied.statusCode).toBe(401);
    expect(denied.headers['www-authenticate']).toBe('Bearer realm="pulse"');
    await app.close();
    app = await buildApp({
      databasePath: ':memory:',
      scheduler: false,
      metricsPublic: true,
      auth: {
        admin: { email: 'a@example.test', password: 'x'.repeat(12) },
        sessionSecret: 'x'.repeat(32),
        scryptParams: { N: 1024, r: 8, p: 1 },
      },
    });
    const response = await app.inject('/metrics');
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/plain; version=0.0.4; charset=utf-8');
    expect(response.body).toMatch(/^# HELP pulse_monitor_up/m);
  });
});
