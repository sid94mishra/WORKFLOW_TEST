import { describe, expect, it, vi } from 'vitest';
import type { Monitor } from './types';
import { ApiClientError, createApiClient } from './client';

const monitor: Monitor = {
  id: '5f0c7a5e-2b0e-4d0a-9a8e-0c6f2f7a1b11',
  name: 'Example',
  url: 'https://example.com',
  method: 'GET',
  intervalSeconds: 60,
  timeoutMs: 10000,
  expectedStatus: 200,
  keyword: null,
  enabled: true,
  createdAt: '2026-10-11T09:30:00.000Z',
  status: 'pending',
  lastCheckedAt: null,
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('api client', () => {
  it('unwraps { data } for list and create, sending JSON bodies', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockResolvedValueOnce(json({ data: [monitor] }));
    fetchMock.mockResolvedValueOnce(json({ data: monitor }, 201));
    const client = createApiClient({ baseUrl: 'http://x', fetch: fetchMock });

    expect(await client.listMonitors()).toEqual([monitor]);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://x/api/v1/monitors');

    expect(await client.createMonitor({ name: 'Example', url: 'https://example.com' })).toEqual(
      monitor,
    );
    const init = fetchMock.mock.calls[1]?.[1];
    expect(init?.method).toBe('POST');
    expect(init?.headers).toMatchObject({ 'content-type': 'application/json' });
    expect(JSON.parse(init?.body as string)).toEqual({
      name: 'Example',
      url: 'https://example.com',
    });
  });

  it('returns void for 204 delete', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    const client = createApiClient({ fetch: fetchMock });
    await expect(client.deleteMonitor('abc')).resolves.toBeUndefined();
  });

  it('maps ApiError bodies to ApiClientError with issues', async () => {
    const issues = [{ path: ['url'], message: 'Invalid URL', code: 'invalid_format' }];
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        json(
          { error: { code: 'VALIDATION_ERROR', message: 'Request validation failed', issues } },
          400,
        ),
      );
    const client = createApiClient({ fetch: fetchMock });
    const err = await client.createMonitor({ name: 'a', url: 'x' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiClientError);
    expect(err).toMatchObject({ status: 400, code: 'VALIDATION_ERROR', issues });
  });

  it('falls back to INTERNAL_ERROR for non-ApiError bodies', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('oops', { status: 502 }));
    const client = createApiClient({ fetch: fetchMock });
    await expect(client.listMonitors()).rejects.toMatchObject({
      status: 502,
      code: 'INTERNAL_ERROR',
      message: 'Request failed (502)',
    });
  });

  it('maps fetch rejection to NETWORK_ERROR', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('failed'));
    const client = createApiClient({ fetch: fetchMock });
    await expect(client.health()).rejects.toMatchObject({
      status: 0,
      code: 'NETWORK_ERROR',
      message: 'Network error',
    });
  });

  it('re-throws AbortError unchanged', async () => {
    const abort = new DOMException('aborted', 'AbortError');
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(abort);
    const client = createApiClient({ fetch: fetchMock });
    await expect(client.listMonitors()).rejects.toBe(abort);
  });

  it('passes signal to getMonitor and builds results/uptime queries', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockResolvedValueOnce(json({ data: monitor }));
    fetchMock.mockResolvedValueOnce(json({ data: [] }));
    fetchMock.mockResolvedValueOnce(json({ data: [] }));
    fetchMock.mockResolvedValueOnce(json({ data: { totalChecks: 0 } }));
    const client = createApiClient({ baseUrl: 'http://x', fetch: fetchMock });
    const controller = new AbortController();

    await client.getMonitor(monitor.id, controller.signal);
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBe(controller.signal);

    expect(await client.listResults(monitor.id, { limit: 50 })).toEqual([]);
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      `http://x/api/v1/monitors/${monitor.id}/results?limit=50`,
    );
    await client.listResults(monitor.id);
    expect(fetchMock.mock.calls[2]?.[0]).toBe(`http://x/api/v1/monitors/${monitor.id}/results`);

    expect(await client.getUptime(monitor.id, '7d', controller.signal)).toEqual({ totalChecks: 0 });
    expect(fetchMock.mock.calls[3]?.[0]).toBe(
      `http://x/api/v1/monitors/${monitor.id}/uptime?window=7d`,
    );
  });
});
