import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ApiKeyCreateSchema, ApiKeyUpdateSchema } from '@pulse/shared';
import { apiError, issues } from '../errors.js';
import type { ApiKeyRepository } from './repository.js';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const unsupported = (request: FastifyRequest) =>
  !!request.headers['content-type'] &&
  !request.headers['content-type']!.toLowerCase().startsWith('application/json');
const invalid = (reply: FastifyReply, error: any) =>
  apiError(reply, 400, 'VALIDATION_ERROR', 'Request validation failed', issues(error));
export function apiKeyRoutes(app: FastifyInstance, keys: ApiKeyRepository): void {
  app.get('/api/v1/api-keys', async () => ({ data: keys.list() }));
  app.post('/api/v1/api-keys', async (request, reply) => {
    if (unsupported(request))
      return apiError(reply, 415, 'UNSUPPORTED_MEDIA_TYPE', 'Unsupported media type');
    const body = ApiKeyCreateSchema.safeParse(request.body);
    if (!body.success) return invalid(reply, body.error);
    const auth = request.auth!;
    if (auth.kind !== 'session')
      return apiError(reply, 403, 'FORBIDDEN', 'This endpoint requires a browser session');
    const created = keys.create({ ...body.data, userId: auth.userId });
    return reply
      .code(201)
      .header('location', `/api/v1/api-keys/${created.id}`)
      .header('cache-control', 'no-store')
      .send({ data: created });
  });
  app.get<{ Params: { id: string } }>('/api/v1/api-keys/:id', async (request, reply) => {
    const key = UUID.test(request.params.id) ? keys.get(request.params.id) : undefined;
    return key ? { data: key } : apiError(reply, 404, 'NOT_FOUND', 'API key not found');
  });
  app.patch<{ Params: { id: string } }>('/api/v1/api-keys/:id', async (request, reply) => {
    if (!UUID.test(request.params.id) || !keys.get(request.params.id))
      return apiError(reply, 404, 'NOT_FOUND', 'API key not found');
    if (unsupported(request))
      return apiError(reply, 415, 'UNSUPPORTED_MEDIA_TYPE', 'Unsupported media type');
    const body = ApiKeyUpdateSchema.safeParse(request.body);
    if (!body.success) return invalid(reply, body.error);
    return { data: keys.rename(request.params.id, body.data.name)! };
  });
  app.delete<{ Params: { id: string } }>('/api/v1/api-keys/:id', async (request, reply) =>
    UUID.test(request.params.id) && keys.revoke(request.params.id)
      ? reply.code(204).send()
      : apiError(reply, 404, 'NOT_FOUND', 'API key not found'),
  );
}
