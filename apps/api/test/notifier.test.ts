import { afterEach, describe, expect, it, vi } from 'vitest';
import { Notifier } from '../src/notifications/notifier.js';
import type { IncidentEvent } from '../src/results/repository.js';
import type { Channel, DeliveryAttempt, Monitor } from '@pulse/shared';

const monitor: Monitor = {
  id: '00000000-0000-4000-8000-000000000001',
  name: 'Example',
  url: 'https://example.test',
  method: 'GET',
  intervalSeconds: 60,
  timeoutMs: 1000,
  expectedStatus: 200,
  keyword: null,
  enabled: true,
  public: true,
  status: 'down',
  lastCheckedAt: '2026-10-11T00:00:00.000Z',
  createdAt: '2026-10-10T00:00:00.000Z',
};
const channel: Channel = {
  id: '00000000-0000-4000-8000-000000000002',
  name: 'Ops',
  kind: 'webhook',
  url: 'https://hooks.example.test/x',
  enabled: true,
  monitorIds: [monitor.id],
  createdAt: '2026-10-10T00:00:00.000Z',
};
const event: IncidentEvent = {
  type: 'incident.opened',
  monitor,
  incident: {
    id: '00000000-0000-4000-8000-000000000003',
    monitorId: monitor.id,
    monitorName: monitor.name,
    status: 'open',
    cause: 'failed',
    startedAt: '2026-10-11T00:00:00.000Z',
    resolvedAt: null,
    durationSeconds: null,
  },
};
const outcome = (ok: boolean, statusCode: number | null = ok ? 204 : 500) => ({
  ok,
  statusCode,
  latencyMs: 1,
  error: ok ? null : `HTTP ${statusCode}`,
});
afterEach(() => vi.useRealTimers());

describe('Notifier', () => {
  it('starts asynchronously, retries at 0/2s/12s, records failures, and stops after three', async () => {
    vi.useFakeTimers();
    const attempts: Omit<DeliveryAttempt, 'id'>[] = [];
    const warn = vi.fn();
    const error = vi.fn();
    const notifier = new Notifier({
      listChannels: () => [channel],
      getChannel: () => channel,
      send: vi.fn(async () => outcome(false)),
      recordAttempt: (a) => attempts.push(a),
      log: { warn, error, debug: vi.fn(), info: vi.fn() },
    });
    notifier.enqueue(event);
    expect(notifier.pending).toBe(1);
    expect(
      (notifier as unknown as { d: { send: ReturnType<typeof vi.fn> } }).d.send,
    ).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(0);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      attempt: 1,
      ok: false,
      statusCode: 500,
      error: 'HTTP 500',
    });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(attempts).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(attempts).toHaveLength(3);
    expect(warn).toHaveBeenCalledTimes(3);
    expect(error).toHaveBeenCalledTimes(1);
    await notifier.stop();
    expect(notifier.pending).toBe(0);
  });

  it('stops after a successful retry, skips blocked failures, and drops disabled channels', async () => {
    vi.useFakeTimers();
    const attempts: Omit<DeliveryAttempt, 'id'>[] = [];
    let current: Channel | undefined = channel;
    const send = vi.fn().mockResolvedValueOnce(outcome(false)).mockResolvedValueOnce(outcome(true));
    const notifier = new Notifier({
      listChannels: () => [channel],
      getChannel: () => current,
      send,
      recordAttempt: (a) => attempts.push(a),
    });
    notifier.enqueue(event);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(attempts.map((a) => a.ok)).toEqual([false, true]);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(send).toHaveBeenCalledTimes(2);
    current = { ...channel, enabled: false };
    notifier.enqueue(event);
    await vi.advanceTimersByTimeAsync(0);
    expect(attempts).toHaveLength(2);
    await notifier.stop();
  });

  it('does not let a never-resolving send prevent stop once the send resolves', async () => {
    vi.useFakeTimers();
    let resolve!: (value: ReturnType<typeof outcome>) => void;
    const notifier = new Notifier({
      listChannels: () => [channel],
      getChannel: () => channel,
      send: () => new Promise((r) => (resolve = r)),
      recordAttempt: vi.fn(),
    });
    notifier.enqueue(event);
    await vi.advanceTimersByTimeAsync(0);
    const stopped = notifier.stop();
    resolve(outcome(true));
    await expect(stopped).resolves.toBeUndefined();
  });
});
