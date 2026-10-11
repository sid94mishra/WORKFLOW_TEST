import { z } from 'zod';

export const INCIDENT_STATUSES = ['open', 'resolved'] as const;
export const IncidentStatusSchema = z.enum(INCIDENT_STATUSES);
export const IncidentSchema = z
  .object({
    id: z.uuid(),
    monitorId: z.uuid(),
    monitorName: z.string(),
    status: IncidentStatusSchema,
    cause: z.string().nullable(),
    startedAt: z.iso.datetime(),
    resolvedAt: z.iso.datetime().nullable(),
    durationSeconds: z.number().int().min(0).nullable(),
  })
  .strict();
export const INCIDENTS_LIMITS = { default: 50, min: 1, max: 200 } as const;
export const IncidentsQuerySchema = z.object({
  status: z.enum(['open', 'resolved', 'all']).default('all'),
  monitorId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type Incident = z.infer<typeof IncidentSchema>;
export type IncidentStatus = z.infer<typeof IncidentStatusSchema>;
export type IncidentsQuery = z.infer<typeof IncidentsQuerySchema>;
