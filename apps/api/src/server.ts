import { buildApp } from './app.js';
import { readConfig } from './config.js';

const config = readConfig();
const app = await buildApp({
  databasePath: config.databasePath,
  logger: { level: config.logLevel },
});

async function shutdown(): Promise<void> {
  await app.close();
  process.exit(0);
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

await app.listen({ port: config.port, host: config.host });
