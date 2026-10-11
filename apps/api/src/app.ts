import { readFileSync } from 'node:fs';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import type { HealthResponse } from '@pulse/shared';
import { openDatabase } from './db.js';
import { migrate } from './migrate.js';
import { MonitorRepository } from './monitors/repository.js';
import { monitorRoutes } from './monitors/routes.js';
import { apiError } from './errors.js';

// `../package.json` resolves to apps/api/package.json from both src/ and dist/.
const { version } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { version: string };

export async function buildApp(opts: {
  databasePath: string;
  logger?: boolean | object;
}): Promise<FastifyInstance> {
  const db = openDatabase(opts.databasePath);
  try {
    migrate(db);
  } catch (error) {
    db.close();
    throw error;
  }

  const app = Fastify({ logger: opts.logger ?? false });
  app.decorate('db', db);
  app.addHook('onClose', async () => {
    db.close();
  });

  app.get('/health', async (request, reply) => {
    try {
      db.prepare('SELECT 1').get();
    } catch (error) {
      request.log.error(error);
      return apiError(reply, 503, 'INTERNAL_ERROR', 'Internal server error');
    }
    const body: HealthResponse = {
      status: 'ok',
      version,
      uptimeSeconds: Math.floor(process.uptime()),
    };
    return body;
  });

  monitorRoutes(app, new MonitorRepository(db));

  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (
      error.code === 'FST_ERR_CTP_INVALID_JSON_BODY' ||
      error.code === 'FST_ERR_CTP_EMPTY_JSON_BODY'
    ) {
      return apiError(reply, 400, 'BAD_REQUEST', 'Malformed JSON body');
    }
    if (error.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') {
      return apiError(reply, 415, 'UNSUPPORTED_MEDIA_TYPE', 'Unsupported media type');
    }
    // Other Fastify client errors (e.g. 413 body too large) keep their status; their messages
    // are generic and safe to expose.
    const status = error.statusCode ?? 500;
    if (status >= 400 && status < 500) {
      return apiError(reply, status, 'BAD_REQUEST', error.message);
    }
    request.log.error(error);
    return apiError(reply, 500, 'INTERNAL_ERROR', 'Internal server error');
  });

  app.setNotFoundHandler((_request, reply) => {
    return apiError(reply, 404, 'NOT_FOUND', 'Route not found');
  });

  return app;
}
