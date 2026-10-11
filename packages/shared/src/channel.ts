import { z } from 'zod';

export const CHANNEL_KINDS = ['webhook', 'slack'] as const;
export const ChannelKindSchema = z.enum(CHANNEL_KINDS);
export const CHANNEL_LIMITS = { nameMaxLength: 100, urlMaxLength: 2048, maxMonitors: 500 } as const;
const url = z
  .string()
  .max(CHANNEL_LIMITS.urlMaxLength)
  .url()
  .refine((v) => /^https?:\/\//i.test(v), 'URL must use http or https');
const fields = {
  name: z.string().trim().min(1).max(100),
  kind: ChannelKindSchema,
  url,
  enabled: z.boolean(),
  monitorIds: z.array(z.uuid()).max(500),
};
export const ChannelSchema = z
  .object({ id: z.uuid(), ...fields, createdAt: z.iso.datetime() })
  .strict();
export const ChannelCreateSchema = z
  .object({
    name: fields.name,
    kind: fields.kind,
    url: fields.url,
    enabled: fields.enabled.default(true),
    monitorIds: fields.monitorIds.default([]),
  })
  .strict();
export const ChannelUpdateSchema = z
  .object({
    name: fields.name.optional(),
    kind: fields.kind.optional(),
    url: fields.url.optional(),
    enabled: fields.enabled.optional(),
    monitorIds: fields.monitorIds.optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, {
    message: 'at least one field is required',
    path: [],
  });
export const NOTIFICATION_EVENTS = ['incident.opened', 'incident.resolved', 'test'] as const;
export const NotificationEventSchema = z.enum(NOTIFICATION_EVENTS);
export const MAX_DELIVERY_ATTEMPTS = 3;
export const DELIVERY_RETRY_DELAYS_MS = [2_000, 10_000] as const;
export const DELIVERY_TIMEOUT_MS = 10_000;
export const DELIVERY_HISTORY_PER_CHANNEL = 20;
export const DeliveryAttemptSchema = z
  .object({
    id: z.uuid(),
    channelId: z.uuid(),
    incidentId: z.uuid().nullable(),
    event: NotificationEventSchema,
    attempt: z.number().int().min(1).max(3),
    attemptedAt: z.iso.datetime(),
    ok: z.boolean(),
    statusCode: z.number().int().nullable(),
    latencyMs: z.number().int().min(0),
    error: z.string().nullable(),
  })
  .strict();
export type Channel = z.infer<typeof ChannelSchema>;
export type ChannelKind = z.infer<typeof ChannelKindSchema>;
export type ChannelCreateInput = z.input<typeof ChannelCreateSchema>;
export type ChannelCreate = z.output<typeof ChannelCreateSchema>;
export type ChannelUpdate = z.infer<typeof ChannelUpdateSchema>;
export type NotificationEvent = z.infer<typeof NotificationEventSchema>;
export type DeliveryAttempt = z.infer<typeof DeliveryAttemptSchema>;
