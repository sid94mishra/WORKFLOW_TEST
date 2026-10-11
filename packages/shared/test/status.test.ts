import { describe, expect, it } from 'vitest';
import {
  CheckStatusSchema,
  DOWN_AFTER_CONSECUTIVE_FAILURES,
  MonitorCreateSchema,
  MonitorSchema,
  MonitorStatusSchema,
} from '../src/index.js';

describe('monitor and check statuses', () => {
  it('exports the state machine statuses', () => {
    expect(MonitorStatusSchema.options).toEqual(['pending', 'up', 'degraded', 'down']);
    expect(CheckStatusSchema.options).toEqual(['up', 'degraded', 'down']);
    expect(DOWN_AFTER_CONSECUTIVE_FAILURES).toBe(3);
  });

  it('requires read-only monitor status fields and rejects them on create', () => {
    const monitor = {
      id: '00000000-0000-4000-8000-000000000000',
      name: 'API',
      url: 'https://example.test',
      method: 'GET',
      intervalSeconds: 60,
      timeoutMs: 1000,
      expectedStatus: 200,
      keyword: null,
      enabled: true,
      status: 'pending',
      lastCheckedAt: null,
      createdAt: '2026-10-11T00:00:00.000Z',
    };
    expect(MonitorSchema.safeParse(monitor).success).toBe(true);
    expect(
      MonitorCreateSchema.safeParse({ name: 'API', url: 'https://example.test', status: 'up' })
        .success,
    ).toBe(false);
  });
});
