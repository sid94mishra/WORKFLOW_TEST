import { describe, expect, it, vi } from 'vitest';
import { postJson, validateOutboundUrl } from '../src/index.js';

const publicHost = async () => [{ address: '203.0.113.10', family: 4 as const }];

describe('notification egress', () => {
  it('validates literals, DNS answers, failures, and the metadata exception', async () => {
    expect(await validateOutboundUrl('http://127.0.0.1/hook', { allowPrivate: false })).toBe(
      'blocked address: 127.0.0.1 (loopback)',
    );
    expect(
      await validateOutboundUrl('https://evil.test/hook', {
        allowPrivate: false,
        resolveHost: async () => [{ address: '10.0.0.5', family: 4 }],
      }),
    ).toBe('blocked address: evil.test resolves to 10.0.0.5 (private)');
    expect(
      await validateOutboundUrl('https://evil.test/hook', {
        allowPrivate: false,
        resolveHost: async () => {
          const error = Object.assign(new Error('nope'), { code: 'ENOTFOUND' });
          throw error;
        },
      }),
    ).toBe('dns lookup failed: ENOTFOUND');
    expect(await validateOutboundUrl('http://169.254.169.254/', { allowPrivate: true })).toBe(
      'blocked address: 169.254.169.254 (metadata)',
    );
    expect(
      await validateOutboundUrl('https://public.test/hook', {
        allowPrivate: false,
        resolveHost: publicHost,
      }),
    ).toBeNull();
  });

  it('posts JSON with notification headers and treats 2xx, 3xx and 500 correctly', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    await expect(
      postJson(
        'https://public.test/hook',
        { hello: 'world' },
        {
          allowPrivate: false,
          resolveHost: publicHost,
          fetch: fetch as never,
          headers: { 'x-pulse-event': 'test', 'user-agent': 'Pulse/0.1 (+notifications)' },
        },
      ),
    ).resolves.toMatchObject({ ok: true, statusCode: 204, error: null });
    expect(String(fetch.mock.calls[0]?.[0])).toBe('https://public.test/hook');
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      redirect: 'manual',
      body: JSON.stringify({ hello: 'world' }),
      headers: expect.objectContaining({
        'content-type': 'application/json',
        'x-pulse-event': 'test',
      }),
    });
    fetch.mockResolvedValueOnce(
      new Response(null, { status: 302, headers: { location: 'https://other.test' } }),
    );
    await expect(
      postJson(
        'https://public.test/hook',
        {},
        { allowPrivate: false, resolveHost: publicHost, fetch: fetch as never },
      ),
    ).resolves.toMatchObject({
      ok: false,
      statusCode: 302,
      error: 'unexpected redirect (HTTP 302)',
    });
    fetch.mockResolvedValueOnce(new Response(null, { status: 500 }));
    await expect(
      postJson(
        'https://public.test/hook',
        {},
        { allowPrivate: false, resolveHost: publicHost, fetch: fetch as never },
      ),
    ).resolves.toMatchObject({ ok: false, statusCode: 500, error: 'HTTP 500' });
  });

  it('does not call fetch for a blocked address and times out a fetch that ignores abort', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    expect(
      await postJson(
        'https://evil.test/',
        {},
        {
          allowPrivate: false,
          resolveHost: async () => [{ address: '127.0.0.1', family: 4 }],
          fetch: fetch as never,
        },
      ),
    ).toMatchObject({
      ok: false,
      error: 'blocked address: evil.test resolves to 127.0.0.1 (loopback)',
    });
    expect(fetch).not.toHaveBeenCalled();
    vi.useFakeTimers();
    const hanging = vi.fn<typeof globalThis.fetch>(() => new Promise<Response>(() => {}));
    const promise = postJson(
      'https://public.test/',
      {},
      { allowPrivate: false, resolveHost: publicHost, fetch: hanging as never, timeoutMs: 100 },
    );
    await vi.advanceTimersByTimeAsync(100);
    await expect(promise).resolves.toMatchObject({ ok: false, error: 'timeout' });
    vi.useRealTimers();
  });
});
