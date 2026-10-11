import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ChannelCreateSchema, ChannelUpdateSchema } from '@pulse/shared';
import { validateOutboundUrl, type ResolveHost } from '@pulse/checker';
import { apiError, issues } from '../errors.js';
import type { ChannelRepository, DeliveryRepository } from './repository.js';
import type { MonitorRepository } from '../monitors/repository.js';
import type { Notifier } from '../notifications/notifier.js';
const unsupported = (r: FastifyRequest) =>
  !!r.headers['content-type'] &&
  !r.headers['content-type']!.toLowerCase().startsWith('application/json');
const fail = (reply: FastifyReply, error: any) =>
  apiError(reply, 400, 'VALIDATION_ERROR', 'Request validation failed', issues(error));
export function channelRoutes(
  app: FastifyInstance,
  channels: ChannelRepository,
  monitors: MonitorRepository,
  deliveries: DeliveryRepository,
  notifier: Notifier,
  opts: { allowPrivate: boolean; resolveHost?: ResolveHost },
) {
  const get = (id: string) => channels.get(id);
  const monitorsOk = (ids: string[]) => {
    for (let i = 0; i < ids.length; i++) if (!monitors.get(ids[i]!)) return i;
    return -1;
  };
  const policy = async (url: string, reply: FastifyReply) => {
    const text = await validateOutboundUrl(url, {
      allowPrivate: opts.allowPrivate,
      resolveHost: opts.resolveHost,
    });
    if (!text) return false;
    apiError(reply, 400, 'VALIDATION_ERROR', 'Request validation failed', [
      { path: ['url'], code: 'custom', message: text },
    ]);
    return true;
  };
  app.get('/api/v1/channels', async () => ({ data: channels.list() }));
  app.post('/api/v1/channels', async (req, reply) => {
    if (unsupported(req))
      return apiError(reply, 415, 'UNSUPPORTED_MEDIA_TYPE', 'Unsupported media type');
    const body = ChannelCreateSchema.safeParse(req.body);
    if (!body.success) return fail(reply, body.error);
    const bad = monitorsOk(body.data.monitorIds);
    if (bad >= 0)
      return apiError(reply, 400, 'VALIDATION_ERROR', 'Request validation failed', [
        { path: ['monitorIds', bad], code: 'custom', message: 'monitor not found' },
      ]);
    if (await policy(body.data.url, reply)) return;
    const value = channels.create({
      ...body.data,
      monitorIds: [...new Set(body.data.monitorIds)],
      id: randomUUID(),
      createdAt: new Date().toISOString(),
    });
    return reply.code(201).header('location', `/api/v1/channels/${value.id}`).send({ data: value });
  });
  app.get<{ Params: { id: string } }>('/api/v1/channels/:id', async (req, reply) => {
    const c = get(req.params.id);
    return c ? { data: c } : apiError(reply, 404, 'NOT_FOUND', 'Channel not found');
  });
  app.patch<{ Params: { id: string } }>('/api/v1/channels/:id', async (req, reply) => {
    const old = get(req.params.id);
    if (!old) return apiError(reply, 404, 'NOT_FOUND', 'Channel not found');
    if (unsupported(req))
      return apiError(reply, 415, 'UNSUPPORTED_MEDIA_TYPE', 'Unsupported media type');
    const body = ChannelUpdateSchema.safeParse(req.body);
    if (!body.success) return fail(reply, body.error);
    if (body.data.monitorIds) {
      const bad = monitorsOk(body.data.monitorIds);
      if (bad >= 0)
        return apiError(reply, 400, 'VALIDATION_ERROR', 'Request validation failed', [
          { path: ['monitorIds', bad], code: 'custom', message: 'monitor not found' },
        ]);
      body.data.monitorIds = [...new Set(body.data.monitorIds)];
    }
    if (body.data.url && (await policy(body.data.url, reply))) return;
    return { data: channels.update(old.id, body.data) };
  });
  app.delete<{ Params: { id: string } }>('/api/v1/channels/:id', async (req, reply) =>
    channels.delete(req.params.id)
      ? reply.code(204).send()
      : apiError(reply, 404, 'NOT_FOUND', 'Channel not found'),
  );
  app.post<{ Params: { id: string } }>('/api/v1/channels/:id/test', async (req, reply) => {
    const c = get(req.params.id);
    return c
      ? { data: await notifier.sendTest(c) }
      : apiError(reply, 404, 'NOT_FOUND', 'Channel not found');
  });
  app.get<{ Params: { id: string } }>('/api/v1/channels/:id/deliveries', async (req, reply) =>
    get(req.params.id)
      ? { data: deliveries.listRecent(req.params.id) }
      : apiError(reply, 404, 'NOT_FOUND', 'Channel not found'),
  );
}
