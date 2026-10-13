import { z } from 'zod';
export const BADGE_TYPES = ['uptime', 'status'] as const;
export const BadgeQuerySchema = z.object({
  type: z.enum(BADGE_TYPES).default('uptime'),
  label: z.string().min(1).max(40).optional(),
});
/** Colours of `type=status` badges (shields.io palette). Maintenance is blue (iteration 5). */
export const STATUS_BADGE_COLORS = {
  up: '#4c1',
  degraded: '#dfb317',
  down: '#e05d44',
  pending: '#9f9f9f',
  paused: '#9f9f9f',
  maintenance: '#007ec6',
} as const;
export function formatBadgePercent(percent: number): string {
  return `${Math.floor(percent * 100) / 100}`.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '') + '%';
}
