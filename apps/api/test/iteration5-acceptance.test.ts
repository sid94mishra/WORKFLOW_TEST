import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { CheckOutcome, MaintenanceWindow } from '@pulse/shared';
import { buildApp } from '../src/app.js';
import { openDatabase } from '../src/db.js';
import { MaintenanceRepository } from '../src/maintenance/repository.js';
import { ResultRepository } from '../src/results/repository.js';
import { ChannelRepository, DeliveryRepository } from '../src/channels/repository.js';
import { Notifier } from '../src/notifications/notifier.js';

const PASSWORD = 'iteration-five-acceptance-password';
const AUTH = {
  admin: { email: 'acceptance@example.test', password: PASSWORD },
  sessionSecret: 'a'.repeat(32),
  scryptParams: { N: 1024, r: 8, p: 1 },
};
const T = '2026-10-13T00:00:00.000Z';
const iso = (minutes: number) => new Date(Date.parse(T) + minutes * 60_000).toISOString();
const outcome = (checkedAt: string, ok: boolean, latencyMs = 100): CheckOutcome => ({
  checkedAt,
  ok,
  statusCode: ok ? 200 : null,
  latencyMs,
  error: ok ? null : 'connection refused',
  keywordMatched: null,
});

type AppWithDb = FastifyInstance & { db: ReturnType<typeof openDatabase> };
type Session = { cookie: string; csrf: string };
const dbOf = (app: FastifyInstance) => (app as AppWithDb).db;

async function makeApp(
  options: {
    scheduler?: false | Parameters<typeof buildApp>[0]['scheduler'];
    metricsPublic?: boolean;
  } = {},
) {
  return buildApp({
    databasePath: ':memory:',
    scheduler: options.scheduler ?? false,
    metricsPublic: options.metricsPublic,
    auth: AUTH,
    egress: {
      resolveHost: async () => [{ address: '203.0.113.10', family: 4 }],
      fetch: vi.fn(async () => new Response(null, { status: 204 })) as never,
    },
    notifier: { retryDelaysMs: [], maxConcurrency: 1 },
  });
}

async function login(app: FastifyInstance): Promise<Session> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email: AUTH.admin.email, password: PASSWORD },
  });
  expect(response.statusCode).toBe(200);
  const setCookie = response.headers['set-cookie'];
  return {
    cookie: (Array.isArray(setCookie) ? setCookie[0]! : setCookie!).split(';', 1)[0]!,
    csrf: response.json().data.csrfToken as string,
  };
}

const sessionHeaders = (session: Session, method = 'GET') => ({
  cookie: session.cookie,
  ...(method !== 'GET' && method !== 'HEAD' ? { 'x-pulse-csrf': session.csrf } : {}),
});

async function monitor(
  app: FastifyInstance,
  session: Session,
  name = 'Acceptance monitor',
  extra = {},
) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/monitors',
    headers: sessionHeaders(session, 'POST'),
    payload: {
      name,
      url: 'https://example.test/health',
      public: true,
      ...extra,
    },
  });
  expect(response.statusCode).toBe(201);
  return response.json().data as { id: string; name: string };
}

async function window(
  app: FastifyInstance,
  session: Session,
  monitorIds: string[] | 'all',
  patch: Partial<Record<string, unknown>> = {},
) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/maintenance',
    headers: sessionHeaders(session, 'POST'),
    payload: {
      title: 'Planned & "quoted" maintenance',
      monitorIds,
      startsAt: T,
      endsAt: iso(30),
      repeat: null,
      ...patch,
    },
  });
  expect(response.statusCode).toBe(201);
  return response.json().data as MaintenanceWindow & { id: string };
}

async function apiKey(
  app: FastifyInstance,
  session: Session,
  name: string,
  scope: 'read' | 'write' = 'write',
) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/api-keys',
    headers: sessionHeaders(session, 'POST'),
    payload: { name, scope },
  });
  expect(response.statusCode).toBe(201);
  return { id: response.json().data.id as string, key: response.json().data.key as string };
}

