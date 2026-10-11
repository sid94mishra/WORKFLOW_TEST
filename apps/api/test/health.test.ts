import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';

const { version } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { version: string };

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('GET /health', () => {
  it('returns status, the package version and integer uptime', async () => {
    app = await buildApp({ databasePath: ':memory:' });
    const response = await app.inject('/health');
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toEqual({ status: 'ok', version, uptimeSeconds: expect.any(Number) });
    expect(Number.isInteger(body.uptimeSeconds)).toBe(true);
  });

  it('returns 503 INTERNAL_ERROR when the database is unusable', async () => {
    app = await buildApp({ databasePath: ':memory:' });
    (app as FastifyInstance & { db: { close(): void } }).db.close();
    const response = await app.inject('/health');
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe('INTERNAL_ERROR');
  });
});
