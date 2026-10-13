import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildWebhookPayload } from '@pulse/shared';
import { buildTestApp as buildApp } from './helpers.js';

let app: FastifyInstance | undefined;
const outcome = (ok: boolean, checkedAt: string) => ({
  ok,
  checkedAt,
  statusCode: ok ? 204 : null,
  latencyMs: 1,
  error: ok ? null : 'connection failed',
  keywordMatched: null,
});
const channelBody = (name: string, enabled = true, monitorIds: string[] = []) => ({
  name,
  kind: name === 'Slack' ? 'slack' : 'webhook',
  url: `https://${name.toLowerCase()}.test/hook`,
  enabled,
  monitorIds,
});
afterEach(async () => {
  vi.useRealTimers();
  await app?.close();
  app = undefined;
});

describe('application notification wiring', () => {
  it('fans out exact webhook and Slack payloads only to subscribed enabled channels', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response(null, { status: 204 }));
    let n = 0;
    const runCheck = vi.fn(async () => checks[n++]!);
    const checks = [
      outcome(false, '2026-10-11T00:00:00.000Z'),
      outcome(false, '2026-10-11T00:01:00.000Z'),
      outcome(false, '2026-10-11T00:02:00.000Z'),
      outcome(true, '2026-10-11T00:02:30.000Z'),
    ];
    app = await buildApp({
      databasePath: ':memory:',
      egress: {
        resolveHost: async () => [{ address: '203.0.113.10', family: 4 }],
        fetch: fetch as never,
      },
      scheduler: { maxConcurrency: 1, runCheck, random: () => 0 },
    });
    await app.ready();
    vi.useFakeTimers({
      toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
    });
    const monitor = (
      await app.inject({
        method: 'POST',
        url: '/api/v1/monitors',
        headers: { 'content-type': 'application/json' },
        payload: { name: 'Example', url: 'https://monitor.test' },
      })
    ).json().data;
    const channels = await Promise.all([
      app.inject({
        method: 'POST',
        url: '/api/v1/channels',
        headers: { 'content-type': 'application/json' },
        payload: channelBody('Webhook', true, [monitor.id]),
      }),
      app.inject({
        method: 'POST',
        url: '/api/v1/channels',
        headers: { 'content-type': 'application/json' },
        payload: channelBody('Slack', true, [monitor.id]),
      }),
      app.inject({
        method: 'POST',
        url: '/api/v1/channels',
        headers: { 'content-type': 'application/json' },
        payload: channelBody('Disabled', false, [monitor.id]),
      }),
      app.inject({
        method: 'POST',
        url: '/api/v1/channels',
        headers: { 'content-type': 'application/json' },
        payload: channelBody('Unsubscribed'),
      }),
    ]);
    expect(channels.every((r) => r.statusCode === 201)).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(54_000);
    await vi.advanceTimersByTimeAsync(54_000);
    expect(runCheck).toHaveBeenCalledTimes(3);
    expect(fetch).toHaveBeenCalledTimes(2);
    const webhookCall = fetch.mock.calls.find(
      ([, init]) =>
        (init?.headers as Record<string, string>)?.['x-pulse-event'] === 'incident.opened',
    );
    expect(webhookCall).toBeDefined();
    const webhookBody = JSON.parse(String(webhookCall![1]?.body));
    expect(webhookBody).toEqual(
      expect.objectContaining({
        event: 'incident.opened',
        monitor: { id: monitor.id, name: 'Example', url: 'https://monitor.test', status: 'down' },
      }),
    );
    expect(Object.keys(webhookBody.channel)).toEqual(['id', 'name']);
    const expected = buildWebhookPayload({
      event: 'incident.opened',
      sentAt: webhookBody.sentAt,
      channel: webhookBody.channel,
      monitor: webhookBody.monitor,
      incident: webhookBody.incident,
    });
    expect(webhookBody).toEqual(expected);
    const slackCall = fetch.mock.calls.find(
      ([, init]) => !(init?.headers as Record<string, string>)?.['x-pulse-event'],
    );
    expect(JSON.parse(String(slackCall![1]?.body)).text).toContain(
      ':red_circle: *Example* is DOWN',
    );

    await vi.advanceTimersByTimeAsync(54_000);
    expect(fetch).toHaveBeenCalledTimes(4);
    const resolvedWebhook = fetch.mock.calls.find(
      ([, init]) =>
        (init?.headers as Record<string, string>)?.['x-pulse-event'] === 'incident.resolved',
    );
    expect(resolvedWebhook).toBeDefined();
    expect(JSON.parse(String(resolvedWebhook![1]?.body)).incident).toMatchObject({
      status: 'resolved',
      durationSeconds: 30,
    });
    const resolvedSlack = fetch.mock.calls.find(([, init]) => {
      const body = String(init?.body ?? '');
      return body.includes('UP again');
    });
    expect(String(resolvedSlack![1]?.body)).toContain('after 30s');
    await app.close();
    app = undefined;
  });
});
