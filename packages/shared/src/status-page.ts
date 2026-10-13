import { z } from 'zod';
import { IncidentSchema } from './incident.js';
import {
  ActiveMaintenanceSchema,
  PublicMaintenanceSchema,
  UPCOMING_MAINTENANCE_LIMIT,
} from './maintenance.js';
import type { MonitorStatus } from './status.js';
export const STATUS_PAGE_DAYS = 90;
export const RESOLVED_INCIDENTS_ON_STATUS_PAGE = 10;
export const OVERALL_STATUSES = [
  'operational',
  'degraded',
  'partial_outage',
  'major_outage',
  'maintenance',
  'unknown',
] as const;
/** Display statuses. `paused` and `maintenance` are derived, never stored (spec §3.5). */
export const PUBLIC_MONITOR_STATUSES = [
  'pending',
  'up',
  'degraded',
  'down',
  'paused',
  'maintenance',
] as const;
export const PublicMonitorStatusSchema = z.enum(PUBLIC_MONITOR_STATUSES);
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
    /** The active window (iteration 5). The API always sends it; optional for older payloads. */
    maintenance: ActiveMaintenanceSchema.nullable().optional(),
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
    /** Occurrences overlapping the next 7 days (iteration 5). The API always sends it. */
    upcomingMaintenance: z
      .array(PublicMaintenanceSchema)
      .max(UPCOMING_MAINTENANCE_LIMIT)
      .optional(),
  })
  .strict();
export type PublicMonitorStatus = z.infer<typeof PublicMonitorStatusSchema>;
export type PublicMonitor = z.infer<typeof PublicMonitorSchema>;
export type OverallStatus = (typeof OVERALL_STATUSES)[number];
export type StatusPage = z.infer<typeof StatusPageSchema>;
export type UptimeLevel = 'none' | 'good' | 'warn' | 'bad';
export const uptimeLevel = (p: number | null): UptimeLevel =>
  p === null ? 'none' : p >= 99 ? 'good' : p >= 95 ? 'warn' : 'bad';
/** Display precedence: paused > maintenance > stored status. */
export function publicMonitorStatus(
  monitor: { enabled: boolean; status: MonitorStatus },
  inMaintenance: boolean,
): PublicMonitorStatus {
  if (!monitor.enabled) return 'paused';
  return inMaintenance ? 'maintenance' : monitor.status;
}
/**
 * Paused monitors are ignored. If every remaining monitor is in maintenance → `maintenance`;
 * otherwise monitors in maintenance are ignored too and the iteration-3 rules apply.
 */
export function overallStatus(monitors: Pick<PublicMonitor, 'status'>[]): OverallStatus {
  const enabled = monitors.filter((m) => m.status !== 'paused');
  const active = enabled.filter((m) => m.status !== 'maintenance');
  if (enabled.length && !active.length) return 'maintenance';
  if (!active.length || active.every((m) => m.status === 'pending')) return 'unknown';
  if (active.some((m) => m.status === 'down'))
    return active.filter((m) => m.status !== 'pending').every((m) => m.status === 'down')
      ? 'major_outage'
      : 'partial_outage';
  return active.some((m) => m.status === 'degraded') ? 'degraded' : 'operational';
}
