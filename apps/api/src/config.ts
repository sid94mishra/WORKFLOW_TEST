import { z } from 'zod';
import { resolve } from 'node:path';

const envSchema = z
  .object({
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    HOST: z.string().default('127.0.0.1'),
    DATABASE_PATH: z.string().default('./data/pulse.db'),
    LOG_LEVEL: z.string().default('info'),
    PULSE_MAX_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(8),
    PULSE_ALLOW_PRIVATE: z.enum(['0', '1']).default('0'),
    PULSE_ADMIN_EMAIL: z.string().trim().toLowerCase().pipe(z.email()).optional(),
    PULSE_ADMIN_PASSWORD: z.string().min(12).max(1024).optional(),
    PULSE_SESSION_SECRET: z.string().min(32).optional(),
    PULSE_COOKIE_SECURE: z.enum(['auto', 'true', 'false']).default('auto'),
    PULSE_TRUST_PROXY: z.string().default('false'),
    PULSE_WEB_DIR: z.string().min(1).optional(),
    PULSE_METRICS_PUBLIC: z.enum(['true', 'false']).default('false'),
  })
  .superRefine((value, ctx) => {
    if (Boolean(value.PULSE_ADMIN_EMAIL) !== Boolean(value.PULSE_ADMIN_PASSWORD)) {
      ctx.addIssue({
        code: 'custom',
        path: ['PULSE_ADMIN_EMAIL'],
        message: 'PULSE_ADMIN_EMAIL and PULSE_ADMIN_PASSWORD must be set together',
      });
    }
  });

export type Config = {
  port: number;
  host: string;
  databasePath: string;
  logLevel: string;
  maxConcurrency: number;
  allowPrivate: boolean;
  auth: {
    admin?: { email: string; password: string };
    sessionSecret?: string;
    cookieSecure: 'auto' | boolean;
  };
  trustProxy: boolean | number | string[];
  webDir?: string;
  metricsPublic: boolean;
};

export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    // Zod's formatted error includes values in some versions; never let a password escape.
    throw new Error(
      parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '),
    );
  }
  const value = parsed.data;
  const proxy = value.PULSE_TRUST_PROXY.trim();
  const trustProxy =
    proxy === 'true'
      ? true
      : proxy === 'false'
        ? false
        : /^\d+$/.test(proxy)
          ? Number(proxy)
          : proxy
              .split(',')
              .map((entry) => entry.trim())
              .filter(Boolean);
  return {
    port: value.PORT,
    host: value.HOST,
    databasePath: value.DATABASE_PATH === ':memory:' ? ':memory:' : resolve(value.DATABASE_PATH),
    logLevel: value.LOG_LEVEL,
    maxConcurrency: value.PULSE_MAX_CONCURRENCY,
    allowPrivate: value.PULSE_ALLOW_PRIVATE === '1',
    auth: {
      admin: value.PULSE_ADMIN_EMAIL
        ? { email: value.PULSE_ADMIN_EMAIL, password: value.PULSE_ADMIN_PASSWORD! }
        : undefined,
      sessionSecret: value.PULSE_SESSION_SECRET,
      cookieSecure:
        value.PULSE_COOKIE_SECURE === 'auto' ? 'auto' : value.PULSE_COOKIE_SECURE === 'true',
    },
    trustProxy,
    webDir: value.PULSE_WEB_DIR ? resolve(value.PULSE_WEB_DIR) : undefined,
    metricsPublic: value.PULSE_METRICS_PUBLIC === 'true',
  };
}
