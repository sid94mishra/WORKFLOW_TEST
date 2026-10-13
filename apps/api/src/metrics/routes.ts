import type { FastifyInstance } from 'fastify';
import {
  CHECK_DURATION_BUCKETS,
  METRICS,
  METRICS_CONTENT_TYPE,
  activeWindowFor,
  bucketIndex,
  histogramSamples,
  renderPrometheus,
  type CheckOutcome,
} from '@pulse/shared';
import type { SqliteDatabase } from '../db.js';
import type { MaintenanceRepository } from '../maintenance/repository.js';
export class MetricsRegistry {
  counts = [0, 0];
  buckets = Array(CHECK_DURATION_BUCKETS.length + 1).fill(0) as number[];
  sum = 0;
  observe(o: CheckOutcome) {
    const i = o.ok ? 0 : 1,
      b = bucketIndex(CHECK_DURATION_BUCKETS, o.latencyMs / 1000);
    this.counts[i] = (this.counts[i] ?? 0) + 1;
    this.buckets[b] = (this.buckets[b] ?? 0) + 1;
    this.sum += o.latencyMs / 1000;
  }
}
export function metricsRoutes(
  app: FastifyInstance,
  db: SqliteDatabase,
  maintenance: MaintenanceRepository,
  registry: MetricsRegistry,
  opts: { public: boolean },
) {
  app.get('/metrics', { config: { public: opts.public } }, async (_req, reply) => {
    const now = new Date(),
      at = now.toISOString(),
      windows = maintenance.listRelevant(at);
    const monitors = db
      .prepare('SELECT id,name,status,enabled FROM monitors ORDER BY created_at,rowid')
      .all() as { id: string; name: string; status: string; enabled: number }[];
    const labels = (m: { id: string; name: string }) => ({ monitor: m.name, id: m.id });
    return reply
      .header('content-type', METRICS_CONTENT_TYPE)
      .header('cache-control', 'no-store')
      .send(
        renderPrometheus([
          {
            ...METRICS.monitorUp,
            samples: monitors
              .filter((m) => m.enabled && m.status !== 'pending')
              .map((m) => ({ labels: labels(m), value: m.status === 'up' ? 1 : 0 })),
          },
          {
            ...METRICS.checkDuration,
            samples: histogramSamples(CHECK_DURATION_BUCKETS, registry.buckets, registry.sum),
          },
          {
            ...METRICS.checksTotal,
            samples: [
              { labels: { result: 'ok' }, value: registry.counts[0] ?? 0 },
              { labels: { result: 'fail' }, value: registry.counts[1] ?? 0 },
            ],
          },
          {
            ...METRICS.openIncidents,
            samples: [
              {
                value: Number(
                  (
                    db
                      .prepare("SELECT count(*) count FROM incidents WHERE status='open'")
                      .get() as { count: number }
                  ).count,
                ),
              },
            ],
          },
          {
            ...METRICS.maintenanceActive,
            samples: monitors.map((m) => ({
              labels: labels(m),
              value: activeWindowFor(m.id, windows, now) ? 1 : 0,
            })),
          },
        ]),
      );
  });
}
