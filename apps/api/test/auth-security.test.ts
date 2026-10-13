import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { API_KEY_PATTERN, SessionInfoSchema } from '@pulse/shared';
import { buildApp } from '../src/app.js';
import { readConfig } from '../src/config.js';
import { openDatabase } from '../src/db.js';
import { start } from '../src/server.js';
import { LoginRateLimiter } from '../src/auth/rate-limit.js';
import { SessionStore } from '../src/auth/sessions.js';
import * as passwordModule from '../src/auth/password.js';

const PASSWORD = 'a-qa-password-that-is-not-a-secret';
const PARAMS = { N: 1024, r: 8, p: 1 };
const SECRET = 's'.repeat(32);
const dbOf = (app: FastifyInstance) =>
  (app as FastifyInstance & { db: ReturnType<typeof openDatabase> }).db;

const apps: FastifyInstance[] = [];
const tempDirs: string[] = [];

async function makeApp(
  databasePath = ':memory:',
  auth: {
    admin?: { email: string; password: string };
    sessionSecret?: string;
    cookieSecure?: 'auto' | boolean;
  } = {
    admin: { email: 'Admin@Example.com', password: PASSWORD },
    sessionSecret: SECRET,
  },
  extra: Record<string, unknown> = {},
) {
  const app = await buildApp({ databasePath, auth: { ...auth, scryptParams: PARAMS }, ...extra });
  apps.push(app);
  return app;
}

function cookieFrom(response: { headers: Record<string, unknown> }) {
  const value = response.headers['set-cookie'];
  return String(Array.isArray(value) ? value[0] : value).split(';', 1)[0]!;
}