async function recordAndNotify(
  app: FastifyInstance,
  monitorId: string,
  checkedAt: string,
  ok: boolean,
  send = vi.fn().mockResolvedValue({ ok: true, statusCode: 200, latencyMs: 1 }),
) {
  const db = dbOf(app);
  const maintenance = new MaintenanceRepository(db);
  const results = new ResultRepository(db, maintenance);
  const channels = new ChannelRepository(db);
  const deliveries = new DeliveryRepository(db);
  const notifier = new Notifier({
    listChannels: (id) => channels.listEnabledForMonitor(id),
    getChannel: (id) => channels.get(id),
    send,
    recordAttempt: (attempt) => deliveries.record(attempt),
    retryDelaysMs: [],
    maxConcurrency: 1,
  });
  const recorded = results.record(monitorId, outcome(checkedAt, ok));
  if (recorded?.event) notifier.enqueue(recorded.event);
  await vi.waitFor(() => expect(notifier.pending).toBe(0), { timeout: 2_000 });
  await notifier.stop();
  return { recorded, send, db };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('iteration 5 acceptance: suppression and maintenance windows', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => app?.close());

  it('suppresses incident open/resolve notifications only inside a one-off window', async () => {
    app = await makeApp();
    const session = await login(app);
    const m = await monitor(app, session);
    const channel = await app.inject({
      method: 'POST',
      url: '/api/v1/channels',
      headers: sessionHeaders(session, 'POST'),
      payload: {
        name: 'Webhook',
        kind: 'webhook',
        url: 'http://webhook.test/events',
        enabled: true,
        monitorIds: [m.id],
      },
    });
    expect(channel.statusCode).toBe(201);
    await window(app, session, [m.id]);

    const first = await recordAndNotify(app, m.id, iso(1), false);
    const second = await recordAndNotify(app, m.id, iso(2), false);
    const third = await recordAndNotify(app, m.id, iso(3), false);
    expect(third.recorded).toMatchObject({ event: null, suppressed: 'incident.opened' });
    expect(
      (dbOf(app).prepare('SELECT count(*) count FROM check_results').get() as { count: number })
        .count,
    ).toBe(3);
    expect(
      (dbOf(app).prepare('SELECT count(*) count FROM incidents').get() as { count: number }).count,
    ).toBe(0);
    expect(
      (dbOf(app).prepare('SELECT count(*) count FROM delivery_attempts').get() as { count: number })
        .count,
    ).toBe(0);
    expect(first.send).not.toHaveBeenCalled();
    expect(second.send).not.toHaveBeenCalled();
    expect(third.send).not.toHaveBeenCalled();
    const outside = await recordAndNotify(app, m.id, iso(31), false);
    expect(outside.recorded?.event?.type).toBe('incident.opened');
    expect(outside.recorded?.event?.incident.startedAt).toBe(iso(31));
    expect(outside.send).toHaveBeenCalledTimes(1);
    expect(outside.send.mock.calls[0]?.[1]).toMatchObject({ event: 'incident.opened' });
    expect(
      (dbOf(app).prepare('SELECT count(*) count FROM delivery_attempts').get() as { count: number })
        .count,
    ).toBe(1);

    // An incident which predates maintenance remains open while failing, then resolves silently.
    const before = await monitor(app, session, 'Pre-window incident');
    await window(app, session, [before.id]);
    const old = await recordAndNotify(app, before.id, iso(-3), false);
    await recordAndNotify(app, before.id, iso(-2), false);
    await recordAndNotify(app, before.id, iso(-1), false);
    expect(old.recorded?.event).toBeNull();
    const recoveredInside = await recordAndNotify(app, before.id, iso(10), true);
    expect(recoveredInside.recorded).toMatchObject({
      event: null,
      suppressed: 'incident.resolved',
    });
    const resolved = dbOf(app)
      .prepare('SELECT status,resolved_at FROM incidents WHERE monitor_id=?')
      .get(before.id) as { status: string; resolved_at: string };
    expect(resolved).toMatchObject({ status: 'resolved', resolved_at: iso(10) });
  });

  it('evaluates weekly occurrences in UTC across midnight and under a non-UTC TZ', async () => {
    vi.stubEnv('TZ', 'America/Los_Angeles');
    vi.setSystemTime(new Date('2026-10-14T00:30:00.000Z')); // Wednesday 00:30 UTC.
    app = await makeApp();
    const session = await login(app);
    const m = await monitor(app, session);
    const w = await window(app, session, [m.id], {
      startsAt: '2026-10-01T00:00:00.000Z',
      endsAt: '2026-11-01T00:00:00.000Z',
      repeat: { weekdays: [2], startTime: '23:00', durationMinutes: 120 },
    });
    expect(w.repeat).toEqual({ weekdays: [2], startTime: '23:00', durationMinutes: 120 });
    expect(
      (
        await app.inject({ url: `/api/v1/monitors/${m.id}`, headers: sessionHeaders(session) })
      ).json().data.maintenance,
    ).not.toBeNull();
    vi.setSystemTime(new Date('2026-10-12T23:30:00.000Z')); // Monday, inactive.
    expect(
      (
        await app.inject({ url: `/api/v1/monitors/${m.id}`, headers: sessionHeaders(session) })
      ).json().data.maintenance,
    ).toBeNull();

    const sat = await window(app, session, [m.id], {
      title: 'Weekend window',
      startsAt: '2026-10-01T00:00:00.000Z',
      endsAt: '2026-11-01T00:00:00.000Z',
      repeat: { weekdays: [6], startTime: '22:00', durationMinutes: 240 },
    });
    expect(sat.id).toBeTruthy();
    vi.setSystemTime(new Date('2026-10-18T01:59:00.000Z')); // Sunday, still active.
    expect(
      (
        await app.inject({ url: `/api/v1/monitors/${m.id}`, headers: sessionHeaders(session) })
      ).json().data.maintenance,
    ).not.toBeNull();
    vi.setSystemTime(new Date('2026-10-18T02:00:00.000Z'));
    expect(
      (
        await app.inject({ url: `/api/v1/monitors/${m.id}`, headers: sessionHeaders(session) })
      ).json().data.maintenance,
    ).toBeNull();
  });
});

