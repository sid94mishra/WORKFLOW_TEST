import type { Channel, NotificationEvent } from './channel.js';
import type { Incident } from './incident.js';
import type { Monitor } from './monitor.js';
export type WebhookPayload = {
  event: NotificationEvent;
  sentAt: string;
  channel: Pick<Channel, 'id' | 'name'>;
  monitor: Pick<Monitor, 'id' | 'name' | 'url' | 'status'> | null;
  incident: Incident | null;
};
export type SlackPayload = { text: string };
type Input = {
  event: NotificationEvent;
  sentAt: string;
  channel: Pick<Channel, 'id' | 'name'>;
  monitor: Pick<Monitor, 'id' | 'name' | 'url' | 'status'> | null;
  incident: Incident | null;
};
const escapeSlack = (value: string) =>
  value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) {
    const m = Math.floor(s / 60);
    const r = s % 60;
    return r ? `${m}m ${r}s` : `${m}m`;
  }
  if (s < 86400) {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return m ? `${h}h ${m}m` : `${h}h`;
  }
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  return h ? `${d}d ${h}h` : `${d}d`;
}
export function buildWebhookPayload(input: Input): WebhookPayload {
  return {
    event: input.event,
    sentAt: input.sentAt,
    channel: { id: input.channel.id, name: input.channel.name },
    monitor: input.monitor
      ? {
          id: input.monitor.id,
          name: input.monitor.name,
          url: input.monitor.url,
          status: input.monitor.status,
        }
      : null,
    incident: input.incident,
  };
}
export function buildSlackPayload(input: Input): SlackPayload {
  if (input.event === 'test')
    return {
      text: `:wave: Test notification from Pulse for channel *${escapeSlack(input.channel.name)}*.`,
    };
  const monitor = input.monitor!;
  const incident = input.incident!;
  if (input.event === 'incident.opened')
    return {
      text: `:red_circle: *${escapeSlack(monitor.name)}* is DOWN: ${escapeSlack(incident.cause ?? 'unknown error')}\n${escapeSlack(monitor.url)} · since ${escapeSlack(incident.startedAt)}`,
    };
  return {
    text: `:large_green_circle: *${escapeSlack(monitor.name)}* is UP again after ${formatDuration(incident.durationSeconds ?? 0)}\n${escapeSlack(monitor.url)} · resolved ${escapeSlack(incident.resolvedAt ?? '')}`,
  };
}
