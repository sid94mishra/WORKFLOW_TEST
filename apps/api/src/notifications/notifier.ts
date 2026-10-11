import { randomUUID } from 'node:crypto';
import {
  buildSlackPayload,
  buildWebhookPayload,
  DELIVERY_RETRY_DELAYS_MS,
  MAX_DELIVERY_ATTEMPTS,
  type Channel,
  type DeliveryAttempt,
} from '@pulse/shared';
import type { PostOutcome } from '@pulse/checker';
import type { IncidentEvent } from '../results/repository.js';
export interface NotifierDeps {
  listChannels(monitorId: string): Channel[];
  getChannel(id: string): Channel | undefined;
  send(channel: Channel, body: unknown): Promise<PostOutcome>;
  recordAttempt(value: Omit<DeliveryAttempt, 'id'>): void;
  maxConcurrency?: number;
  retryDelaysMs?: readonly number[];
  now?: () => Date;
  log?: any;
}
type Job = { event: IncidentEvent; channelId: string; body: unknown; attempt: number };
export class Notifier {
  private queue: Job[] = [];
  private running = 0;
  private active = new Set<Promise<void>>();
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private stopped = false;
  constructor(private readonly d: NotifierDeps) {}
  get pending() {
    return this.queue.length + this.running + this.timers.size;
  }
  enqueue(event: IncidentEvent) {
    if (this.stopped) return;
    for (const c of this.d.listChannels(event.monitor.id)) {
      const input = {
        event: event.type,
        sentAt: (this.d.now ?? (() => new Date()))().toISOString(),
        channel: c,
        monitor: event.monitor,
        incident: event.incident,
      };
      this.queue.push({
        event,
        channelId: c.id,
        body: c.kind === 'slack' ? buildSlackPayload(input) : buildWebhookPayload(input),
        attempt: 1,
      });
    }
    queueMicrotask(() => this.drain());
  }
  private drain() {
    while (!this.stopped && this.running < (this.d.maxConcurrency ?? 4) && this.queue.length) {
      const job = this.queue.shift()!;
      this.running++;
      let active: Promise<void>;
      active = this.run(job).finally(() => {
        this.running--;
        this.active.delete(active);
        this.drain();
      });
      this.active.add(active);
    }
  }
  private async run(job: Job) {
    const channel = this.d.getChannel(job.channelId);
    if (!channel || !channel.enabled) return;
    let outcome: PostOutcome;
    try {
      outcome = await this.d.send(channel, job.body);
    } catch (error) {
      outcome = {
        ok: false,
        statusCode: null,
        latencyMs: 0,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    const value: Omit<DeliveryAttempt, 'id'> = {
      channelId: channel.id,
      incidentId: job.event.incident.id,
      event: job.event.type,
      attempt: job.attempt,
      attemptedAt: (this.d.now ?? (() => new Date()))().toISOString(),
      ok: outcome.ok,
      statusCode: outcome.statusCode,
      latencyMs: outcome.latencyMs,
      error: outcome.error,
    };
    try {
      this.d.recordAttempt(value);
    } catch (error) {
      this.d.log?.warn?.(error);
    }
    if (outcome.ok) {
      if (job.attempt > 1)
        this.d.log?.info?.(
          { channelId: channel.id, event: job.event.type, attempt: job.attempt },
          'notification delivered',
        );
      return;
    }
    this.d.log?.warn?.(
      { channelId: channel.id, event: job.event.type, attempt: job.attempt, error: outcome.error },
      'notification failed',
    );
    if (job.attempt >= MAX_DELIVERY_ATTEMPTS || outcome.error?.startsWith('blocked address')) {
      this.d.log?.error?.(
        { channelId: channel.id, event: job.event.type, error: outcome.error },
        'notification failed permanently',
      );
      return;
    }
    if (this.stopped) return;
    const timer = setTimeout(
      () => {
        this.timers.delete(timer);
        if (!this.stopped) {
          this.queue.push({ ...job, attempt: job.attempt + 1 });
          this.drain();
        }
      },
      this.d.retryDelaysMs?.[job.attempt - 1] ?? DELIVERY_RETRY_DELAYS_MS[job.attempt - 1]!,
    );
    this.timers.add(timer);
  }
  async sendTest(channel: Channel): Promise<DeliveryAttempt> {
    let outcome: PostOutcome;
    const input = {
      event: 'test' as const,
      sentAt: (this.d.now ?? (() => new Date()))().toISOString(),
      channel,
      monitor: null,
      incident: null,
    };
    try {
      outcome = await this.d.send(
        channel,
        channel.kind === 'slack' ? buildSlackPayload(input) : buildWebhookPayload(input),
      );
    } catch (error) {
      outcome = {
        ok: false,
        statusCode: null,
        latencyMs: 0,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    const value = {
      id: randomUUID(),
      channelId: channel.id,
      incidentId: null,
      event: 'test' as const,
      attempt: 1,
      attemptedAt: (this.d.now ?? (() => new Date()))().toISOString(),
      ok: outcome.ok,
      statusCode: outcome.statusCode,
      latencyMs: outcome.latencyMs,
      error: outcome.error,
    };
    this.d.recordAttempt(value);
    return value;
  }
  async stop() {
    if (this.stopped) return;
    this.stopped = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    const dropped = this.queue.length;
    this.queue = [];
    if (dropped) this.d.log?.warn?.({ dropped }, 'dropped queued notifications');
    await Promise.all([...this.active]);
  }
}
