import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { API_KEY_PATTERN } from '@pulse/shared';
import { buildApp } from '../src/app.js';

const password = 'not-a-real-password';
async function appWithAdmin(): Promise<FastifyInstance> {
  return buildApp({
    databasePath: ':memory:',
    auth: {
      admin: { email: 'ADMIN@Example.test', password },
      sessionSecret: 'x'.repeat(32),
      scryptParams: { N: 1024, r: 8, p: 1 },
    },
  });
}
async function login(app: FastifyInstance) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email: 'admin@example.test', password },
  });
  const setCookie = response.headers['set-cookie'];
  return {
    response,
    cookie: (Array.isArray(setCookie) ? setCookie[0]! : setCookie!).split(';')[0]!,
    csrfToken: response.json().data.csrfToken as string,
  };
}

describe('authentication and API keys', () => {
  let app: FastifyInstance;
  afterEach(async () => {
    await app?.close();
  });

  it('bootstraps an administrator and issues a signed session', async () => {
    app = await appWithAdmin();
    expect(app.adminBootstrap).toBe('created');
    const result = await login(app);
    expect(result.response.statusCode).toBe(200);
    expect(result.response.headers['set-cookie']).toContain('HttpOnly');
    expect(result.response.headers['set-cookie']).toContain('SameSite=Lax');
    expect(
      await app.inject({ url: '/api/v1/monitors', headers: { cookie: result.cookie } }),
    ).toHaveProperty('statusCode', 200);
    expect((await app.inject('/api/v1/monitors')).statusCode).toBe(401);
  });

  it('returns identical login failures and rate limits after five failures', async () => {
    app = await appWithAdmin();
    const unknown = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'none@example.test', password },
    });
    const wrong = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'admin@example.test', password: 'wrong' },
    });
    expect(unknown.body).toBe(wrong.body);
    for (let i = 0; i < 5; i++)
      await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: 'rate@example.test', password },
      });
    const limited = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'rate@example.test', password },
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBeDefined();
  });

  it('creates one-time keys and applies scopes', async () => {
    app = await appWithAdmin();
    const session = await login(app);
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/api-keys',
      headers: { cookie: session.cookie, 'x-pulse-csrf': session.csrfToken },
      payload: { name: 'CI' },
    });
    expect(created.statusCode).toBe(201);
    const key = created.json().data.key as string;
    expect(key).toMatch(API_KEY_PATTERN);
    const headers = { authorization: `Bearer ${key}` };
    expect((await app.inject({ url: '/api/v1/monitors', headers })).statusCode).toBe(200);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/monitors',
          headers,
          payload: { name: 'x', url: 'https://x.test' },
        })
      ).statusCode,
    ).toBe(403);
  });
});
