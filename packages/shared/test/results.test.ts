import { describe, expect, it } from 'vitest';
import { ResultsQuerySchema, UptimeQuerySchema, UptimeSummarySchema } from '../src/index.js';

describe('result queries', () => {
  it('coerces bounded result limits and defaults', () => {
    expect(ResultsQuerySchema.parse({})).toEqual({ limit: 50 });
    expect(ResultsQuerySchema.parse({ limit: '12' })).toEqual({ limit: 12 });
    expect(ResultsQuerySchema.safeParse({ limit: '0' }).success).toBe(false);
    expect(ResultsQuerySchema.safeParse({ limit: '501' }).success).toBe(false);
  });
  it('defaults uptime window and accepts nullable empty summaries', () => {
    expect(UptimeQuerySchema.parse({})).toEqual({ window: '24h' });
    expect(UptimeQuerySchema.safeParse({ window: '1h' }).success).toBe(false);
    expect(
      UptimeSummarySchema.safeParse({
        monitorId: '00000000-0000-4000-8000-000000000000',
        window: '24h',
        from: '2026-10-10T00:00:00.000Z',
        to: '2026-10-11T00:00:00.000Z',
        totalChecks: 0,
        okChecks: 0,
        uptimePercent: null,
        latencyP50Ms: null,
        latencyP95Ms: null,
      }).success,
    ).toBe(true);
  });
});