async function login(app: FastifyInstance, password = PASSWORD, email = 'admin@example.com') {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email, password },
  });
  return { response, cookie: cookieFrom(response), body: response.json().data };
}

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const app of apps.splice(0)) await app.close();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('admin bootstrap, secrets, and sessions', () => {
  it('keeps default-deny enabled even when buildApp receives no auth options', async () => {
    const app = await buildApp({ databasePath: ':memory:', scheduler: false });
    apps.push(app);
    expect((await app.inject('/api/v1/monitors')).statusCode).toBe(401);
    expect((await app.inject('/health')).statusCode).toBe(200);
  });

  it('creates one lower-case admin and preserves the original hash across restarts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pulse-auth-'));
    tempDirs.push(dir);
    const path = join(dir, 'pulse.db');
    const first = await makeApp(path);
    expect(first.adminBootstrap).toBe('created');
    const firstDb = dbOf(first);
    const user = firstDb.prepare('SELECT email, password_hash FROM users').get() as {
      email: string;
      password_hash: string;
    };
    expect(user.email).toBe('admin@example.com');
    expect(user.password_hash).toMatch(/^scrypt\$/);
    expect(user.password_hash).not.toContain(PASSWORD);
    await first.close();
    apps.splice(apps.indexOf(first), 1);

    const second = await makeApp(path, {
      admin: { email: 'different@example.com', password: 'another-password-that-is-long' },
      sessionSecret: SECRET,
    });
    expect(second.adminBootstrap).toBe('exists');
    const rows = dbOf(second)
      .prepare('SELECT email, password_hash FROM users')
      .all() as (typeof user)[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(user);
  });

  it('reports missing bootstrap credentials and server exits one', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pulse-missing-'));
    tempDirs.push(dir);
    const exit = vi.fn();
    const app = await start({ env: { DATABASE_PATH: join(dir, 'pulse.db') }, exit });
    expect(app.adminBootstrap).toBe('missing');
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('does not put the admin password in database text columns or validation errors', async () => {
    const password = 'password-never-to-be-logged-or-stored';
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        lines.push(String(chunk));
        callback();
      },
    });
    const app = await buildApp({
      databasePath: ':memory:',
      logger: { level: 'info', stream },
      auth: {
        admin: { email: 'admin@example.com', password },
        sessionSecret: SECRET,
        scryptParams: PARAMS,
      },
    });
    apps.push(app);
    await login(app, password);
    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'unknown@example.com', password },
    });
    const db = dbOf(app);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all() as { name: string }[];
    for (const { name } of tables) {
      const columns = db.prepare(`PRAGMA table_info(${name})`).all() as {
        name: string;
        type: string;
      }[];
      for (const column of columns.filter((entry) => /char|clob|text/i.test(entry.type))) {
        const values = db.prepare(`SELECT "${column.name}" AS value FROM "${name}"`).all() as {
          value: unknown;
        }[];
        expect(
          values.some((entry) => typeof entry.value === 'string' && entry.value.includes(password)),
        ).toBe(false);
      }
    }
    expect(() => readConfig({ PULSE_ADMIN_PASSWORD: password })).toThrow('set together');
    expect(() => readConfig({ PULSE_ADMIN_PASSWORD: password })).toThrowError(
      new RegExp(`^(?!.*${password})`),
    );
    expect(lines.join('')).not.toContain(password);
  });

  it('sets signed session cookie attributes, rejects tampering, and supports secure proxy detection', async () => {
    const app = await makeApp(':memory:', {
      admin: { email: 'admin@example.com', password: PASSWORD },
      sessionSecret: SECRET,
    });
    const plain = await login(app);
    expect(SessionInfoSchema.safeParse(plain.response.json().data).success).toBe(true);
    expect(plain.response.headers['set-cookie']).toMatch(/HttpOnly/);
    expect(plain.response.headers['set-cookie']).toMatch(/SameSite=Lax/);
    expect(plain.response.headers['set-cookie']).toMatch(/Path=\//);
    expect(plain.response.headers['set-cookie']).toMatch(/Max-Age=604800/);
    expect(plain.response.headers['set-cookie']).not.toMatch(/Secure/);
    const tampered = plain.cookie.replace(/.$/, (char) => (char === 'a' ? 'b' : 'a'));
    expect(app.unsignCookie(plain.cookie.split('=', 2)[1]!).valid).toBe(true);
    expect(
      (await app.inject({ url: '/api/v1/monitors', headers: { cookie: tampered } })).statusCode,
    ).toBe(401);
    const db = dbOf(app);
    const stored = db.prepare('SELECT id_hash FROM sessions').get() as { id_hash: string };
    expect(stored.id_hash).not.toContain(plain.cookie.split('=')[1]);
    expect(stored.id_hash).toMatch(/^[0-9a-f]{64}$/);

    const secure = await makeApp(
      ':memory:',
      { admin: { email: 'admin@example.com', password: PASSWORD }, sessionSecret: SECRET },
      { trustProxy: true },
    );
    const secureLogin = await secure.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { 'x-forwarded-proto': 'https' },
      payload: { email: 'admin@example.com', password: PASSWORD },
    });
    expect(secureLogin.headers['set-cookie']).toMatch(/Secure/);
    const forced = await makeApp(':memory:', {
      admin: { email: 'admin@example.com', password: PASSWORD },
      sessionSecret: SECRET,
      cookieSecure: true,
    });
    expect((await login(forced)).response.headers['set-cookie']).toMatch(/Secure/);
  });

  it('logs out, deletes the row, and expires the browser cookie', async () => {
    const app = await makeApp();
    const session = await login(app);
    const out = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { cookie: session.cookie, 'x-pulse-csrf': session.body.csrfToken },
    });
    expect(out.statusCode).toBe(204);
    expect(out.headers['set-cookie']).toMatch(/Max-Age=0/);
    expect(dbOf(app).prepare('SELECT COUNT(*) AS count FROM sessions').get()).toEqual({ count: 0 });
    expect(
      (await app.inject({ url: '/api/v1/monitors', headers: { cookie: session.cookie } }))
        .statusCode,
    ).toBe(401);
  });

  it('enforces the absolute seven-day expiry and persists generated secrets across restarts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pulse-session-'));
    tempDirs.push(dir);
    const path = join(dir, 'pulse.db');
    const created = new Date('2026-01-01T00:00:00.000Z');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(created);
    const first = await makeApp(path, {
      admin: { email: 'admin@example.com', password: PASSWORD },
    });
    const session = await login(first);
    vi.setSystemTime(created.getTime() + 7 * 24 * 60 * 60 * 1000 - 1000);
    expect(
      (await first.inject({ url: '/api/v1/monitors', headers: { cookie: session.cookie } }))
        .statusCode,
    ).toBe(200);
    await first.close();
    apps.splice(apps.indexOf(first), 1);
    const restarted = await makeApp(path, {
      admin: { email: 'ignored@example.com', password: PASSWORD },
    });
    expect(
      (await restarted.inject({ url: '/api/v1/monitors', headers: { cookie: session.cookie } }))
        .statusCode,
    ).toBe(200);
    await restarted.close();
    apps.splice(apps.indexOf(restarted), 1);
    const differentBeforeExpiry = await makeApp(path, {
      admin: { email: 'ignored@example.com', password: PASSWORD },
      sessionSecret: 'd'.repeat(32),
    });
    expect(
      (
        await differentBeforeExpiry.inject({
          url: '/api/v1/monitors',
          headers: { cookie: session.cookie },
        })
      ).statusCode,
    ).toBe(401);
    await differentBeforeExpiry.close();
    apps.splice(apps.indexOf(differentBeforeExpiry), 1);
    const resumed = await makeApp(path, {
      admin: { email: 'ignored@example.com', password: PASSWORD },
    });
    vi.setSystemTime(created.getTime() + 7 * 24 * 60 * 60 * 1000);
    expect(
      (await resumed.inject({ url: '/api/v1/monitors', headers: { cookie: session.cookie } }))
        .statusCode,
    ).toBe(401);
    expect(dbOf(resumed).prepare('SELECT COUNT(*) AS count FROM sessions').get()).toEqual({
      count: 0,
    });
  });
});

