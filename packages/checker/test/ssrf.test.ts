import { createServer } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import {
  createPinnedLookup,
  runHttpCheck,
  type HttpCheckTarget,
  type ResolvedAddress,
} from '../src/index.js';

const target = (url: string): HttpCheckTarget => ({
  url,
  method: 'GET',
  timeoutMs: 1_000,
  expectedStatus: 200,
  keyword: null,
});
const fetch = (handler: (url: string) => Response) =>
  (async (input: string | URL) => handler(String(input))) as unknown as NonNullable<
    Parameters<typeof runHttpCheck>[1]
  >['fetch'];

describe('SSRF protections', () => {
  it('blocks an IP literal before fetch', async () => {
    const request = vi.fn();
    const result = await runHttpCheck(target('http://169.254.169.254/'), {
      fetch: request as never,
    });
    expect(result).toMatchObject({
      ok: false,
      statusCode: null,
      error: 'blocked address: 169.254.169.254 (metadata)',
    });
    expect(request).not.toHaveBeenCalled();
  });
  it('blocks every resolved address before fetch', async () => {
    const request = vi.fn();
    const result = await runHttpCheck(target('http://evil.test/'), {
      fetch: request as never,
      resolveHost: async () => [
        { address: '203.0.113.5', family: 4 },
        { address: '10.0.0.1', family: 4 },
      ],
    });
    expect(result.error).toBe('blocked address: evil.test resolves to 10.0.0.1 (private)');
    expect(request).not.toHaveBeenCalled();
  });

  it('does not send a request to a local server when a hostname resolves to loopback', async () => {
    let requests = 0;
    const server = createServer((_request, response) => {
      requests += 1;
      response.end('should not be reached');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const result = await runHttpCheck(target(`http://evil.test:${port}/`), {
        resolveHost: async (hostname) => {
          expect(hostname).toBe('evil.test');
          return [{ address: '127.0.0.1', family: 4 }];
        },
      });
      expect(result.error).toBe('blocked address: evil.test resolves to 127.0.0.1 (loopback)');
      expect(requests).toBe(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  it('validates redirect targets and follows only three redirects', async () => {
    const publicFetch = vi.fn(
      async () => new Response(null, { status: 302, headers: { location: 'http://10.0.0.1/' } }),
    );
    const blocked = await runHttpCheck(target('http://public.test/'), {
      resolveHost: async () => [{ address: '203.0.113.5', family: 4 }],
      fetch: publicFetch as never,
    });
    expect(blocked.error).toBe('blocked redirect to http://10.0.0.1/: 10.0.0.1 (private)');
    expect(blocked.statusCode).toBeNull();
    expect(publicFetch).toHaveBeenCalledTimes(1);
    const four = await runHttpCheck(target('http://public.test/'), {
      resolveHost: async () => [{ address: '203.0.113.5', family: 4 }],
      fetch: fetch(() => new Response(null, { status: 302, headers: { location: '/next' } })),
    });
    expect(four.error).toBe('too many redirects (max 3)');
    expect(four.statusCode).toBeNull();
  });

  it('follows exactly three redirects to a final successful response', async () => {
    const responses = [
      new Response(null, { status: 302, headers: { location: '/one' } }),
      new Response(null, { status: 302, headers: { location: '/two' } }),
      new Response(null, { status: 302, headers: { location: '/three' } }),
      new Response(null, { status: 200 }),
    ];
    const request = vi.fn(async () => responses.shift()!);
    const result = await runHttpCheck(target('http://public.test/'), {
      resolveHost: async () => [{ address: '203.0.113.5', family: 4 }],
      fetch: request as never,
    });
    expect(result).toMatchObject({ ok: true, statusCode: 200 });
    expect(request).toHaveBeenCalledTimes(4);
  });
  it('times out DNS and pins lookup answers', async () => {
    const started = performance.now();
    const result = await runHttpCheck(target('http://slow.test/'), {
      resolveHost: () => new Promise<ResolvedAddress[]>(() => {}),
    });
    expect(result.error).toBe('timeout');
    expect(performance.now() - started).toBeLessThan(1_500);
    const pinned = createPinnedLookup(
      new Map([['ok.test', [{ address: '203.0.113.5', family: 4 as const }]]]),
    );
    await new Promise<void>((resolve, reject) =>
      pinned('ok.test', { all: true }, (error, addresses) => {
        if (error) reject(error);
        else {
          expect(addresses).toEqual([{ address: '203.0.113.5', family: 4 }]);
          resolve();
        }
      }),
    );
    await new Promise<void>((resolve, reject) =>
      pinned('ok.test', 0, (error, address, family) => {
        if (error) reject(error);
        else {
          expect(address).toBe('203.0.113.5');
          expect(family).toBe(4);
          resolve();
        }
      }),
    );
    await new Promise<void>((resolve) =>
      pinned('missing.test', { all: true }, (error) => {
        expect(error?.message).toBe('unrecognized hostname: missing.test');
        resolve();
      }),
    );
  });

  it('times out a redirect hop whose DNS starts after the deadline has passed', async () => {
    const started = performance.now();
    const result = await runHttpCheck(
      { ...target('http://first.test/'), timeoutMs: 100 },
      {
        resolveHost: (host) =>
          host === 'first.test'
            ? Promise.resolve([{ address: '203.0.113.5', family: 4 }])
            : new Promise<ResolvedAddress[]>(() => {}),
        // Ignores the abort signal and answers only after the deadline.
        fetch: (async () => {
          await new Promise((resolve) => setTimeout(resolve, 150));
          return new Response(null, { status: 302, headers: { location: 'http://second.test/' } });
        }) as unknown as NonNullable<Parameters<typeof runHttpCheck>[1]>['fetch'],
      },
    );
    expect(result.error).toBe('timeout');
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it('resolves each distinct hostname once and reuses validated answers on redirects', async () => {
    const resolved = vi.fn(async (hostname: string) => [
      { address: hostname === 'other.test' ? '203.0.113.6' : '203.0.113.5', family: 4 as const },
    ]);
    const responses = [
      new Response(null, { status: 302, headers: { location: '/same' } }),
      new Response(null, { status: 302, headers: { location: 'http://other.test/' } }),
      new Response(null, { status: 302, headers: { location: 'http://public.test/final' } }),
      new Response(null, { status: 200 }),
    ];
    const result = await runHttpCheck(target('http://public.test/'), {
      resolveHost: resolved,
      fetch: vi.fn(async () => responses.shift()!) as never,
    });
    expect(result.ok).toBe(true);
    expect(resolved).toHaveBeenCalledTimes(2);
    expect(resolved.mock.calls.map(([hostname]) => hostname)).toEqual([
      'public.test',
      'other.test',
    ]);
  });

  it('allows loopback with allowPrivate but always blocks metadata', async () => {
    const local = await new Promise<{ server: ReturnType<typeof createServer>; port: number }>(
      (resolve) => {
        const server = createServer((_request, response) => response.end('ok'));
        server.listen(0, '127.0.0.1', () =>
          resolve({ server, port: (server.address() as { port: number }).port }),
        );
      },
    );
    try {
      const localResult = await runHttpCheck(target(`http://127.0.0.1:${local.port}/`), {
        allowPrivate: true,
      });
      expect(localResult.ok).toBe(true);
      const metadata = await runHttpCheck(target('http://169.254.169.254/'), {
        allowPrivate: true,
        fetch: vi.fn() as never,
      });
      expect(metadata.error).toBe('blocked address: 169.254.169.254 (metadata)');
    } finally {
      await new Promise<void>((resolve) => local.server.close(() => resolve()));
    }
  });
});
