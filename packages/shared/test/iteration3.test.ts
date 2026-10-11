import { describe, expect, it } from 'vitest';
import {
  BadgeQuerySchema,
  ChannelCreateSchema,
  ChannelUpdateSchema,
  IncidentSchema,
  IncidentsQuerySchema,
  StatusPageSchema,
  buildSlackPayload,
  buildWebhookPayload,
  formatBadgePercent,
  formatDuration,
  overallStatus,
  uptimeLevel,
} from '../src/index.js';

describe('iteration 3 helpers', () => {
  it('formats values and escapes Slack interpolations', () => {
    expect([0, 59, 60, 120, 3599, 3600, 7200, 86400, 90000].map(formatDuration)).toEqual([
      '0s',
      '59s',
      '1m',
      '2m',
      '59m 59s',
      '1h',
      '2h',
      '1d',
      '1d 1h',
    ]);
    expect(formatBadgePercent(99.996)).toBe('99.99%');
    expect(uptimeLevel(null)).toBe('none');
    expect(overallStatus([{ status: 'down' }])).toBe('major_outage');
    expect(
      buildSlackPayload({
        event: 'test',
        sentAt: '2026-10-11T00:00:00.000Z',
        channel: { id: '00000000-0000-4000-8000-000000000000', name: '<ops&>' },
        monitor: null,
        incident: null,
      }).text,
    ).toContain('&lt;ops&amp;&gt;');
  });

  it('builds the exact public webhook shape and escapes every Slack value', () => {
    const input = {
      event: 'incident.opened' as const,
      sentAt: '2026-10-11T00:00:00.000Z',
      channel: {
        id: '00000000-0000-4000-8000-000000000000',
        name: '<ops&>',
        enabled: true,
        monitorIds: ['00000000-0000-4000-8000-000000000001'],
      },
      monitor: {
        id: '00000000-0000-4000-8000-000000000001',
        name: '<site&>',
        url: 'https://example.test/?a=1&b=2',
        status: 'down' as const,
        enabled: true,
        method: 'GET' as const,
        intervalSeconds: 60,
        timeoutMs: 1000,
        expectedStatus: 200,
        keyword: null,
        public: true,
        lastCheckedAt: null,
        createdAt: '2026-10-10T00:00:00.000Z',
      },
      incident: {
        id: '00000000-0000-4000-8000-000000000002',
        monitorId: '00000000-0000-4000-8000-000000000001',
        monitorName: '<site&>',
        status: 'open' as const,
        cause: '<bad&>',
        startedAt: '2026-10-11T00:00:00.000Z',
        resolvedAt: null,
        durationSeconds: null,
      },
    };
    expect(buildWebhookPayload(input)).toEqual({
      event: 'incident.opened',
      sentAt: input.sentAt,
      channel: { id: input.channel.id, name: input.channel.name },
      monitor: {
        id: input.monitor.id,
        name: input.monitor.name,
        url: input.monitor.url,
        status: 'down',
      },
      incident: input.incident,
    });
    expect(buildSlackPayload(input).text).toContain('&lt;site&amp;&gt;');
    expect(buildSlackPayload(input).text).toContain('&lt;bad&amp;&gt;');
    expect(
      buildSlackPayload({
        ...input,
        event: 'incident.resolved',
        incident: {
          ...input.incident,
          status: 'resolved',
          resolvedAt: input.sentAt,
          durationSeconds: 120,
        },
      }).text,
    ).toContain('after 2m');
  });

  it('enforces the shared validation contracts and defaults', () => {
    const id = '00000000-0000-4000-8000-000000000000';
    expect(IncidentsQuerySchema.parse({})).toEqual({ status: 'all', limit: 50 });
    expect(IncidentsQuerySchema.safeParse({ limit: 201 }).success).toBe(false);
    expect(
      IncidentSchema.safeParse({
        id,
        monitorId: id,
        monitorName: 'Example',
        status: 'open',
        cause: null,
        startedAt: '2026-10-11T00:00:00.000Z',
        resolvedAt: null,
        durationSeconds: null,
      }).success,
    ).toBe(true);
    expect(
      ChannelCreateSchema.parse({ name: 'Ops', kind: 'webhook', url: 'https://example.test' }),
    ).toMatchObject({ enabled: true, monitorIds: [] });
    expect(ChannelUpdateSchema.safeParse({}).success).toBe(false);
    expect(ChannelUpdateSchema.safeParse({ id }).success).toBe(false);
    expect(BadgeQuerySchema.parse({})).toEqual({ type: 'uptime' });
    expect(StatusPageSchema.safeParse({}).success).toBe(false);
  });

  it('covers uptime thresholds and every overall-status branch', () => {
    expect(uptimeLevel(null)).toBe('none');
    expect(uptimeLevel(99)).toBe('good');
    expect(uptimeLevel(95)).toBe('warn');
    expect(uptimeLevel(94.99)).toBe('bad');
    expect(overallStatus([])).toBe('unknown');
    expect(overallStatus([{ status: 'pending' }])).toBe('unknown');
    expect(overallStatus([{ status: 'paused' }, { status: 'up' }])).toBe('operational');
    expect(overallStatus([{ status: 'up' }, { status: 'degraded' }])).toBe('degraded');
    expect(overallStatus([{ status: 'down' }, { status: 'up' }])).toBe('partial_outage');
    expect(overallStatus([{ status: 'pending' }, { status: 'down' }])).toBe('major_outage');
  });
});
