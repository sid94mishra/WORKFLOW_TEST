import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp as buildApp } from './helpers.js';
describe('static dashboard hosting', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  afterEach(async () => {
    await app?.close();
  });
  it('serves the configured assets without an SPA fallback', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pulse-web-'));
    mkdirSync(join(dir, 'assets'));
    writeFileSync(join(dir, 'index.html'), '<h1>Pulse</h1>');
    writeFileSync(join(dir, 'assets', 'x.js'), 'export {}');
    app = await buildApp({ databasePath: ':memory:', webDir: dir });
    expect((await app.inject('/')).headers['cache-control']).toBe('no-cache');
    expect((await app.inject('/assets/x.js')).headers['cache-control']).toContain('immutable');
    expect((await app.inject('/not-a-page')).statusCode).toBe(404);
  });
});
