import { z } from 'zod';
import { resolve } from 'node:path';

const envSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().default('127.0.0.1'),
  DATABASE_PATH: z.string().default('./data/pulse.db'),
  LOG_LEVEL: z.string().default('info'),
});

export type Config = { port: number; host: string; databasePath: string; logLevel: string };

export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const value = envSchema.parse(env);
  return {
    port: value.PORT,
    host: value.HOST,
    databasePath: value.DATABASE_PATH === ':memory:' ? ':memory:' : resolve(value.DATABASE_PATH),
    logLevel: value.LOG_LEVEL,
  };
}
