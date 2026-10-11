import type { CheckOutcome, Monitor } from '@pulse/shared';
import type { FastifyBaseLogger } from 'fastify';

export type ScheduledMonitor = Monitor & { configVersion?: number };

export interface SchedulerDeps {
  listEnabled(): ScheduledMonitor[];
  runCheck(monitor: Monitor): Promise<CheckOutcome>;
  record(monitorId: string, outcome: CheckOutcome, configVersion?: number): void | Promise<void>;
  maxConcurrency: number;
  random?: () => number;
  log?: Pick<FastifyBaseLogger, 'debug' | 'info' | 'warn' | 'error'>;
}

type Task = { monitor: ScheduledMonitor };

export class Scheduler {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly busy = new Set<string>();
  private readonly active = new Set<Promise<void>>();
  private readonly queue: Task[] = [];
  private stopped = false;
  private started = false;
  private stopping?: Promise<void>;
  private running = 0;

  constructor(private readonly deps: SchedulerDeps) {}

  get inFlight(): number {
    return this.running;
  }
  get queued(): number {
    return this.queue.length;
  }

  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    for (const monitor of this.deps.listEnabled()) this.arm(monitor, this.firstDelay(monitor));
  }

  upsert(monitor: ScheduledMonitor): void {
    if (this.stopped) return;
    this.clearTimer(monitor.id);
    // A queued run holds the old snapshot (e.g. the previous URL); drop it so it is never checked.
    this.dropQueued(monitor.id);
    if (!monitor.enabled) return;
    this.arm(monitor, this.firstDelay(monitor));
  }

  remove(monitorId: string): void {
    this.clearTimer(monitorId);
    this.dropQueued(monitorId);
  }

  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopped = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    for (const task of this.queue.splice(0)) this.busy.delete(task.monitor.id);
    this.stopping = Promise.all([...this.active]).then(() => undefined);
    return this.stopping;
  }

  private interval(monitor: Monitor): number {
    return Math.max(monitor.intervalSeconds, 30) * 1_000;
  }
  private firstDelay(monitor: Monitor): number {
    return this.interval(monitor) * 0.1 * (this.deps.random ?? Math.random)();
  }
  private nextDelay(monitor: Monitor): number {
    return this.interval(monitor) * (0.9 + 0.2 * (this.deps.random ?? Math.random)());
  }
  private clearTimer(id: string): void {
    const timer = this.timers.get(id);
    if (timer) clearTimeout(timer);
    this.timers.delete(id);
  }
  private arm(monitor: ScheduledMonitor, delay: number): void {
    this.clearTimer(monitor.id);
    this.timers.set(
      monitor.id,
      setTimeout(() => this.onTimer(monitor), delay),
    );
  }
  private onTimer(monitor: ScheduledMonitor): void {
    this.timers.delete(monitor.id);
    if (this.stopped) return;
    this.arm(monitor, this.nextDelay(monitor));
    if (this.busy.has(monitor.id)) {
      this.deps.log?.debug({ monitorId: monitor.id }, 'Skipping overlapping monitor check');
      return;
    }
    this.busy.add(monitor.id);
    this.queue.push({ monitor });
    this.drain();
  }
  private dropQueued(monitorId: string): void {
    const index = this.queue.findIndex((task) => task.monitor.id === monitorId);
    if (index >= 0) {
      this.queue.splice(index, 1);
      this.busy.delete(monitorId);
    }
  }
  private drain(): void {
    while (!this.stopped && this.running < this.deps.maxConcurrency && this.queue.length > 0) {
      const task = this.queue.shift()!;
      this.running += 1;
      const running = this.execute(task).finally(() => {
        this.running -= 1;
        this.busy.delete(task.monitor.id);
        this.active.delete(running);
        this.drain();
      });
      this.active.add(running);
    }
  }
  private async execute({ monitor }: Task): Promise<void> {
    try {
      const outcome = await this.deps.runCheck(monitor);
      try {
        await this.deps.record(monitor.id, outcome, monitor.configVersion);
      } catch (error) {
        this.deps.log?.error(error, 'Failed to record monitor check');
      }
    } catch (error) {
      this.deps.log?.error(error, 'Monitor check failed');
    }
  }
}
