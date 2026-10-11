import { z } from 'zod';
import { resolve } from 'node:path';

const envSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().default('127.0.0.1'),
  DATABASE_PATH: z.string().default('./data/pulse.db'),
  LOG_LEVEL: z.string().default('info'),
  PULSE_MAX_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(8),
  PULSE_ALLOW_PRIVATE: z.enum(['0', '1']).default('0'),
});

export type Config = {
  port: number;
  host: string;
  databasePath: string;
  logLevel: string;
  maxConcurrency: number;
  allowPrivate: boolean;
};

export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const value = envSchema.parse(env);
  return {
    port: value.PORT,
    host: value.HOST,
    databasePath: value.DATABASE_PATH === ':memory:' ? ':memory:' : resolve(value.DATABASE_PATH),
    logLevel: value.LOG_LEVEL,
    maxConcurrency: value.PULSE_MAX_CONCURRENCY,
    allowPrivate: value.PULSE_ALLOW_PRIVATE === '1',
  };
}
