import { formatDuration, overallStatus, uptimeLevel, type StatusPage } from '@pulse/shared';
import type { SqliteDatabase } from '../db.js';
const round2 = (n: number) => Math.round(n * 100) / 100;
const esc = (s: string) =>
  s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
export function buildStatusPage(db: SqliteDatabase, now: Date): StatusPage {
  const today = now.toISOString().slice(0, 10);
  const dates = Array.from({ length: 90 }, (_, i) => {
    const d = new Date(`${today}T00:00:00.000Z`);
    d.setUTCDate(d.getUTCDate() - 89 + i);
    return d.toISOString().slice(0, 10);
  });
  const rows = db
    .prepare('SELECT * FROM monitors WHERE public=1 ORDER BY created_at ASC,rowid ASC')
    .all() as any[];
  const selectDaily = db.prepare(
    'SELECT * FROM daily_uptime WHERE monitor_id=? AND day BETWEEN ? AND ?',
  );
  const monitors = rows.map((m) => {
    const daily = selectDaily.all(m.id, dates[0], today) as any[];
    const by = new Map(daily.map((x) => [x.day, x]));
    const days = dates.map((date) => {
      const x = by.get(date);
      const totalChecks = x?.total_checks ?? 0,
        okChecks = x?.ok_checks ?? 0;
      return {
        date,
        totalChecks,
        okChecks,
        uptimePercent: totalChecks ? round2((100 * okChecks) / totalChecks) : null,
      };
    });
    const total = days.reduce((a, x) => a + x.totalChecks, 0),
      ok = days.reduce((a, x) => a + x.okChecks, 0);
    return {
      id: m.id,
      name: m.name,
      status: m.enabled === 1 ? m.status : 'paused',
      lastCheckedAt: m.last_checked_at,
      uptime90dPercent: total ? round2((100 * ok) / total) : null,
      days,
    };
  });
  const incident = (r: any) => ({
    id: r.id,
    monitorId: r.monitor_id,
    monitorName: r.monitor_name,
    status: r.status,
    startedAt: r.started_at,
    resolvedAt: r.resolved_at,
    durationSeconds: r.duration_seconds,
  });
  const open = db
    .prepare(
      `SELECT i.*,m.name monitor_name FROM incidents i JOIN monitors m ON m.id=i.monitor_id WHERE m.public=1 AND i.status='open' ORDER BY i.started_at DESC,i.rowid DESC`,
    )
    .all()
    .map(incident);
  const resolved = db
    .prepare(
      `SELECT i.*,m.name monitor_name FROM incidents i JOIN monitors m ON m.id=i.monitor_id WHERE m.public=1 AND i.status='resolved' ORDER BY i.resolved_at DESC,i.rowid DESC LIMIT 10`,
    )
    .all()
    .map(incident);
  return {
    generatedAt: now.toISOString(),
    overall: overallStatus(monitors),
    monitors,
    incidents: { open, resolved },
  };
}
export function renderStatusPageHtml(page: StatusPage): string {
  const labels: any = {
    operational: 'All systems operational',
    degraded: 'Degraded performance',
    partial_outage: 'Partial outage',
    major_outage: 'Major outage',
    unknown: 'No data yet',
  };
  const status: any = {
    up: 'Up',
    degraded: 'Degraded',
    down: 'Down',
    pending: 'Pending',
    paused: 'Paused',
  };
  const bars = (m: any) =>
    m.days
      .map((d: any) => {
        const text =
          d.uptimePercent === null ? `${d.date}: No data` : `${d.date}: ${d.uptimePercent}%`;
        return `<li class="bar bar-${uptimeLevel(d.uptimePercent)}" title="${esc(text)}"><span class="sr">${esc(text)}</span></li>`;
      })
      .join('');
  const incident = (x: any, resolved = false) =>
    `<li data-incident-id="${esc(x.id)}"><strong>${esc(x.monitorName)}</strong> Started <time datetime="${esc(x.startedAt)}">${esc(x.startedAt.slice(0, 16).replace('T', ' ') + ' UTC')}</time>${resolved ? ` Resolved <time datetime="${esc(x.resolvedAt)}">${esc(x.resolvedAt.slice(0, 16).replace('T', ' ') + ' UTC')}</time> · lasted ${formatDuration(x.durationSeconds)} ` : ''}</li>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="refresh" content="60"><title>Status</title><style>.sr{position:absolute;clip:rect(0,0,0,0)}</style></head><body><section id="overall" data-overall="${page.overall}">${labels[page.overall]}</section>${page.monitors.length ? `<ul>${page.monitors.map((m: any) => `<li data-monitor-id="${esc(m.id)}" data-status="${esc(m.status)}"><strong>${esc(m.name)}</strong> ${status[m.status]} ${m.uptime90dPercent === null ? 'No data' : `${m.uptime90dPercent}% uptime (90 days)`}<ol class="bars" aria-label="Daily uptime, last 90 days">${bars(m)}</ol></li>`).join('')}</ul>` : '<p>No public monitors yet.</p>'}<section><h2>Open incidents</h2>${page.incidents.open.length ? `<ul>${page.incidents.open.map((x) => incident(x)).join('')}</ul>` : '<p>No open incidents.</p>'}</section><section><h2>Resolved incidents</h2>${page.incidents.resolved.length ? `<ul>${page.incidents.resolved.map((x) => incident(x, true)).join('')}</ul>` : '<p>No incidents in the recent past.</p>'}</section><footer>Generated ${esc(page.generatedAt)} · Powered by Pulse</footer></body></html>`;
}
