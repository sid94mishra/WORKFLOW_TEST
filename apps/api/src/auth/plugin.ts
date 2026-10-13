import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { API_KEY_PATTERN, CSRF_HEADER, SESSION_COOKIE } from '@pulse/shared';
import { apiError } from '../errors.js';
import type { ApiKeyRepository } from '../api-keys/repository.js';
import type { SessionStore } from './sessions.js';

export type RequestAuth =
  | { kind: 'session'; userId: string; email: string; csrfToken: string; sessionId: string }
  | { kind: 'apiKey'; keyId: string; scope: 'read' | 'write' };

declare module 'fastify' {
  interface FastifyRequest {
    auth?: RequestAuth;
  }
}

const sessionOnly = (path: string) =>
  path.startsWith('/api/v1/api-keys') ||
  path === '/api/v1/auth/session' ||
  path === '/api/v1/auth/logout';
const secureEqual = (a: string, b: string) => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

export function authPlugin(
  app: FastifyInstance,
  sessions: SessionStore,
  keys: ApiKeyRepository,
): void {
  app.addHook('onRequest', async (request, reply) => {
    // Gate on the matched route pattern: the router percent-decodes paths, so the raw URL
    // `/%61pi/v1/monitors` reaches `/api/v1/monitors`. Unmatched requests fall back to the raw path.
    const path = request.routeOptions.url ?? request.url.split('?')[0]!;
    if (!path.startsWith('/api/v1/')) return;
    if ((request.routeOptions.config as { public?: boolean }).public === true) return;
    const authorization = request.headers.authorization;
    if (authorization !== undefined) {
      const match = /^Bearer\s+(\S+)$/i.exec(authorization);
      const key = match?.[1];
      const result = key && API_KEY_PATTERN.test(key) ? keys.authenticate(key) : undefined;
      if (!result)
        return apiError(
          reply.header('www-authenticate', 'Bearer realm="pulse"'),
          401,
          'UNAUTHORIZED',
          'Authentication required',
        );
      if (sessionOnly(path))
        return apiError(reply, 403, 'FORBIDDEN', 'This endpoint requires a browser session');
      if (result.scope === 'read' && !['GET', 'HEAD'].includes(request.method))
        return apiError(
          reply,
          403,
          'FORBIDDEN',
          `API key scope 'read' does not allow ${request.method}`,
        );
      request.auth = { kind: 'apiKey', keyId: result.id, scope: result.scope };
      return;
    }
    const parsed = request.unsignCookie(request.cookies[SESSION_COOKIE] ?? '');
    const session = parsed.valid ? sessions.lookup(parsed.value) : undefined;
    if (!session)
      return apiError(
        reply.header('www-authenticate', 'Bearer realm="pulse"'),
        401,
        'UNAUTHORIZED',
        'Authentication required',
      );
    request.auth = {
      kind: 'session',
      userId: session.userId,
      email: session.email,
      csrfToken: session.csrfToken,
      sessionId: session.id,
    };
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) {
      const token = request.headers[CSRF_HEADER] as string | undefined;
      if (!token || !secureEqual(token, session.csrfToken))
        return apiError(reply, 403, 'CSRF_FAILED', 'Missing or invalid CSRF token');
    }
  });
}