describe('login timing and rate limiting', () => {
  it('uses one verifier call for both unknown and wrong-password failures', async () => {
    const app = await makeApp();
    const verify = vi.spyOn(passwordModule, 'verifyPassword').mockResolvedValue(false);
    const unknown = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'unknown@example.com', password: PASSWORD },
    });
    const wrong = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'admin@example.com', password: PASSWORD },
    });
    expect(unknown.statusCode).toBe(401);
    expect(wrong.statusCode).toBe(401);
    expect(unknown.body).toBe(wrong.body);
    expect(verify).toHaveBeenCalledTimes(2);
    expect(verify.mock.calls[0]?.[0]).toBe(verify.mock.calls[1]?.[0]);
  });

  it('does not hash a blocked request, keeps other buckets available, and resets on success', async () => {
    const app = await makeApp();
    const verify = vi.spyOn(passwordModule, 'verifyPassword');
    for (let i = 0; i < 5; i++) {
      const result = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        remoteAddress: '10.0.0.1',
        payload: { email: 'admin@example.com', password: 'wrong-password' },
      } as never);
      expect(result.statusCode).toBe(401);
    }
    const callsBeforeLimit = verify.mock.calls.length;
    const limited = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      remoteAddress: '10.0.0.1',
      payload: { email: 'admin@example.com', password: PASSWORD },
    } as never);
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toMatch(/^[1-9]/);
    expect(verify).toHaveBeenCalledTimes(callsBeforeLimit);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/auth/login',
          remoteAddress: '10.0.0.2',
          payload: { email: 'admin@example.com', password: PASSWORD },
        } as never)
      ).statusCode,
    ).toBe(200);
    const limiter = new LoginRateLimiter();
    vi.useFakeTimers();
    for (let i = 0; i < 5; i++) limiter.recordFailure('a');
    expect(limiter.check('a')).toMatchObject({ allowed: false });
    const retry = limiter.check('a');
    vi.advanceTimersByTime(900_001);
    expect(limiter.check('a')).toEqual({ allowed: true });
    expect(retry.allowed).toBe(false);
    for (let i = 0; i < 10_001; i++) limiter.recordFailure(`key-${i}`);
    expect(limiter.size).toBeLessThanOrEqual(10_000);
  });
});

