import { z } from 'zod';
import { IncidentSchema } from './incident.js';
export const STATUS_PAGE_DAYS = 90;
export const RESOLVED_INCIDENTS_ON_STATUS_PAGE = 10;
export const OVERALL_STATUSES = [
  'operational',
  'degraded',
  'partial_outage',
  'major_outage',
  'unknown',
] as const;
export const PublicMonitorStatusSchema = z.enum(['pending', 'up', 'degraded', 'down', 'paused']);
export const DailyUptimeSchema = z
  .object({
    date: z.iso.date(),
    totalChecks: z.number().int().min(0),
    okChecks: z.number().int().min(0),
    uptimePercent: z.number().min(0).max(100).nullable(),
  })
  .strict();
export const PublicMonitorSchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    status: PublicMonitorStatusSchema,
    lastCheckedAt: z.iso.datetime().nullable(),
    uptime90dPercent: z.number().min(0).max(100).nullable(),
    days: z.array(DailyUptimeSchema).length(90),
  })
  .strict();
export const PublicIncidentSchema = IncidentSchema.omit({ cause: true });
export const StatusPageSchema = z
  .object({
    generatedAt: z.iso.datetime(),
    overall: z.enum(OVERALL_STATUSES),
    monitors: z.array(PublicMonitorSchema),
    incidents: z
      .object({
        open: z.array(PublicIncidentSchema),
        resolved: z.array(PublicIncidentSchema).max(10),
      })
      .strict(),
  })
  .strict();
export type PublicMonitor = z.infer<typeof PublicMonitorSchema>;
export type OverallStatus = (typeof OVERALL_STATUSES)[number];
export type StatusPage = z.infer<typeof StatusPageSchema>;
export type UptimeLevel = 'none' | 'good' | 'warn' | 'bad';
export const uptimeLevel = (p: number | null): UptimeLevel =>
  p === null ? 'none' : p >= 99 ? 'good' : p >= 95 ? 'warn' : 'bad';
export function overallStatus(monitors: Pick<PublicMonitor, 'status'>[]): OverallStatus {
  const active = monitors.filter((m) => m.status !== 'paused');
  if (!active.length || active.every((m) => m.status === 'pending')) return 'unknown';
  if (active.some((m) => m.status === 'down'))
    return active.filter((m) => m.status !== 'pending').every((m) => m.status === 'down')
      ? 'major_outage'
      : 'partial_outage';
  return active.some((m) => m.status === 'degraded') ? 'degraded' : 'operational';
}
