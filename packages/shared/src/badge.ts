import { z } from 'zod';
export const BADGE_TYPES = ['uptime', 'status'] as const;
export const BadgeQuerySchema = z.object({
  type: z.enum(BADGE_TYPES).default('uptime'),
  label: z.string().min(1).max(40).optional(),
});
export function formatBadgePercent(percent: number): string {
  return `${Math.floor(percent * 100) / 100}`.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '') + '%';
}
