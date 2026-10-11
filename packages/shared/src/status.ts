import { z } from 'zod';

export const CHECK_STATUSES = ['up', 'degraded', 'down'] as const;
export const MONITOR_STATUSES = ['pending', 'up', 'degraded', 'down'] as const;
export const CheckStatusSchema = z.enum(CHECK_STATUSES);
export const MonitorStatusSchema = z.enum(MONITOR_STATUSES);
export const DOWN_AFTER_CONSECUTIVE_FAILURES = 3;

export type CheckStatus = z.infer<typeof CheckStatusSchema>;
export type MonitorStatus = z.infer<typeof MonitorStatusSchema>;
