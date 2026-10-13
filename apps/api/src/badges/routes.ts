import type { FastifyInstance } from 'fastify';
import {
  BadgeQuerySchema,
  formatBadgePercent,
  STATUS_BADGE_COLORS,
  activeWindowFor,
  publicMonitorStatus,
} from '@pulse/shared';
import { apiError, issues } from '../errors.js';
import type { MonitorRepository } from '../monitors/repository.js';
import type { ResultRepository } from '../results/repository.js';
import type { MaintenanceRepository } from '../maintenance/repository.js';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const esc = (s: string) =>
  s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
const color = (p: number | null) =>
  p === null
    ? '#9f9f9f'
    : p >= 99.9
      ? '#4c1'
      : p >= 99
        ? '#97ca00'
        : p >= 95
          ? '#dfb317'
          : '#e05d44';
function svg(left: string, right: string, c: string) {
  const lw = Math.round(Array.from(left).length * 6.5) + 10,
    rw = Math.round(Array.from(right).length * 6.5) + 10,
    w = lw + rw;
  const title = esc(`${left}: ${right}`);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="20" role="img" aria-label="${title}"><title>${title}</title><linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-opacity=".1" stop-color="#fff"/><stop offset="1" stop-opacity=".1"/></linearGradient><clipPath id="r"><rect width="${w}" height="20" rx="3"/></clipPath><g clip-path="url(#r)"><rect width="${lw}" height="20" fill="#555"/><rect x="${lw}" width="${rw}" height="20" fill="${c}"/><rect width="${w}" height="20" fill="url(#s)"/></g><g fill="#010101" fill-opacity=".3" text-anchor="middle" font-family="Verdana,DejaVu Sans,sans-serif" font-size="11" transform="translate(0 1)"><text x="${lw / 2}" y="15">${esc(left)}</text><text x="${lw + rw / 2}" y="15">${esc(right)}</text></g><g fill="#fff" text-anchor="middle" font-family="Verdana,DejaVu Sans,sans-serif" font-size="11"><text x="${lw / 2}" y="15">${esc(left)}</text><text x="${lw + rw / 2}" y="15">${esc(right)}</text></g></svg>`;
}
export function badgeRoutes(
  app: FastifyInstance,
  monitors: MonitorRepository,
  results: ResultRepository,
  maintenance?: MaintenanceRepository,
) {
  app.get<{ Params: { file: string } }>('/badge/:file', async (req, reply) => {
    const m = /^(.+)\.svg$/.exec(req.params.file);
    const monitor = m && uuid.test(m[1]!) ? monitors.get(m[1]!) : undefined;
    if (!monitor || !monitor.public) return apiError(reply, 404, 'NOT_FOUND', 'Monitor not found');
    const q = BadgeQuerySchema.safeParse(req.query);
    if (!q.success)
      return apiError(reply, 400, 'VALIDATION_ERROR', 'Request validation failed', issues(q.error));
    let left = q.data.label ?? (q.data.type === 'status' ? 'status' : 'uptime'),
      right: string,
      c: string;
    if (q.data.type === 'status') {
      const now = new Date();
      right = publicMonitorStatus(
        monitor,
        Boolean(
          activeWindowFor(monitor.id, maintenance?.listRelevant(now.toISOString()) ?? [], now),
        ),
      );
      c = STATUS_BADGE_COLORS[right as keyof typeof STATUS_BADGE_COLORS];
    } else {
      const uptime = results.uptime(monitor.id, '24h');
      right = uptime.uptimePercent === null ? 'n/a' : formatBadgePercent(uptime.uptimePercent);
      c = color(uptime.uptimePercent);
    }
    return reply
      .header('content-type', 'image/svg+xml; charset=utf-8')
      .header('cache-control', 'public, max-age=60')
      .header('x-content-type-options', 'nosniff')
      .header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'")
      .send(svg(left, right, c));
  });
}
