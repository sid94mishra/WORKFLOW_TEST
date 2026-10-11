import { z } from 'zod';

export const CheckOutcomeSchema = z
  .object({
    checkedAt: z.iso.datetime(),
    ok: z.boolean(),
    statusCode: z.number().int().nullable(),
    latencyMs: z.number().int().min(0),
    error: z.string().nullable(),
    keywordMatched: z.boolean().nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.ok && value.error !== null) || (!value.ok && value.error === null)) {
      ctx.addIssue({
        code: 'custom',
        path: ['error'],
        message: 'error must be null iff ok is true',
      });
    }
  });
export const CheckResultSchema = CheckOutcomeSchema.extend({
  id: z.uuid(),
  monitorId: z.uuid(),
}).strict();
export type CheckOutcome = z.infer<typeof CheckOutcomeSchema>;
export type CheckResult = z.infer<typeof CheckResultSchema>;
