import { readFileSync } from 'node:fs';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import type { HealthResponse } from '@pulse/shared';
import { postJson, runHttpCheck, type ResolveHost } from '@pulse/checker';
import { openDatabase } from './db.js';
import { migrate } from './migrate.js';
import { MonitorRepository } from './monitors/repository.js';
import { monitorRoutes } from './monitors/routes.js';
import { ResultRepository } from './results/repository.js';
import { Scheduler, type SchedulerDeps } from './scheduler/scheduler.js';
import { apiError } from './errors.js';
import { ChannelRepository, DeliveryRepository } from './channels/repository.js';
import { channelRoutes } from './channels/routes.js';
import { Notifier } from './notifications/notifier.js';
import { incidentRoutes } from './incidents/routes.js';
import { statusRoutes } from './status/routes.js';
import { badgeRoutes } from './badges/routes.js';

// `../package.json` resolves to apps/api/package.json from both src/ and dist/.
const { version } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { version: string };

export type SchedulerOptions = {
  maxConcurrency: number;
  /** Deprecated compatibility option; top-level allowPrivate takes precedence. */
  allowPrivate?: boolean;
  runCheck?: SchedulerDeps['runCheck'];
  random?: () => number;
};

declare module 'fastify' {
  interface FastifyInstance {
    scheduler?: Scheduler;
  }
}

export async function buildApp(opts: {
  databasePath: string;
  logger?: boolean | object;
  scheduler?: false | SchedulerOptions;
  allowPrivate?: boolean;
  egress?: {
    resolveHost?: ResolveHost;
    fetch?: NonNullable<Parameters<typeof runHttpCheck>[1]>['fetch'];
  };
  notifier?: { maxConcurrency?: number; retryDelaysMs?: readonly number[] };
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
  const monitors = new MonitorRepository(db);
  const results = new ResultRepository(db);
  const channels = new ChannelRepository(db);
  const deliveries = new DeliveryRepository(db);
  const notifier = new Notifier({
    listChannels: (id) => channels.listEnabledForMonitor(id),
    getChannel: (id) => channels.get(id),
    send: (channel, body) =>
      postJson(channel.url, body, {
        allowPrivate: opts.allowPrivate ?? false,
        resolveHost: opts.egress?.resolveHost,
        fetch: opts.egress?.fetch,
        headers: {
          'user-agent': 'Pulse/0.1 (+notifications)',
          ...(channel.kind === 'webhook'
            ? { 'x-pulse-event': (body as { event?: string }).event ?? 'test' }
            : {}),
        },
      }),
    recordAttempt: (attempt) => {
      deliveries.record(attempt);
    },
    maxConcurrency: opts.notifier?.maxConcurrency,
    retryDelaysMs: opts.notifier?.retryDelaysMs,
    log: app.log,
  });
  const schedulerOptions = opts.scheduler === false ? undefined : opts.scheduler;
  const scheduler = schedulerOptions
    ? new Scheduler({
        listEnabled: () => monitors.listEnabled(),
        runCheck:
          schedulerOptions.runCheck ??
          ((monitor) =>
            runHttpCheck(monitor, {
              allowPrivate: opts.allowPrivate ?? schedulerOptions.allowPrivate ?? false,
              resolveHost: opts.egress?.resolveHost,
              fetch: opts.egress?.fetch,
            })),
        record: (monitorId, outcome) => {
          const recorded = results.record(monitorId, outcome);
          if (recorded?.event) notifier.enqueue(recorded.event);
        },
        maxConcurrency: schedulerOptions.maxConcurrency,
        random: schedulerOptions.random,
        log: app.log,
      })
    : undefined;
  if (scheduler) app.decorate('scheduler', scheduler);
  app.addHook('onReady', async () => {
    scheduler?.start();
  });
  app.addHook('onClose', async () => {
    await scheduler?.stop();
    await notifier.stop();
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

  monitorRoutes(app, monitors, results, scheduler);
  incidentRoutes(app, db);
  channelRoutes(app, channels, monitors, deliveries, notifier, {
    allowPrivate: opts.allowPrivate ?? false,
    resolveHost: opts.egress?.resolveHost,
  });
  statusRoutes(app, db);
  badgeRoutes(app, monitors, results);

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