describe('iteration 5 acceptance: metrics', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => app?.close());

  it('exposes parseable cumulative Prometheus metrics with auth and public modes', async () => {
    const checks = [
      outcome(iso(0), true, 120),
      outcome(iso(30), true, 80),
      outcome(iso(60), false, 200),
    ];
    let index = 0;
    app = await makeApp({
      scheduler: {
        maxConcurrency: 1,
        random: () => 0,
        runCheck: vi.fn(async () => checks[index++]!),
      },
    });
    const session = await login(app);
    const m = await monitor(app, session, 'a"b\\c\nmetrics');
    const read = await apiKey(app, session, 'read', 'read');
    const write = await apiKey(app, session, 'write', 'write');
    vi.useFakeTimers();
    vi.setSystemTime(new Date(T));
    const snapshot = (
      await app.inject({ url: `/api/v1/monitors/${m.id}`, headers: sessionHeaders(session) })
    ).json().data;
    app.scheduler!.upsert(snapshot);
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(30_000);
    vi.useRealTimers();
    await window(app, session, [m.id], {
      startsAt: new Date(Date.now() - 60_000).toISOString(),
      endsAt: new Date(Date.now() + 600_000).toISOString(),
    });
    const metrics = async (headers?: Record<string, string>) =>
      app!.inject({ url: '/metrics', headers });
    expect((await metrics()).statusCode).toBe(401);
    expect((await metrics()).headers['www-authenticate']).toContain('Bearer');
    const readResponse = await metrics({ authorization: `Bearer ${read.key}` });
    const writeResponse = await metrics({ authorization: `Bearer ${write.key}` });
    expect(readResponse.statusCode).toBe(200);
    expect(writeResponse.statusCode).toBe(200);
    expect(readResponse.headers['content-type']).toBe('text/plain; version=0.0.4; charset=utf-8');
    const body = readResponse.body;
    const line =
      /^[a-zA-Z_:][a-zA-Z0-9_:]*(\{(?:[a-zA-Z_][a-zA-Z0-9_]*="(?:[^"\\\n]|\\["\\n])*",?)*\})? (NaN|[+-]Inf|-?[0-9.eE+-]+)$/;
    const families = new Map<string, { help: number; type: number; samples: string[] }>();
    let current = '';
    for (const row of body.trimEnd().split('\n')) {
      if (row.startsWith('# HELP ')) {
        current = row.split(' ')[2]!;
        const family = families.get(current) ?? { help: 0, type: 0, samples: [] };
        family.help++;
        families.set(current, family);
      } else if (row.startsWith('# TYPE ')) {
        const name = row.split(' ')[2]!;
        const family = families.get(name) ?? { help: 0, type: 0, samples: [] };
        family.type++;
        families.set(name, family);
      } else {
        expect(row).toMatch(line);
        const name = row.split(/[ {]/, 1)[0]!;
        const family = families.get(name.replace(/_(?:bucket|sum|count)$/, '')) ?? {
          help: 0,
          type: 0,
          samples: [],
        };
        family.samples.push(row);
      }
    }
    for (const family of families.values()) expect(family).toMatchObject({ help: 1, type: 1 });
    expect(body).toContain('pulse_checks_total{result="ok"} 2');
    expect(body).toContain('pulse_checks_total{result="fail"} 1');
    expect(body).toContain('pulse_check_duration_seconds_count 3');
    expect(body).toContain('pulse_check_duration_seconds_bucket{le="0.1"} 1');
    expect(body).toContain('monitor="a\\"b\\\\c\\nmetrics"');
    expect(body).toContain(`pulse_monitor_up{monitor="a\\"b\\\\c\\nmetrics",id="${m.id}"} 0`);
    expect(body).toContain(
      `pulse_maintenance_active{monitor="a\\"b\\\\c\\nmetrics",id="${m.id}"} 1`,
    );
    expect(body).toContain('pulse_open_incidents 0');

    const revoked = await apiKey(app, session, 'revoked');
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: `/api/v1/api-keys/${revoked.id}`,
          headers: sessionHeaders(session, 'DELETE'),
        })
      ).statusCode,
    ).toBe(204);
    expect((await metrics({ authorization: `Bearer ${revoked.key}` })).statusCode).toBe(401);
    expect((await metrics({ cookie: session.cookie })).statusCode).toBe(200);
  });

  it('allows unauthenticated metrics when metricsPublic is enabled', async () => {
    app = await makeApp({ metricsPublic: true });
    expect((await app.inject('/metrics')).statusCode).toBe(200);
  });
});

