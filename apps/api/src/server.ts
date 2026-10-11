import { buildApp } from './app.js';
import { readConfig } from './config.js';

const config = readConfig();
const app = await buildApp({
  databasePath: config.databasePath,
  logger: { level: config.logLevel },
  allowPrivate: config.allowPrivate,
  scheduler: { maxConcurrency: config.maxConcurrency },
});

if (config.allowPrivate) {
  app.log.warn('PULSE_ALLOW_PRIVATE=1: private addresses are allowed; do not use in production');
}

async function shutdown(): Promise<void> {
  await app.close();
  process.exit(0);
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

await app.listen({ port: config.port, host: config.host });
