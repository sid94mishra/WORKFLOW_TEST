import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';

let app: FastifyInstance | undefined;
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const payload = (name: string, url = 'https://hooks.test/hook', monitorIds: string[] = []) => ({
  name,
  kind: 'webhook',
  url,
  monitorIds,
});
const makeApp = async (
  fetch: typeof globalThis.fetch = vi.fn(async () => new Response(null, { status: 204 })),
) =>
  buildApp({
    databasePath: ':memory:',
    egress: {
      resolveHost: async () => [{ address: '203.0.113.10', family: 4 }],
      fetch: fetch as never,
    },
  });
const createMonitor = async (name = 'Example') =>
  (
    await app!.inject({
      method: 'POST',
      url: '/api/v1/monitors',
      headers: { 'content-type': 'application/json' },
      payload: { name, url: 'https://monitor.test' },
    })
  ).json().data;
afterEach(async () => {
  await app?.close();
  app = undefined;
  vi.restoreAllMocks();
});

describe('notification channel routes', () => {
  it('supports CRUD, subscription replacement, strict bodies, test delivery, and cascades', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response(null, { status: 204 }));
    app = await makeApp(fetch);
    const monitor = await createMonitor();
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/channels',
      headers: { 'content-type': 'application/json' },
      payload: payload('Ops', undefined, [monitor.id, monitor.id]),
    });
    expect(created.statusCode).toBe(201);
    expect(created.headers.location).toBe(`/api/v1/channels/${created.json().data.id}`);
    const channel = created.json().data;
    expect(channel.monitorIds).toEqual([monitor.id]);
    expect((await app.inject('/api/v1/channels')).json().data).toHaveLength(1);
    expect((await app.inject(`/api/v1/channels/${channel.id}`)).json().data).toEqual(channel);

    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/v1/channels/${channel.id}`,
      headers: { 'content-type': 'application/json' },
      payload: { enabled: false, monitorIds: [] },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().data).toMatchObject({ enabled: false, monitorIds: [] });
    for (const body of [
      { id: id(98) },
      { createdAt: new Date().toISOString() },
      { monitorIds: [id(99)] },
    ]) {
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/v1/channels/${channel.id}`,
        headers: { 'content-type': 'application/json' },
        payload: body,
      });
      expect(response.statusCode).toBe(400);
      if ('monitorIds' in body)
        expect(response.json().error.issues[0].path).toEqual(['monitorIds', 0]);
    }
    const test = await app.inject({ method: 'POST', url: `/api/v1/channels/${channel.id}/test` });
    expect(test.statusCode).toBe(200);
    expect(test.json().data).toMatchObject({
      event: 'test',
      ok: true,
      statusCode: 204,
      attempt: 1,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    const recorded = (await app.inject(`/api/v1/channels/${channel.id}/deliveries`)).json().data;
    expect(recorded).toHaveLength(1);
    expect(recorded[0].id).toBe(test.json().data.id);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/channels/00000000-0000-4000-8000-000000000099/test',
        })
      ).statusCode,
    ).toBe(404);
    const db = (app as FastifyInstance & { db: any }).db;
    expect(
      (await app.inject({ method: 'DELETE', url: `/api/v1/channels/${channel.id}` })).statusCode,
    ).toBe(204);
    expect(
      db
        .prepare('SELECT count(*) AS count FROM delivery_attempts WHERE channel_id=?')
        .get(channel.id),
    ).toEqual({ count: 0 });
    expect((await app.inject(`/api/v1/channels/${channel.id}`)).statusCode).toBe(404);
    expect((await app.inject(`/api/v1/channels/${channel.id}/deliveries`)).statusCode).toBe(404);
  });

  it('validates monitor ids, media types, URL policy, and keeps delivery history to 20', async () => {
    app = await makeApp();
    const badMonitor = await app.inject({
      method: 'POST',
      url: '/api/v1/channels',
      headers: { 'content-type': 'application/json' },
      payload: payload('Bad', undefined, [id(99)]),
    });
    expect(badMonitor.statusCode).toBe(400);
    expect(badMonitor.json().error.issues[0].path).toEqual(['monitorIds', 0]);
    const unsupported = await app.inject({
      method: 'POST',
      url: '/api/v1/channels',
      headers: { 'content-type': 'text/plain' },
      payload: 'x',
    });
    expect(unsupported.statusCode).toBe(415);
    for (const url of [
      'http://127.0.0.1/hook',
      'http://169.254.169.254/',
      'http://[::ffff:10.0.0.1]/',
    ]) {
      const blocked = await app.inject({
        method: 'POST',
        url: '/api/v1/channels',
        headers: { 'content-type': 'application/json' },
        payload: payload('Blocked', url),
      });
      expect(blocked.statusCode).toBe(400);
      expect(blocked.json().error.issues[0].path).toEqual(['url']);
      expect(blocked.json().error.issues[0].message).toContain('blocked address');
    }
    const publicChannel = await app.inject({
      method: 'POST',
      url: '/api/v1/channels',
      headers: { 'content-type': 'application/json' },
      payload: payload('Public'),
    });
    expect(publicChannel.statusCode).toBe(201);
    const channel = publicChannel.json().data;
    const blockedUpdate = await app.inject({
      method: 'PATCH',
      url: `/api/v1/channels/${channel.id}`,
      headers: { 'content-type': 'application/json' },
      payload: { url: 'http://127.0.0.1/hook' },
    });
    expect(blockedUpdate.statusCode).toBe(400);
    const db = (app as FastifyInstance & { db: any }).db;
    for (let n = 0; n < 25; n++) {
      db.prepare(
        'INSERT INTO delivery_attempts (id,channel_id,incident_id,event,attempt,attempted_at,ok,status_code,latency_ms,error) VALUES (?,?,?,?,?,?,?,?,?,?)',
      ).run(
        id(100 + n),
        channel.id,
        null,
        'test',
        1,
        `2026-10-11T00:${String(n).padStart(2, '0')}:00.000Z`,
        1,
        204,
        1,
        null,
      );
    }
    const deliveries = await app.inject(`/api/v1/channels/${channel.id}/deliveries`);
    expect(deliveries.json().data).toHaveLength(20);
    expect(deliveries.json().data[0].attemptedAt).toContain('00:24');
    const other = await app.inject({
      method: 'POST',
      url: '/api/v1/channels',
      headers: { 'content-type': 'application/json' },
      payload: payload('Other'),
    });
    expect(
      (await app.inject(`/api/v1/channels/${other.json().data.id}/deliveries`)).json().data,
    ).toEqual([]);
    const dnsApp = await buildApp({
      databasePath: ':memory:',
      egress: {
        resolveHost: async () => {
          throw Object.assign(new Error('dns'), { code: 'ENOTFOUND' });
        },
      },
    });
    const dns = await dnsApp.inject({
      method: 'POST',
      url: '/api/v1/channels',
      headers: { 'content-type': 'application/json' },
      payload: payload('DNS', 'https://dns-fails.test/hook'),
    });
    expect(dns.statusCode).toBe(400);
    expect(dns.json().error.issues[0].path).toEqual(['url']);
    await dnsApp.close();
    const resolvedPrivateApp = await buildApp({
      databasePath: ':memory:',
      egress: { resolveHost: async () => [{ address: '10.0.0.5', family: 4 }] },
    });
    const resolvedPrivate = await resolvedPrivateApp.inject({
      method: 'POST',
      url: '/api/v1/channels',
      headers: { 'content-type': 'application/json' },
      payload: payload('Resolved private', 'https://resolves-private.test/hook'),
    });
    expect(resolvedPrivate.statusCode).toBe(400);
    expect(resolvedPrivate.json().error.issues[0].message).toContain('10.0.0.5');
    await resolvedPrivateApp.close();
  });

  it('rejects a host that becomes private at send time, does not follow redirects, and allows loopback explicitly', async () => {
    let address = '203.0.113.10';
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(
        new Response(null, { status: 302, headers: { location: 'http://elsewhere.test' } }),
      );
    app = await buildApp({
      databasePath: ':memory:',
      egress: { resolveHost: async () => [{ address, family: 4 }], fetch: fetch as never },
    });
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/channels',
      headers: { 'content-type': 'application/json' },
      payload: payload('Dynamic'),
    });
    const channel = created.json().data;
    address = '127.0.0.1';
    const blocked = await app.inject({
      method: 'POST',
      url: `/api/v1/channels/${channel.id}/test`,
    });
    expect(blocked.json().data).toMatchObject({
      ok: false,
      error: 'blocked address: hooks.test resolves to 127.0.0.1 (loopback)',
    });
    expect(fetch).not.toHaveBeenCalled();
    address = '203.0.113.10';
    const redirected = await app.inject({
      method: 'POST',
      url: `/api/v1/channels/${channel.id}/test`,
    });
    expect(redirected.json().data).toMatchObject({
      ok: false,
      statusCode: 302,
      error: 'unexpected redirect (HTTP 302)',
    });

    const localFetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response(null, { status: 204 }));
    await app.close();
    app = await buildApp({
      databasePath: ':memory:',
      allowPrivate: true,
      egress: { fetch: localFetch as never },
    });
    const local = await app.inject({
      method: 'POST',
      url: '/api/v1/channels',
      headers: { 'content-type': 'application/json' },
      payload: payload('Local', 'http://127.0.0.1/hook'),
    });
    expect(local.statusCode).toBe(201);
    const delivered = await app.inject({
      method: 'POST',
      url: `/api/v1/channels/${local.json().data.id}/test`,
    });
    expect(delivered.json().data.ok).toBe(true);
    expect(localFetch).toHaveBeenCalledTimes(1);
    const metadata = await app.inject({
      method: 'POST',
      url: '/api/v1/channels',
      headers: { 'content-type': 'application/json' },
      payload: payload('Metadata', 'http://169.254.169.254/'),
    });
    expect(metadata.statusCode).toBe(400);
  });
});
