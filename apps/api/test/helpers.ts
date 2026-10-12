import type { FastifyInstance, InjectOptions } from 'fastify';
import { buildApp as buildProductionApp } from '../src/app.js';

const email = 'test-admin@example.com';
const password = 'test-password-that-is-long-enough';
const auth = {
  admin: { email, password },
  sessionSecret: 't'.repeat(32),
  scryptParams: { N: 1024, r: 8, p: 1 },
};

/** Supplies the browser credentials that pre-authentication iteration tests now require. */
export async function buildTestApp(
  options: Parameters<typeof buildProductionApp>[0],
): Promise<FastifyInstance> {
  const app = await buildProductionApp({ ...options, auth: options.auth ?? auth });
  const inject = app.inject.bind(app);
  const login = await inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email, password },
  });
  const setCookie = login.headers['set-cookie'];
  const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)!.split(';', 1)[0]!;
  const csrfToken = login.json().data.csrfToken as string;

  app.inject = ((input: string | InjectOptions, maybeOptions?: InjectOptions) => {
    const request =
      typeof input === 'string' ? { ...(maybeOptions ?? {}), url: input } : { ...input };
    const url = typeof request.url === 'string' ? request.url : (request.url?.pathname ?? '');
    if (url.startsWith('/api/v1/auth/login')) return inject(request);
    const method = request.method ?? 'GET';
    const headers = {
      cookie,
      ...(method !== 'GET' && method !== 'HEAD' ? { 'x-pulse-csrf': csrfToken } : {}),
      ...(request.headers ?? {}),
    };
    return inject({ ...request, headers });
  }) as FastifyInstance['inject'];
  return app;
}
