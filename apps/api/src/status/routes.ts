import type { FastifyInstance } from 'fastify';
import type { SqliteDatabase } from '../db.js';
import { buildStatusPage, renderStatusPageHtml } from './page.js';
export function statusRoutes(app: FastifyInstance, db: SqliteDatabase) {
  app.get('/api/v1/status', { config: { public: true } }, async (_req, reply) =>
    reply
      .header('cache-control', 'public, max-age=30')
      .send({ data: buildStatusPage(db, new Date()) }),
  );
  app.get('/status', async (_req, reply) =>
    reply
      .header('content-type', 'text/html; charset=utf-8')
      .header('cache-control', 'public, max-age=30')
      .header(
        'content-security-policy',
        "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'",
      )
      .header('x-content-type-options', 'nosniff')
      .send(renderStatusPageHtml(buildStatusPage(db, new Date()))),
  );
}
