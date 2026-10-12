import { z } from 'zod';

export const SESSION_COOKIE = 'pulse_session';
export const CSRF_HEADER = 'x-pulse-csrf';
export const API_KEY_PREFIX = 'pulse_';
/** `pulse_` followed by the base64url encoding of 32 random bytes. */
export const API_KEY_PATTERN = /^pulse_[A-Za-z0-9_-]{43}$/;
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
export const LOGIN_MAX_FAILURES = 5;
export const LOGIN_WINDOW_SECONDS = 15 * 60;

const IsoDateTime = z.string().datetime({ offset: true });

export const LoginRequestSchema = z.strictObject({
  email: z.string().trim().toLowerCase().max(254).pipe(z.email()),
  password: z.string().min(1).max(1024),
});
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

export const UserSchema = z.strictObject({ id: z.uuid(), email: z.string() });
export type User = z.infer<typeof UserSchema>;

export const SessionInfoSchema = z.strictObject({
  user: UserSchema,
  csrfToken: z.string(),
  expiresAt: IsoDateTime,
});
export type SessionInfo = z.infer<typeof SessionInfoSchema>;

export const ApiKeyScopeSchema = z.enum(['read', 'write']);
export type ApiKeyScope = z.infer<typeof ApiKeyScopeSchema>;

export const ApiKeySchema = z.strictObject({
  id: z.uuid(),
  name: z.string(),
  scope: ApiKeyScopeSchema,
  prefix: z.string(),
  createdAt: IsoDateTime,
  lastUsedAt: IsoDateTime.nullable(),
});
export type ApiKey = z.infer<typeof ApiKeySchema>;

export const ApiKeyCreateSchema = z.strictObject({
  name: z.string().trim().min(1).max(100),
  scope: ApiKeyScopeSchema.default('read'),
});
export type ApiKeyCreate = z.infer<typeof ApiKeyCreateSchema>;

export const ApiKeyUpdateSchema = z.strictObject({
  name: z.string().trim().min(1).max(100),
});
export type ApiKeyUpdate = z.infer<typeof ApiKeyUpdateSchema>;

export const ApiKeyCreatedSchema = ApiKeySchema.extend({
  key: z.string().regex(API_KEY_PATTERN),
});
export type ApiKeyCreated = z.infer<typeof ApiKeyCreatedSchema>;
