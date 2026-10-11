import { z } from 'zod';

export const RESULTS_LIMITS = { default: 50, min: 1, max: 500 } as const;
export const ResultsQuerySchema = z.object({
  limit: z.coerce
    .number()
    .int()
    .min(RESULTS_LIMITS.min)
    .max(RESULTS_LIMITS.max)
    .default(RESULTS_LIMITS.default),
});

export const UPTIME_WINDOWS = ['24h', '7d', '30d'] as const;
export const UPTIME_WINDOW_MS = {
  '24h': 86_400_000,
  '7d': 604_800_000,
  '30d': 2_592_000_000,
} as const;
export const UptimeWindowSchema = z.enum(UPTIME_WINDOWS);
export const UptimeQuerySchema = z.object({ window: UptimeWindowSchema.default('24h') });
export const UptimeSummarySchema = z
  .object({
    monitorId: z.uuid(),
    window: UptimeWindowSchema,
    from: z.iso.datetime(),
    to: z.iso.datetime(),
    totalChecks: z.number().int().min(0),
    okChecks: z.number().int().min(0),
    uptimePercent: z.number().min(0).max(100).nullable(),
    latencyP50Ms: z.number().int().min(0).nullable(),
    latencyP95Ms: z.number().int().min(0).nullable(),
  })
  .strict();

export type UptimeWindow = z.infer<typeof UptimeWindowSchema>;
export type UptimeSummary = z.infer<typeof UptimeSummarySchema>;
