import type { FastifyInstance, FastifyRequest } from 'fastify';
import { LoginRequestSchema, SESSION_COOKIE } from '@pulse/shared';
import { apiError, issues } from '../errors.js';
import type { SqliteDatabase } from '../db.js';
import type { LoginRateLimiter } from './rate-limit.js';
import type { SessionStore } from './sessions.js';

export function authRoutes(
  app: FastifyInstance,
  db: SqliteDatabase,
  sessions: SessionStore,
  limiter: LoginRateLimiter,
  dummyHash: string,
  cookieSecure: 'auto' | boolean,
): void {
  const cookieOptions = (request: FastifyRequest) => ({
    signed: true,
    httpOnly: true,
    sameSite: 'lax' as const,
    path: '/',
    maxAge: 7 * 24 * 60 * 60,
    secure: cookieSecure === 'auto' ? request.protocol === 'https' : cookieSecure,
  });
  app.post('/api/v1/auth/login', { config: { public: true } }, async (request, reply) => {
    const body = LoginRequestSchema.safeParse(request.body);
    if (!body.success)
      return apiError(
        reply,
        400,
        'VALIDATION_ERROR',
        'Request validation failed',
        issues(body.error),
      );
    const key = `${request.ip}|${body.data.email}`;
    const allowed = limiter.check(key);
    if (!allowed.allowed)
      return apiError(
        reply.header('retry-after', String(allowed.retryAfterSeconds)),
        429,
        'RATE_LIMITED',
        'Too many login attempts; try again later',
      );
    const user = db
      .prepare('SELECT id,email,password_hash FROM users WHERE email = ?')
      .get(body.data.email) as { id: string; email: string; password_hash: string } | undefined;
    const { verifyPassword } = await import('./password.js');
    const valid = await verifyPassword(body.data.password, user?.password_hash ?? dummyHash);
    if (!user || !valid) {
      limiter.recordFailure(key);
      return apiError(reply, 401, 'UNAUTHORIZED', 'Invalid email or password');
    }
    limiter.reset(key);
    const session = sessions.create(user.id);
    reply.setCookie(SESSION_COOKIE, session.id, cookieOptions(request));
    return {
      data: {
        user: { id: user.id, email: user.email },
        csrfToken: session.csrfToken,
        expiresAt: session.expiresAt,
      },
    };
  });
  app.get('/api/v1/auth/session', async (request, reply) => {
    const auth = request.auth!;
    if (auth.kind !== 'session')
      return apiError(reply, 403, 'FORBIDDEN', 'This endpoint requires a browser session');
    return {
      data: {
        user: { id: auth.userId, email: auth.email },
        csrfToken: auth.csrfToken,
        expiresAt: sessions.lookup(auth.sessionId)!.expiresAt,
      },
    };
  });
  app.post('/api/v1/auth/logout', async (request, reply) => {
    const auth = request.auth!;
    if (auth.kind !== 'session')
      return apiError(reply, 403, 'FORBIDDEN', 'This endpoint requires a browser session');
    sessions.revoke(auth.sessionId);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return reply.code(204).send();
  });
}
