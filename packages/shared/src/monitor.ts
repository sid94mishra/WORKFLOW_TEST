import { z } from 'zod';
import { MonitorStatusSchema } from './status.js';
import { ActiveMaintenanceSchema } from './maintenance.js';

export const HTTP_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const;
export const MONITOR_DEFAULTS = {
  method: 'GET',
  intervalSeconds: 60,
  timeoutMs: 10_000,
  expectedStatus: 200,
  enabled: true,
  public: false,
} as const;
export const MONITOR_LIMITS = {
  nameMaxLength: 100,
  urlMaxLength: 2048,
  keywordMaxLength: 200,
  intervalSeconds: { min: 30, max: 86_400 },
  timeoutMs: { min: 1_000, max: 60_000 },
  expectedStatus: { min: 100, max: 599 },
} as const;

const url = z
  .string()
  .max(MONITOR_LIMITS.urlMaxLength)
  .url()
  .refine((value) => /^https?:\/\//i.test(value), 'URL must use http or https');
const keyword = z.string().min(1).max(MONITOR_LIMITS.keywordMaxLength).nullable();
const fields = {
  name: z.string().trim().min(1).max(MONITOR_LIMITS.nameMaxLength),
  url,
  method: z.enum(HTTP_METHODS),
  intervalSeconds: z
    .number()
    .int()
    .min(MONITOR_LIMITS.intervalSeconds.min)
    .max(MONITOR_LIMITS.intervalSeconds.max),
  timeoutMs: z.number().int().min(MONITOR_LIMITS.timeoutMs.min).max(MONITOR_LIMITS.timeoutMs.max),
  expectedStatus: z
    .number()
    .int()
    .min(MONITOR_LIMITS.expectedStatus.min)
    .max(MONITOR_LIMITS.expectedStatus.max),
  keyword,
  enabled: z.boolean(),
  public: z.boolean(),
};

const headKeywordRule = <T extends { method?: HttpMethod; keyword?: string | null }>(
  value: T,
  ctx: z.RefinementCtx,
) => {
  if (value.method === 'HEAD' && value.keyword != null) {
    ctx.addIssue({
      code: 'custom',
      path: ['keyword'],
      message: 'keyword is not supported with HEAD',
    });
  }
};

export const MonitorSchema = z
  .object({
    id: z.uuid(),
    ...fields,
    public: fields.public.default(MONITOR_DEFAULTS.public),
    status: MonitorStatusSchema,
    lastCheckedAt: z.iso.datetime().nullable(),
    createdAt: z.iso.datetime(),
    /**
     * Read-only, computed per request (iteration 5): the window putting this monitor in
     * maintenance now, or null. The API always sends it; optional so older payloads still parse.
     */
    maintenance: ActiveMaintenanceSchema.nullable().optional(),
  })
  .strict()
  .superRefine(headKeywordRule);
export const MonitorCreateSchema = z
  .object({
    name: fields.name,
    url: fields.url,
    method: fields.method.default(MONITOR_DEFAULTS.method),
    intervalSeconds: fields.intervalSeconds.default(MONITOR_DEFAULTS.intervalSeconds),
    timeoutMs: fields.timeoutMs.default(MONITOR_DEFAULTS.timeoutMs),
    expectedStatus: fields.expectedStatus.default(MONITOR_DEFAULTS.expectedStatus),
    keyword: keyword.optional().default(null),
    enabled: fields.enabled.default(MONITOR_DEFAULTS.enabled),
    public: fields.public.default(MONITOR_DEFAULTS.public),
  })
  .strict()
  .superRefine(headKeywordRule);
export const MonitorUpdateSchema = z
  .object({
    name: fields.name.optional(),
    url: fields.url.optional(),
    method: fields.method.optional(),
    intervalSeconds: fields.intervalSeconds.optional(),
    timeoutMs: fields.timeoutMs.optional(),
    expectedStatus: fields.expectedStatus.optional(),
    keyword: keyword.optional(),
    enabled: fields.enabled.optional(),
    public: fields.public.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'at least one field is required',
    path: [],
  });
export const MonitorListQuerySchema = z.object({
  q: z.string().trim().optional(),
  status: MonitorStatusSchema.optional(),
});

export type HttpMethod = (typeof HTTP_METHODS)[number];
export type Monitor = z.infer<typeof MonitorSchema>;
export type MonitorCreateInput = z.input<typeof MonitorCreateSchema>;
export type MonitorCreate = z.output<typeof MonitorCreateSchema>;
export type MonitorListQuery = z.infer<typeof MonitorListQuerySchema>;
export type MonitorUpdate = z.infer<typeof MonitorUpdateSchema>;
