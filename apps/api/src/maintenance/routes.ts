import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  MaintenanceWindowCreateSchema,
  MaintenanceWindowUpdateSchema,
  isWindowActive,
  nextOccurrence,
  type MaintenanceWindowCreate,
} from '@pulse/shared';
import type { ZodError } from 'zod';
import { apiError, issues } from '../errors.js';
import type { MonitorRepository } from '../monitors/repository.js';
import { MaintenanceRepository, type MaintenanceRow } from './repository.js';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const invalid = (reply: FastifyReply, e: ZodError) =>
  apiError(reply, 400, 'VALIDATION_ERROR', 'Request validation failed', issues(e));
const notFound = (reply: FastifyReply) =>
  apiError(reply, 404, 'NOT_FOUND', 'Maintenance window not found');
const response = (row: MaintenanceRow, now = new Date()) => ({
  ...row,
  active: isWindowActive(row, now),
  nextOccurrence: nextOccurrence(row, now),
});
const nonJson = (r: FastifyRequest) =>
  r.headers['content-type'] !== undefined &&
  !r.headers['content-type']!.toLowerCase().startsWith('application/json');
export function maintenanceRoutes(
  app: FastifyInstance,
  repo: MaintenanceRepository,
  monitors: MonitorRepository,
) {
  const get = (id: string) => (uuid.test(id) ? repo.get(id) : undefined);
  const validateMonitors = (input: MaintenanceWindowCreate, reply: FastifyReply) => {
    if (input.monitorIds === 'all') return true;
    const dedup: string[] = [];
    for (let i = 0; i < input.monitorIds.length; i++) {
      const monitorId = input.monitorIds[i]!;
      if (!monitors.get(monitorId)) {
        apiError(reply, 400, 'VALIDATION_ERROR', 'Request validation failed', [
          { path: ['monitorIds', i], code: 'custom', message: 'monitor not found' },
        ]);
        return false;
      }
      if (!dedup.includes(monitorId)) dedup.push(monitorId);
    }
    input.monitorIds = dedup;
    return true;
  };
  app.get('/api/v1/maintenance', async () => ({ data: repo.list().map((x) => response(x)) }));
  app.get<{ Params: { id: string } }>('/api/v1/maintenance/:id', async (req, reply) => {
    const row = get(req.params.id);
    return row ? { data: response(row) } : notFound(reply);
  });
  app.post('/api/v1/maintenance', async (req, reply) => {
    if (nonJson(req))
      return apiError(reply, 415, 'UNSUPPORTED_MEDIA_TYPE', 'Unsupported media type');
    const p = MaintenanceWindowCreateSchema.safeParse(req.body);
    if (!p.success) return invalid(reply, p.error);
    if (!validateMonitors(p.data, reply)) return;
    const by =
      req.auth?.kind === 'session'
        ? { kind: 'user' as const, id: req.auth.userId }
        : { kind: 'apiKey' as const, id: req.auth!.keyId };
    const row = repo.create(
      { ...p.data, id: randomUUID(), createdAt: new Date().toISOString() },
      by,
    );
    return reply
      .code(201)
      .header('location', `/api/v1/maintenance/${row.id}`)
      .send({ data: response(row) });
  });
  app.patch<{ Params: { id: string } }>('/api/v1/maintenance/:id', async (req, reply) => {
    const old = get(req.params.id);
    if (!old) return notFound(reply);
    if (nonJson(req))
      return apiError(reply, 415, 'UNSUPPORTED_MEDIA_TYPE', 'Unsupported media type');
    const p = MaintenanceWindowUpdateSchema.safeParse(req.body);
    if (!p.success) return invalid(reply, p.error);
    const full = MaintenanceWindowCreateSchema.safeParse({
      title: old.title,
      monitorIds: old.monitorIds,
      startsAt: old.startsAt,
      endsAt: old.endsAt,
      repeat: old.repeat,
      ...p.data,
    });
    if (!full.success) return invalid(reply, full.error);
    if (!validateMonitors(full.data, reply)) return;
    return { data: response(repo.update(old.id, full.data)) };
  });
  app.delete<{ Params: { id: string } }>('/api/v1/maintenance/:id', async (req, reply) =>
    !uuid.test(req.params.id) || !repo.delete(req.params.id)
      ? notFound(reply)
      : reply.code(204).send(),
  );
}
