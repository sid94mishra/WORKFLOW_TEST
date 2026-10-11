import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  MonitorCreateSchema,
  MonitorSchema,
  MonitorUpdateSchema,
  ResultsQuerySchema,
  UptimeQuerySchema,
} from '@pulse/shared';
import type { ZodError } from 'zod';
import { apiError, issues } from '../errors.js';
import type { MonitorRepository } from './repository.js';
import type { ResultRepository } from '../results/repository.js';
import type { Scheduler } from '../scheduler/scheduler.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type IdParams = { Params: { id: string } };

function isUuid(id: string): boolean {
  return UUID_PATTERN.test(id);
}

/**
 * Bodies must be JSON when a content type is sent. A request with no content type (and so no
 * parsed body) falls through to validation, which rejects `undefined` with 400 (spec §4.4).
 */
function hasUnsupportedContentType(request: FastifyRequest): boolean {
  const contentType = request.headers['content-type'];
  if (contentType === undefined) return false;
  return !contentType.toLowerCase().startsWith('application/json');
}

function unsupportedMediaType(reply: FastifyReply) {
  return apiError(reply, 415, 'UNSUPPORTED_MEDIA_TYPE', 'Unsupported media type');
}

function validationFailed(reply: FastifyReply, error: ZodError) {
  return apiError(reply, 400, 'VALIDATION_ERROR', 'Request validation failed', issues(error));
}

function monitorNotFound(reply: FastifyReply) {
  return apiError(reply, 404, 'NOT_FOUND', 'Monitor not found');
}

export function monitorRoutes(
  app: FastifyInstance,
  repository: MonitorRepository,
  results: ResultRepository,
  scheduler?: Scheduler,
): void {
  const findMonitor = (id: string) => (isUuid(id) ? repository.get(id) : undefined);

  app.get('/api/v1/monitors', async () => {
    return { data: repository.list() };
  });

  app.get<IdParams>('/api/v1/monitors/:id', async (request, reply) => {
    const monitor = findMonitor(request.params.id);
    if (!monitor) return monitorNotFound(reply);
    return { data: monitor };
  });

  app.get<IdParams>('/api/v1/monitors/:id/results', async (request, reply) => {
    const monitor = findMonitor(request.params.id);
    if (!monitor) return monitorNotFound(reply);
    const query = ResultsQuerySchema.safeParse(request.query);
    if (!query.success) return validationFailed(reply, query.error);
    return { data: results.listRecent(monitor.id, query.data.limit) };
  });

  app.get<IdParams>('/api/v1/monitors/:id/uptime', async (request, reply) => {
    const monitor = findMonitor(request.params.id);
    if (!monitor) return monitorNotFound(reply);
    const query = UptimeQuerySchema.safeParse(request.query);
    if (!query.success) return validationFailed(reply, query.error);
    return { data: results.uptime(monitor.id, query.data.window) };
  });

  app.post('/api/v1/monitors', async (request, reply) => {
    if (hasUnsupportedContentType(request)) return unsupportedMediaType(reply);

    const result = MonitorCreateSchema.safeParse(request.body);
    if (!result.success) return validationFailed(reply, result.error);

    const monitor = repository.create({
      ...result.data,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
    });
    scheduler?.upsert(monitor);
    return reply
      .code(201)
      .header('location', `/api/v1/monitors/${monitor.id}`)
      .send({ data: monitor });
  });

  app.patch<IdParams>('/api/v1/monitors/:id', async (request, reply) => {
    // 404 wins over 400/415 (spec §4.6).
    const existing = findMonitor(request.params.id);
    if (!existing) return monitorNotFound(reply);
    if (hasUnsupportedContentType(request)) return unsupportedMediaType(reply);

    const patch = MonitorUpdateSchema.safeParse(request.body);
    if (!patch.success) return validationFailed(reply, patch.error);

    // The HEAD/keyword rule only makes sense on the merged monitor.
    const merged = MonitorSchema.safeParse({ ...existing, ...patch.data });
    if (!merged.success) return validationFailed(reply, merged.error);

    const monitor = repository.update(existing.id, patch.data);
    scheduler?.upsert(monitor);
    return { data: monitor };
  });

  app.delete<IdParams>('/api/v1/monitors/:id', async (request, reply) => {
    const { id } = request.params;
    if (!isUuid(id) || !repository.delete(id)) return monitorNotFound(reply);
    scheduler?.remove(id);
    return reply.code(204).send();
  });
}
