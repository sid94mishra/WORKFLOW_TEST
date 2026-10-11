import { afterEach, describe, expect, it, vi } from 'vitest';
import { Scheduler } from '../src/scheduler/scheduler.js';
import type { Monitor } from '@pulse/shared';

const monitor = (id = '00000000-0000-4000-8000-000000000000'): Monitor => ({
  id,
  name: id,
  url: 'https://example.test',
  method: 'GET',
  intervalSeconds: 60,
  timeoutMs: 1000,
  expectedStatus: 200,
  keyword: null,
  enabled: true,
  status: 'pending',
  lastCheckedAt: null,
  createdAt: '2026-10-11T00:00:00.000Z',
});
const outcome = {
  checkedAt: '2026-10-11T00:00:00.000Z',
  ok: true,
  statusCode: 200,
  latencyMs: 1,
  error: null,
  keywordMatched: null,
};
afterEach(() => vi.useRealTimers());

describe('Scheduler', () => {
  it('uses startup spread and jittered fixed-rate timers', async () => {
    vi.useFakeTimers();
    const runCheck = vi.fn(async () => outcome);
    const scheduler = new Scheduler({
      listEnabled: () => [monitor()],
      runCheck,
      record: vi.fn(),
      maxConcurrency: 1,
      random: () => 0.5,
    });
    scheduler.start();
    await vi.advanceTimersByTimeAsync(2_999);
    expect(runCheck).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(runCheck).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runCheck).toHaveBeenCalledTimes(2);
    await scheduler.stop();
  });
  it('caps concurrency, queues FIFO work, and drops queued work on stop', async () => {
    vi.useFakeTimers();
    const resolvers: (() => void)[] = [];
    const runCheck = vi.fn(
      () => new Promise<typeof outcome>((resolve) => resolvers.push(() => resolve(outcome))),
    );
    const scheduler = new Scheduler({
      listEnabled: () =>
        Array.from({ length: 4 }, (_, index) =>
          monitor(`00000000-0000-4000-8000-00000000000${index}`),
        ),
      runCheck,
      record: vi.fn(),
      maxConcurrency: 2,
      random: () => 0,
    });
    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(runCheck).toHaveBeenCalledTimes(2);
    expect(scheduler.queued).toBe(2);
    resolvers.shift()!();
    await vi.advanceTimersByTimeAsync(0);
    expect(runCheck).toHaveBeenCalledTimes(3);
    const stopped = scheduler.stop();
    expect(scheduler.queued).toBe(0);
    resolvers.forEach((resolve) => resolve());
    await stopped;
  });

  it('uses the lower and upper jitter bounds for subsequent runs', async () => {
    vi.useFakeTimers();
    const runCheck = vi.fn(async () => outcome);
    const low = new Scheduler({
      listEnabled: () => [monitor()],
      runCheck,
      record: vi.fn(),
      maxConcurrency: 1,
      random: () => 0,
    });
    low.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(runCheck).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(53_999);
    expect(runCheck).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(runCheck).toHaveBeenCalledTimes(2);
    await low.stop();

    runCheck.mockClear();
    const high = new Scheduler({
      listEnabled: () => [monitor()],
      runCheck,
      record: vi.fn(),
      maxConcurrency: 1,
      random: () => 0.999,
    });
    high.start();
    await vi.advanceTimersByTimeAsync(5_994);
    expect(runCheck).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(65_999);
    expect(runCheck).toHaveBeenCalledTimes(2);
    await high.stop();
  });

  it('runs only maxConcurrency due monitors and drains FIFO when one finishes', async () => {
    vi.useFakeTimers();
    const resolvers: (() => void)[] = [];
    const runCheck = vi.fn(
      () => new Promise<typeof outcome>((resolve) => resolvers.push(() => resolve(outcome))),
    );
    const monitors = Array.from({ length: 10 }, (_, index) =>
      monitor(`00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`),
    );
    const scheduler = new Scheduler({
      listEnabled: () => monitors,
      runCheck,
      record: vi.fn(),
      maxConcurrency: 3,
      random: () => 0,
    });
    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(runCheck).toHaveBeenCalledTimes(3);
    expect(scheduler.inFlight).toBe(3);
    expect(scheduler.queued).toBe(7);
    resolvers.shift()!();
    await vi.advanceTimersByTimeAsync(0);
    expect(runCheck).toHaveBeenCalledTimes(4);
    expect(scheduler.queued).toBe(6);
    resolvers.forEach((resolve) => resolve());
    await scheduler.stop();
  });

  it('skips an overlapping timer for the same monitor', async () => {
    vi.useFakeTimers();
    let resolveCheck!: () => void;
    const runCheck = vi.fn(
      () => new Promise<typeof outcome>((resolve) => (resolveCheck = () => resolve(outcome))),
    );
    const scheduler = new Scheduler({
      listEnabled: () => [monitor()],
      runCheck,
      record: vi.fn(),
      maxConcurrency: 1,
      random: () => 0,
    });
    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(54_001);
    expect(runCheck).toHaveBeenCalledTimes(1);
    resolveCheck();
    await vi.advanceTimersByTimeAsync(0);
    await scheduler.stop();
  });

  it('removes disabled monitors and reschedules an upsert with a new interval', async () => {
    vi.useFakeTimers();
    const runCheck = vi.fn(async () => outcome);
    const scheduler = new Scheduler({
      listEnabled: () => [],
      runCheck,
      record: vi.fn(),
      maxConcurrency: 1,
      random: () => 0,
    });
    const first = monitor();
    scheduler.upsert(first);
    scheduler.upsert({ ...first, enabled: false });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runCheck).not.toHaveBeenCalled();

    scheduler.upsert(first);
    scheduler.remove(first.id);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runCheck).not.toHaveBeenCalled();

    scheduler.upsert({ ...first, intervalSeconds: 30 });
    await vi.advanceTimersByTimeAsync(0);
    expect(runCheck).toHaveBeenCalledTimes(1);
    await scheduler.stop();
  });

  it('drops a queued run holding a stale snapshot when the monitor is upserted', async () => {
    vi.useFakeTimers();
    let resolveCheck!: () => void;
    const runCheck = vi.fn(
      (m: Monitor) =>
        new Promise<typeof outcome>((resolve) => {
          if (m.id === busy.id) resolveCheck = () => resolve(outcome);
          else resolve(outcome);
        }),
    );
    const busy = monitor('00000000-0000-4000-8000-000000000001');
    const queuedMonitor = monitor('00000000-0000-4000-8000-000000000002');
    const scheduler = new Scheduler({
      listEnabled: () => [busy, queuedMonitor],
      runCheck,
      record: vi.fn(),
      maxConcurrency: 1,
      random: () => 0,
    });
    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(scheduler.queued).toBe(1);

    scheduler.upsert({ ...queuedMonitor, url: 'https://new.example.test' });
    expect(scheduler.queued).toBe(0);
    resolveCheck();
    await vi.advanceTimersByTimeAsync(0);
    expect(runCheck.mock.calls.map(([m]) => m.url)).toEqual([
      'https://example.test',
      'https://new.example.test',
    ]);
    await scheduler.stop();
  });

  it('waits for in-flight checks and records, drops queued work, and is idempotent on stop', async () => {
    vi.useFakeTimers();
    let resolveCheck!: () => void;
    let resolveRecord!: () => void;
    let recordStarted = false;
    let stopped = false;
    const monitors = [monitor(), monitor('00000000-0000-4000-8000-000000000001')];
    const scheduler = new Scheduler({
      listEnabled: () => monitors,
      runCheck: vi.fn(
        () => new Promise<typeof outcome>((resolve) => (resolveCheck = () => resolve(outcome))),
      ),
      record: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            recordStarted = true;
            resolveRecord = resolve;
          }),
      ),
      maxConcurrency: 1,
      random: () => 0,
    });
    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(scheduler.queued).toBe(1);
    const stopping = scheduler.stop();
    expect(scheduler.stop()).toBe(stopping);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(stopped).toBe(false);
    resolveCheck();
    await vi.advanceTimersByTimeAsync(0);
    expect(recordStarted).toBe(true);
    let resolved = false;
    void stopping.then(() => {
      resolved = true;
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(resolved).toBe(false);
    resolveRecord();
    await stopping;
    expect(stopped).toBe(true);
    expect(scheduler.inFlight).toBe(0);
    expect(scheduler.queued).toBe(0);
  });

  it('logs rejected checks and record failures while continuing later runs', async () => {
    vi.useFakeTimers();
    const error = vi.fn();
    const runCheck = vi
      .fn<() => Promise<typeof outcome>>()
      .mockRejectedValueOnce(new Error('check failed'))
      .mockResolvedValue(outcome);
    const record = vi.fn().mockImplementationOnce(() => {
      throw new Error('record failed');
    });
    const scheduler = new Scheduler({
      listEnabled: () => [monitor()],
      runCheck,
      record,
      maxConcurrency: 1,
      random: () => 0,
      log: { error } as never,
    });
    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(54_001);
    expect(runCheck).toHaveBeenCalledTimes(2);
    expect(record).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledTimes(2);
    await scheduler.stop();
  });
});
