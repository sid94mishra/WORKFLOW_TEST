import { afterEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import type { FastifyInstance } from 'fastify';
import { buildTestApp as buildApp } from './helpers.js';

let app: FastifyInstance | undefined;
const create = (name: string, publicFlag: boolean) =>
  app!.inject({
    method: 'POST',
    url: '/api/v1/monitors',
    headers: { 'content-type': 'application/json' },
    payload: { name, url: `https://${name}.test`, public: publicFlag },
  });
afterEach(async () => {
  vi.useRealTimers();
  await app?.close();
  app = undefined;
});

describe('badges', () => {
  it('renders parseable uptime/status badges, escaping labels and handling no data', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-11T12:00:00.000Z'));
    app = await buildApp({ databasePath: ':memory:' });
    const publicMonitor = (await create('public', true)).json().data;
    const noData = (await create('empty', true)).json().data;
    const privateMonitor = (await create('private', false)).json().data;
    const db = (app as FastifyInstance & { db: any }).db;
    const insert = db.prepare(
      'INSERT INTO check_results (id,monitor_id,checked_at,ok,status_code,latency_ms,error,keyword_matched,status) VALUES (?,?,?,?,?,?,?,?,?)',
    );
    for (let n = 0; n < 1000; n++)
      insert.run(
        `00000000-0000-4000-8000-${String(n + 1).padStart(12, '0')}`,
        publicMonitor.id,
        '2026-10-11T11:00:00.000Z',
        n < 999 ? 1 : 0,
        n < 999 ? 200 : null,
        1,
        n < 999 ? null : 'down',
        null,
        n < 999 ? 'up' : 'down',
      );
    db.prepare("UPDATE monitors SET status='down' WHERE id=?").run(publicMonitor.id);
    const uptime = await app.inject(`/badge/${publicMonitor.id}.svg`);
    expect(uptime.statusCode).toBe(200);
    expect(uptime.headers['content-type']).toContain('image/svg+xml');
    expect(uptime.headers['cache-control']).toBe('public, max-age=60');
    expect(uptime.headers['x-content-type-options']).toBe('nosniff');
    expect(uptime.body).toContain('<title>uptime: 99.9%</title>');
    const parser = new JSDOM().window.DOMParser;
    const parsed = new parser().parseFromString(uptime.body, 'image/svg+xml');
    expect(parsed.querySelector('parsererror')).toBeNull();
    expect(parsed.documentElement.getAttribute('role')).toBe('img');
    expect(parsed.querySelector('title')?.textContent).toBe('uptime: 99.9%');
    expect((await app.inject(`/badge/${publicMonitor.id}.svg?type=status`)).body).toContain(
      'status: down',
    );
    expect((await app.inject(`/badge/${publicMonitor.id}.svg?type=status`)).body).toContain(
      '#e05d44',
    );
    expect((await app.inject(`/badge/${noData.id}.svg`)).body).toContain('uptime: n/a');

    const label = encodeURIComponent('<a&"b\'>');
    const labelled = await app.inject(`/badge/${publicMonitor.id}.svg?label=${label}`);
    expect(labelled.statusCode).toBe(200);
    expect(labelled.body).toContain('&lt;a&amp;&quot;b&#39;&gt;');
    const labelledDom = new new JSDOM().window.DOMParser().parseFromString(
      labelled.body,
      'image/svg+xml',
    );
    expect(labelledDom.querySelector('parsererror')).toBeNull();
    expect(labelledDom.querySelector('title')?.textContent).toContain('<a&"b\'>');
    expect(
      (await app.inject(`/badge/${publicMonitor.id}.svg?label=${'x'.repeat(41)}`)).statusCode,
    ).toBe(400);
    expect((await app.inject(`/badge/${publicMonitor.id}.svg?type=foo`)).statusCode).toBe(400);
    const privateResponse = await app.inject(`/badge/${privateMonitor.id}.svg`);
    const unknownResponse = await app.inject('/badge/00000000-0000-4000-8000-000000000099.svg');
    expect(privateResponse.statusCode).toBe(404);
    expect(privateResponse.body).toBe(unknownResponse.body);
    expect((await app.inject('/badge/not-a-uuid.svg')).statusCode).toBe(404);
    expect((await app.inject(`/badge/${publicMonitor.id}.png`)).statusCode).toBe(404);
  });
});