describe('iteration 5 acceptance: status, badge and monitor display', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => app?.close());

  it('renders maintenance in API status, HTML, badge and monitor responses, then down after end', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(iso(10)));
    app = await makeApp();
    const session = await login(app);
    const publicDown = await monitor(app, session, 'Public <maintenance>');
    const privateDown = await monitor(app, session, 'Private maintenance', { public: false });
    const paused = await monitor(app, session, 'Paused', { enabled: false });
    const w = await window(app, session, [publicDown.id], { title: 'Fix <&> "quoted"' });
    const maintenance = new MaintenanceRepository(dbOf(app));
    const results = new ResultRepository(dbOf(app), maintenance);
    for (const id of [publicDown.id, privateDown.id]) {
      results.record(id, outcome(iso(-3), false));
      results.record(id, outcome(iso(-2), false));
      results.record(id, outcome(iso(-1), false));
    }
    const status = (await app.inject('/api/v1/status')).json().data;
    expect(status.monitors.find((x: any) => x.id === publicDown.id)).toMatchObject({
      status: 'maintenance',
      maintenance: { title: w.title },
    });
    expect(status.overall).toBe('maintenance');
    expect(status.upcomingMaintenance).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: w.id, active: true })]),
    );
    expect(
      status.upcomingMaintenance.some((x: any) =>
        x.monitors.some((m: any) => m.id === privateDown.id),
      ),
    ).toBe(false);
    expect(status.monitors.find((x: any) => x.id === paused.id)?.status).toBe('paused');
    const html = (await app.inject('/status')).body;
    expect(html).toContain('data-status="maintenance"');
    expect(html).toContain('Fix &lt;&amp;&gt; &quot;quoted&quot;');
    expect(html).toContain('Upcoming maintenance');
    const badge = await app.inject(`/badge/${publicDown.id}.svg?type=status`);
    expect(badge.body).toContain('maintenance');
    expect(badge.body).toContain('#007ec6');
    expect(
      (await app.inject({ url: '/api/v1/monitors', headers: sessionHeaders(session) }))
        .json()
        .data.find((x: any) => x.id === publicDown.id).maintenance,
    ).not.toBeNull();
    vi.setSystemTime(new Date(iso(31)));
    const after = (await app.inject('/api/v1/status')).json().data;
    expect(after.monitors.find((x: any) => x.id === publicDown.id)?.status).toBe('down');
    expect((await app.inject(`/badge/${publicDown.id}.svg?type=status`)).body).toContain('down');
    expect(
      (await app.inject({ url: '/api/v1/monitors', headers: sessionHeaders(session) }))
        .json()
        .data.find((x: any) => x.id === publicDown.id).maintenance,
    ).toBeNull();
  });
});