describe('API key storage, authorization, and CSRF', () => {
  it('creates hashed one-time keys, throttles last-used writes, and enforces CSRF', async () => {
    const app = await makeApp();
    const session = await login(app);
    const missingCsrf = await app.inject({
      method: 'POST',
      url: '/api/v1/monitors',
      headers: { cookie: session.cookie },
      payload: { name: 'x', url: 'https://example.com' },
    });
    expect(missingCsrf.json().error.code).toBe('CSRF_FAILED');
    const wrongCsrf = await app.inject({
      method: 'POST',
      url: '/api/v1/monitors',
      headers: { cookie: session.cookie, 'x-pulse-csrf': 'different-length' },
      payload: { name: 'x', url: 'https://example.com' },
    });
    expect(wrongCsrf.json().error.code).toBe('CSRF_FAILED');
    const correctCsrf = await app.inject({
      method: 'POST',
      url: '/api/v1/monitors',
      headers: { cookie: session.cookie, 'x-pulse-csrf': session.body.csrfToken },
      payload: { name: 'csrf', url: 'https://example.com' },
    });
    expect(correctCsrf.statusCode).toBe(201);
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/api-keys',
      headers: { cookie: session.cookie, 'x-pulse-csrf': session.body.csrfToken },
      payload: { name: 'CI' },
    });
    expect(created.statusCode).toBe(201);
    const first = created.json().data;
    expect(first.key).toMatch(API_KEY_PATTERN);
    expect(first.prefix).toBe(first.key.slice(0, 12));
    const db = dbOf(app);
    const row = db.prepare('SELECT key_hash, name, scope FROM api_keys').get() as {
      key_hash: string;
      name: string;
      scope: string;
    };
    expect(row).toEqual({
      key_hash: createHash('sha256').update(first.key).digest('hex'),
      name: 'CI',
      scope: 'read',
    });
    expect(JSON.stringify(row)).not.toContain(first.key);
    const list = await app.inject({ url: '/api/v1/api-keys', headers: { cookie: session.cookie } });
    expect(list.body).not.toContain(first.key);
    expect(
      (
        await app.inject({
          url: `/api/v1/api-keys/${first.id}`,
          headers: { cookie: session.cookie },
        })
      ).body,
    ).not.toContain(first.key);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/api-keys',
          headers: { cookie: session.cookie, 'x-pulse-csrf': session.body.csrfToken },
          payload: { name: 'x', extra: true },
        })
      ).statusCode,
    ).toBe(400);

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    expect(
      (
        await app.inject({
          url: '/api/v1/monitors',
          headers: { authorization: `Bearer ${first.key}` },
        })
      ).statusCode,
    ).toBe(200);
    const atStart = db.prepare('SELECT last_used_at FROM api_keys').get() as {
      last_used_at: string;
    };
    vi.advanceTimersByTime(30_000);
    await app.inject({
      url: '/api/v1/monitors',
      headers: { authorization: `Bearer ${first.key}` },
    });
    expect(
      (db.prepare('SELECT last_used_at FROM api_keys').get() as { last_used_at: string })
        .last_used_at,
    ).toBe(atStart.last_used_at);
    vi.advanceTimersByTime(31_000);
    await app.inject({
      url: '/api/v1/monitors',
      headers: { authorization: `Bearer ${first.key}` },
    });
    expect(
      (db.prepare('SELECT last_used_at FROM api_keys').get() as { last_used_at: string })
        .last_used_at,
    ).not.toBe(atStart.last_used_at);
  });

  it('protects every registered API route by default and preserves public routes', async () => {
    const routes: { method: string | string[]; url: string; config?: Record<string, unknown> }[] =
      [];
    const app = await makeApp(
      ':memory:',
      { admin: { email: 'Admin@Example.com', password: PASSWORD }, sessionSecret: SECRET },
      {
        onRoute: (route: {
          method: string | string[];
          url: string;
          config?: Record<string, unknown>;
        }) => routes.push(route),
      },
    );
    const protectedRoutes = routes.filter((route) => {
      const methods = Array.isArray(route.method) ? route.method : [route.method];
      return (
        methods.some((method) => method !== 'HEAD') &&
        (route.url.startsWith('/api/v1/') || route.url === '/metrics') &&
        route.config?.public !== true
      );
    });
    expect(protectedRoutes.length).toBeGreaterThan(10);
    for (const route of protectedRoutes) {
      const method = Array.isArray(route.method)
        ? route.method.find((entry) => entry !== 'HEAD')!
        : route.method;
      const path = route.url.replaceAll(
        /\/:([A-Za-z0-9_]+)/g,
        '/00000000-0000-4000-8000-000000000001',
      );
      const response = await app.inject({
        method,
        url: path,
        payload: method === 'GET' ? undefined : {},
      } as never);
      expect(response.statusCode, `${method} ${path}`).toBe(401);
      expect(response.json().error.code).toBe('UNAUTHORIZED');
    }
    expect((await app.inject('/api/v1/unknown')).statusCode).toBe(401);
    expect((await app.inject('/health')).statusCode).toBe(200);
    expect((await app.inject('/status')).statusCode).toBe(200);
    expect((await app.inject('/api/v1/status')).statusCode).toBe(200);
  });

  it('cannot be bypassed with percent-encoded API paths', async () => {
    const app = await makeApp();
    for (const url of ['/%61pi/v1/monitors', '/%61%70%69/v1/channels', '/api/v1/%6Donitors']) {
      expect((await app.inject(url)).statusCode, url).toBe(401);
    }
    const write = await app.inject({
      method: 'POST',
      url: '/%61pi/v1/monitors',
      payload: { name: 'x', url: 'https://example.com' },
    });
    expect(write.statusCode).toBe(401);
    expect(dbOf(app).prepare('SELECT COUNT(*) AS n FROM monitors').get()).toEqual({ n: 0 });
  });

  it('rejects malformed, revoked, and session-management bearer credentials', async () => {
    const app = await makeApp();
    const session = await login(app);
    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/api-keys',
      headers: { cookie: session.cookie, 'x-pulse-csrf': session.body.csrfToken },
      payload: { name: 'key', scope: 'write' },
    });
    const key = create.json().data.key as string;
    for (const authorization of [
      'Bearer',
      'Bearer abc',
      'Basic abc',
      'Bearer pulse_' + 'a'.repeat(43),
    ]) {
      expect(
        (await app.inject({ url: '/api/v1/monitors', headers: { authorization } })).statusCode,
      ).toBe(401);
    }
    expect(
      (
        await app.inject({
          url: '/api/v1/auth/session',
          headers: { authorization: `Bearer ${key}` },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          url: '/api/v1/monitors',
          headers: { authorization: `Bearer ${key}`, cookie: session.cookie },
        })
      ).statusCode,
    ).toBe(200);
    const revoked = await app.inject({
      method: 'DELETE',
      url: `/api/v1/api-keys/${create.json().data.id}`,
      headers: { cookie: session.cookie, 'x-pulse-csrf': session.body.csrfToken },
    });
    expect(revoked.statusCode).toBe(204);
    expect(
      (await app.inject({ url: '/api/v1/monitors', headers: { authorization: `Bearer ${key}` } }))
        .statusCode,
    ).toBe(401);
    expect(
      (await app.inject({ url: '/api/v1/api-keys', headers: { cookie: session.cookie } })).body,
    ).not.toContain(key);
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: `/api/v1/api-keys/${create.json().data.id}`,
          headers: { cookie: session.cookie, 'x-pulse-csrf': session.body.csrfToken },
        })
      ).statusCode,
    ).toBe(404);
  });

  it('keeps read keys read-only without writes and allows write-key CRUD', async () => {
    const app = await makeApp();
    const session = await login(app);
    const createKey = async (scope: 'read' | 'write') => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/api-keys',
        headers: { cookie: session.cookie, 'x-pulse-csrf': session.body.csrfToken },
        payload: { name: scope, scope },
      });
      return response.json().data.key as string;
    };
    const readKey = await createKey('read');
    const readHeaders = { authorization: `Bearer ${readKey}` };
    const before = dbOf(app).prepare('SELECT COUNT(*) AS count FROM monitors').get();
    for (const request of [
      {
        method: 'POST',
        url: '/api/v1/monitors',
        payload: { name: 'read', url: 'https://example.com' },
      },
      {
        method: 'PATCH',
        url: '/api/v1/monitors/00000000-0000-4000-8000-000000000001',
        payload: { name: 'read' },
      },
      { method: 'DELETE', url: '/api/v1/monitors/00000000-0000-4000-8000-000000000001' },
      {
        method: 'POST',
        url: '/api/v1/channels',
        payload: { name: 'read', kind: 'webhook', url: 'https://example.com/hook' },
      },
      {
        method: 'PATCH',
        url: '/api/v1/channels/00000000-0000-4000-8000-000000000001',
        payload: { name: 'read' },
      },
      { method: 'DELETE', url: '/api/v1/channels/00000000-0000-4000-8000-000000000001' },
      { method: 'POST', url: '/api/v1/channels/00000000-0000-4000-8000-000000000001/test' },
    ]) {
      expect((await app.inject({ ...request, headers: readHeaders } as never)).statusCode).toBe(
        403,
      );
    }
    expect(dbOf(app).prepare('SELECT COUNT(*) AS count FROM monitors').get()).toEqual(before);
    expect((await app.inject({ url: '/api/v1/api-keys', headers: readHeaders })).statusCode).toBe(
      403,
    );

    const writeKey = await createKey('write');
    const writeHeaders = { authorization: `Bearer ${writeKey}` };
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/monitors',
      headers: writeHeaders,
      payload: { name: 'write', url: 'https://example.com' },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().data.id as string;
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/api/v1/monitors/${id}`,
          headers: writeHeaders,
          payload: { name: 'updated' },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ method: 'DELETE', url: `/api/v1/monitors/${id}`, headers: writeHeaders }))
        .statusCode,
    ).toBe(204);
  });
});

describe('SessionStore and LoginRateLimiter primitives', () => {
  it('prunes only expired sessions and uses sha256 identifiers', async () => {
    const app = await makeApp();
    const store = new SessionStore(dbOf(app));
    const session = store.create(
      (dbOf(app).prepare('SELECT id FROM users LIMIT 1').get() as { id: string }).id,
    );
    expect(dbOf(app).prepare('SELECT id_hash FROM sessions').get()).toEqual({
      id_hash: createHash('sha256').update(session.id).digest('hex'),
    });
    expect(store.lookup(session.id)).toMatchObject({ id: expect.any(String) });
    store.close();
  });
});
