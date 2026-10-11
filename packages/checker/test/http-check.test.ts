import { createServer } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runHttpCheck, type HttpCheckTarget } from '../src/index.js';

// Slow routes hang far longer than any timeout used below, so the timeout tests cannot race
// the server on a loaded CI machine. afterAll force-closes the hanging sockets.
const HANG_MS = 5_000;
const TIMEOUT_MS = 200;

let server: ReturnType<typeof createServer>;
let base = '';
let seenMethod = '';
let seenUserAgent = '';

beforeAll(async () => {
  server = createServer((request, response) => {
    seenMethod = request.method ?? '';
    seenUserAgent = request.headers['user-agent'] ?? '';
    switch (request.url) {
      case '/redirect':
        response.writeHead(302, { location: '/ok' });
        response.end();
        return;
      case '/status':
        response.statusCode = 500;
        response.end('failure');
        return;
      case '/slow':
        setTimeout(() => response.end('late'), HANG_MS).unref();
        return;
      case '/slow-body':
        response.writeHead(200);
        response.write('part');
        setTimeout(() => response.end('later'), HANG_MS).unref();
        return;
      case '/broken-body':
        response.writeHead(200, { 'content-length': '100' });
        response.write('partial');
        setTimeout(() => response.destroy(), 20).unref();
        return;
      default:
        response.end('known body');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const target = (path: string, extra: Partial<HttpCheckTarget> = {}): HttpCheckTarget => ({
  url: base + path,
  method: 'GET',
  timeoutMs: 2_000,
  expectedStatus: 200,
  keyword: null,
  ...extra,
});

describe('runHttpCheck', () => {
  it('reports ok for the expected status', async () => {
    const result = await runHttpCheck(target('/ok'));
    expect(result).toMatchObject({ ok: true, statusCode: 200, error: null, keywordMatched: null });
    expect(new Date(result.checkedAt).toISOString()).toBe(result.checkedAt);
  });

  it('reports ok with keywordMatched when the keyword is present', async () => {
    const result = await runHttpCheck(target('/ok', { keyword: 'known' }));
    expect(result).toMatchObject({ ok: true, error: null, keywordMatched: true });
  });

  it('reports a status mismatch', async () => {
    const result = await runHttpCheck(target('/status'));
    expect(result).toMatchObject({
      ok: false,
      statusCode: 500,
      error: 'expected status 200, got 500',
    });
  });

  it('still evaluates the keyword on a status mismatch', async () => {
    const result = await runHttpCheck(target('/status', { keyword: 'failure' }));
    expect(result).toMatchObject({ ok: false, keywordMatched: true });
  });

  it('reports a missing keyword', async () => {
    const result = await runHttpCheck(target('/ok', { keyword: 'absent' }));
    expect(result).toMatchObject({
      ok: false,
      statusCode: 200,
      keywordMatched: false,
      error: 'keyword not found',
    });
  });

  it('follows redirects and reports the final status', async () => {
    const result = await runHttpCheck(target('/redirect'));
    expect(result).toMatchObject({ ok: true, statusCode: 200 });
  });

  it('times out waiting for headers within timeoutMs + 500 ms', async () => {
    const start = performance.now();
    const result = await runHttpCheck(target('/slow', { timeoutMs: TIMEOUT_MS }));
    expect(performance.now() - start).toBeLessThan(TIMEOUT_MS + 500);
    expect(result).toMatchObject({ ok: false, statusCode: null, error: 'timeout' });
  });

  it('times out while reading the body and keeps the status', async () => {
    const result = await runHttpCheck(
      target('/slow-body', { timeoutMs: TIMEOUT_MS, keyword: 'later' }),
    );
    expect(result).toMatchObject({
      ok: false,
      statusCode: 200,
      error: 'timeout',
      keywordMatched: null,
    });
  });

  it('reports a body read failure with the status', async () => {
    const result = await runHttpCheck(target('/broken-body', { keyword: 'partial' }));
    expect(result.ok).toBe(false);
    expect(result.statusCode).toBe(200);
    expect(result.keywordMatched).toBeNull();
    expect(result.error).toBeTruthy();
    expect(result.error).not.toBe('timeout');
  });

  it('reports network errors without rejecting', async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const address = closed.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    await new Promise<void>((resolve) => closed.close(() => resolve()));

    const result = await runHttpCheck(target('/', { url: `http://127.0.0.1:${port}/` }));
    expect(result).toMatchObject({ ok: false, statusCode: null, keywordMatched: null });
    expect(result.error).toMatch(/ECONNREFUSED/);
  });

  it('reports an invalid URL without rejecting', async () => {
    const result = await runHttpCheck(target('/', { url: 'not a url' }));
    expect(result).toMatchObject({ ok: false, statusCode: null });
    expect(result.error).toBeTruthy();
  });

  it('reports non-negative integer latency in every outcome', async () => {
    const results = await Promise.all([
      runHttpCheck(target('/ok')),
      runHttpCheck(target('/status')),
      runHttpCheck(target('/slow', { timeoutMs: TIMEOUT_MS })),
      runHttpCheck(target('/', { url: 'not a url' })),
    ]);
    for (const { latencyMs } of results) {
      expect(Number.isInteger(latencyMs)).toBe(true);
      expect(latencyMs).toBeGreaterThanOrEqual(0);
    }
  });

  it('sends the method and the default user agent', async () => {
    await runHttpCheck(target('/ok', { method: 'HEAD' }));
    expect(seenMethod).toBe('HEAD');
    expect(seenUserAgent).toBe('Pulse/0.1 (+uptime-check)');
  });

  it('uses an injected fetch', async () => {
    const fetch = async () => new Response(null, { status: 204 });
    const result = await runHttpCheck(target('/ok', { expectedStatus: 204 }), { fetch });
    expect(result).toMatchObject({ ok: true, statusCode: 204 });
  });
});
