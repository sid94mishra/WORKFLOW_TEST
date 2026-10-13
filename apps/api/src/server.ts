import { pathToFileURL } from 'node:url';
import { buildApp } from './app.js';
import { readConfig } from './config.js';

export async function start(opts: { exit?: (code: number) => void; env?: NodeJS.ProcessEnv } = {}) {
  const config = readConfig(opts.env);
  const app = await buildApp({
    databasePath: config.databasePath,
    logger: { level: config.logLevel },
    allowPrivate: config.allowPrivate,
    scheduler: { maxConcurrency: config.maxConcurrency },
    auth: config.auth,
    trustProxy: config.trustProxy,
    webDir: config.webDir,
  });
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  if (app.adminBootstrap === 'missing') {
    app.log.error(
      'No admin account exists; set PULSE_ADMIN_EMAIL and PULSE_ADMIN_PASSWORD before first start',
    );
    await app.close();
    exit(1);
    return app;
  }
  if (app.adminBootstrap === 'exists' && config.auth.admin)
    app.log.info('admin account exists; PULSE_ADMIN_* ignored');
  if (app.adminBootstrap === 'created' && config.auth.admin)
    app.log.info(`admin account created for ${config.auth.admin.email}`);
  if (config.allowPrivate)
    app.log.warn('PULSE_ALLOW_PRIVATE=1: private addresses are allowed; do not use in production');
  if (
    config.auth.cookieSecure === false ||
    (config.auth.cookieSecure === 'auto' &&
      config.host !== '127.0.0.1' &&
      config.host !== 'localhost' &&
      config.trustProxy === false)
  ) {
    app.log.warn('cookies will not be Secure unless served over HTTPS');
  }
  const shutdown = async () => {
    await app.close();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  await app.listen({ port: config.port, host: config.host });
  return app;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await start();
