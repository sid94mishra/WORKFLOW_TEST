import type { FastifyInstance } from 'fastify';
import { IncidentsQuerySchema, type Incident } from '@pulse/shared';
import { apiError, issues } from '../errors.js';
import type { SqliteDatabase } from '../db.js';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const map = (r: any): Incident => ({
  id: r.id,
  monitorId: r.monitor_id,
  monitorName: r.monitor_name,
  status: r.status,
  cause: r.cause,
  startedAt: r.started_at,
  resolvedAt: r.resolved_at,
  durationSeconds: r.duration_seconds,
});
export function incidentRoutes(app: FastifyInstance, db: SqliteDatabase) {
  app.get('/api/v1/incidents', async (req, reply) => {
    const q = IncidentsQuerySchema.safeParse(req.query);
    if (!q.success)
      return apiError(reply, 400, 'VALIDATION_ERROR', 'Request validation failed', issues(q.error));
    let where = '';
    const vals: any[] = [];
    if (q.data.status !== 'all') {
      where += ' WHERE i.status=?';
      vals.push(q.data.status);
    }
    if (q.data.monitorId) {
      where += where ? ' AND' : ' WHERE';
      where += ' i.monitor_id=?';
      vals.push(q.data.monitorId);
    }
    const rows = db
      .prepare(
        `SELECT i.*,m.name monitor_name FROM incidents i JOIN monitors m ON m.id=i.monitor_id${where} ORDER BY CASE i.status WHEN 'open' THEN 0 ELSE 1 END, CASE WHEN i.status='open' THEN i.started_at END DESC, CASE WHEN i.status='resolved' THEN i.resolved_at END DESC,i.rowid DESC LIMIT ?`,
      )
      .all(...vals, q.data.limit);
    return { data: (rows as any[]).map(map) };
  });
  app.get<{ Params: { id: string } }>('/api/v1/incidents/:id', async (req, reply) => {
    if (!uuid.test(req.params.id)) return apiError(reply, 404, 'NOT_FOUND', 'Incident not found');
    const row = db
      .prepare(
        'SELECT i.*,m.name monitor_name FROM incidents i JOIN monitors m ON m.id=i.monitor_id WHERE i.id=?',
      )
      .get(req.params.id);
    return row ? { data: map(row) } : apiError(reply, 404, 'NOT_FOUND', 'Incident not found');
  });
}