describe('iteration 5 acceptance: maintenance CRUD and auth precedence', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => app?.close());

  it('covers validation, createdBy, merged patching, delete and monitor cascade', async () => {
    app = await makeApp();
    const session = await login(app);
    const m = await monitor(app, session);
    const write = await apiKey(app, session, 'maintenance writer');
    const read = await apiKey(app, session, 'maintenance reader', 'read');
    const auth = { authorization: `Bearer ${write.key}` };
    const readAuth = { authorization: `Bearer ${read.key}` };
    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/maintenance',
      headers: auth,
      payload: {
        title: 'Writer window',
        monitorIds: [m.id],
        startsAt: T,
        endsAt: iso(30),
        repeat: null,
      },
    });
    expect(create.statusCode).toBe(201);
    expect(create.headers.location).toContain('/api/v1/maintenance/');
    expect(create.json().data.createdBy.kind).toBe('apiKey');
    const id = create.json().data.id as string;
    const readCreate = await app.inject({
      method: 'POST',
      url: '/api/v1/maintenance',
      headers: readAuth,
      payload: {},
    });
    expect(readCreate.statusCode).toBe(403);
    const bad = (payload: Record<string, unknown>) =>
      app!.inject({
        method: 'POST',
        url: '/api/v1/maintenance',
        headers: sessionHeaders(session, 'POST'),
        payload,
      });
    expect(
      (
        await bad({
          title: 'x',
          monitorIds: ['00000000-0000-4000-8000-000000000099'],
          startsAt: T,
          endsAt: iso(1),
          repeat: null,
        })
      ).json().error.issues[0].path,
    ).toEqual(['monitorIds', 0]);
    for (const payload of [
      { title: 'x', monitorIds: [m.id], startsAt: iso(2), endsAt: iso(2), repeat: null },
      { title: 'x', monitorIds: [m.id], startsAt: T, endsAt: iso(60 * 24 * 7 + 1), repeat: null },
      {
        title: 'x',
        monitorIds: [m.id],
        startsAt: T,
        endsAt: iso(2),
        repeat: { weekdays: [2], startTime: '25:00', durationMinutes: 1 },
      },
      {
        title: 'x',
        monitorIds: [m.id],
        startsAt: T,
        endsAt: iso(2),
        repeat: { weekdays: [], startTime: '01:00', durationMinutes: 1 },
      },
      { title: 'x', monitorIds: [m.id], startsAt: T, endsAt: iso(2), repeat: null, unknown: true },
    ])
      expect((await bad(payload)).statusCode).toBe(400);
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/api/v1/maintenance/${id}`,
          headers: sessionHeaders(session, 'PATCH'),
          payload: { endsAt: iso(-1) },
        })
      ).statusCode,
    ).toBe(400);
    const repeat = { weekdays: [2], startTime: '23:00', durationMinutes: 120 };
    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/v1/maintenance/${id}`,
      headers: sessionHeaders(session, 'PATCH'),
      payload: { repeat },
    });
    expect(patched.statusCode).toBe(200);
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/api/v1/maintenance/${id}`,
          headers: sessionHeaders(session, 'PATCH'),
          payload: { repeat: null },
        })
      ).json().data.repeat,
    ).toBeNull();
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: `/api/v1/maintenance/nope`,
          headers: sessionHeaders(session, 'DELETE'),
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: `/api/v1/maintenance/${id}`,
          headers: sessionHeaders(session, 'DELETE'),
        })
      ).statusCode,
    ).toBe(204);
    expect(
      (
        await app.inject({
          url: `/api/v1/maintenance/${id}`,
          headers: sessionHeaders(session),
        })
      ).statusCode,
    ).toBe(404);

    const cascade = await window(app, session, [m.id]);
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: `/api/v1/monitors/${m.id}`,
          headers: sessionHeaders(session, 'DELETE'),
        })
      ).statusCode,
    ).toBe(204);
    expect(
      (
        await app.inject({
          url: `/api/v1/maintenance/${cascade.id}`,
          headers: sessionHeaders(session),
        })
      ).statusCode,
    ).toBe(404);
  });

  it('returns 401 for every protected maintenance route without credentials', async () => {
    app = await makeApp();
    for (const request of [
      { method: 'GET', url: '/api/v1/maintenance' },
      { method: 'GET', url: `/api/v1/maintenance/${randomUUID()}` },
      { method: 'POST', url: '/api/v1/maintenance', payload: {} },
      { method: 'PATCH', url: `/api/v1/maintenance/${randomUUID()}`, payload: {} },
      { method: 'DELETE', url: `/api/v1/maintenance/${randomUUID()}` },
    ])
      expect((await app.inject(request)).statusCode).toBe(401);
  });
});
