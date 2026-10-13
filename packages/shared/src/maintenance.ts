import { z } from 'zod';

/**
 * Maintenance windows (iteration 5 spec §3.1.1). Every time is UTC. Weekdays follow
 * `Date#getUTCDay()`: 0 = Sunday … 6 = Saturday. Intervals are half-open: `[start, end)`.
 */
export const MAINTENANCE_LIMITS = {
  titleMaxLength: 120,
  monitorIdsMax: 500,
  /** One-off windows: `endsAt - startsAt` ≤ 7 days. Also the max weekly occurrence length. */
  maxDurationMinutes: 7 * 24 * 60, // 10 080
  /** Weekly series: `endsAt - startsAt` ≤ 5 × 366 days. */
  maxSeriesDays: 5 * 366, // 1 830
} as const;
/** The status page lists occurrences overlapping `[now, now + 7 d)`, at most 20. */
export const UPCOMING_MAINTENANCE_DAYS = 7;
export const UPCOMING_MAINTENANCE_LIMIT = 20;
export const ALL_MONITORS = 'all' as const;

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const TIME_OF_DAY = /^([01]\d|2[0-3]):([0-5]\d)$/;

export const WeeklyRepeatSchema = z
  .object({
    /** UTC weekdays, 0 = Sunday … 6 = Saturday. Unique; the API returns them sorted. */
    weekdays: z
      .array(z.number().int().min(0).max(6))
      .min(1)
      .max(7)
      .refine((days) => new Set(days).size === days.length, 'weekdays must be unique')
      .transform((days) => [...days].sort((a, b) => a - b)),
    /** UTC start time of each occurrence, `HH:MM` (24 h). */
    startTime: z.string().regex(TIME_OF_DAY, 'startTime must be HH:MM (UTC, 24-hour)'),
    durationMinutes: z.number().int().min(1).max(MAINTENANCE_LIMITS.maxDurationMinutes),
  })
  .strict();

export const MaintenanceMonitorIdsSchema = z.union([
  z.literal(ALL_MONITORS),
  z.array(z.uuid()).min(1).max(MAINTENANCE_LIMITS.monitorIdsMax),
]);

export const MaintenanceCreatedBySchema = z
  .object({ kind: z.enum(['user', 'apiKey']), id: z.uuid() })
  .strict();

const fields = {
  title: z.string().trim().min(1).max(MAINTENANCE_LIMITS.titleMaxLength),
  monitorIds: MaintenanceMonitorIdsSchema,
  startsAt: z.iso.datetime(),
  endsAt: z.iso.datetime(),
  repeat: WeeklyRepeatSchema.nullable(),
};

type RangeInput = { startsAt?: string; endsAt?: string; repeat?: WeeklyRepeat | null };

/** Cross-field rules shared by create and the merged result of an update. */
export function checkMaintenanceRange(value: RangeInput, ctx: z.RefinementCtx): void {
  if (value.startsAt === undefined || value.endsAt === undefined) return;
  const span = Date.parse(value.endsAt) - Date.parse(value.startsAt);
  if (!(span > 0)) {
    ctx.addIssue({ code: 'custom', path: ['endsAt'], message: 'endsAt must be after startsAt' });
    return;
  }
  if (value.repeat == null && span > MAINTENANCE_LIMITS.maxDurationMinutes * MINUTE_MS) {
    ctx.addIssue({
      code: 'custom',
      path: ['endsAt'],
      message: 'a one-off window may last at most 7 days',
    });
  }
  if (value.repeat != null && span > MAINTENANCE_LIMITS.maxSeriesDays * DAY_MS) {
    ctx.addIssue({
      code: 'custom',
      path: ['endsAt'],
      message: 'a weekly series may span at most 1830 days',
    });
  }
}

export const MaintenanceWindowCreateSchema = z
  .object({ ...fields, repeat: fields.repeat.default(null) })
  .strict()
  .superRefine(checkMaintenanceRange);

/**
 * PATCH body. Range rules need both ends, so the route MUST re-validate the merged window with
 * `MaintenanceWindowCreateSchema` (like monitors do with `MonitorSchema`).
 */
export const MaintenanceWindowUpdateSchema = z
  .object({
    title: fields.title.optional(),
    monitorIds: fields.monitorIds.optional(),
    startsAt: fields.startsAt.optional(),
    endsAt: fields.endsAt.optional(),
    repeat: fields.repeat.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'at least one field is required',
    path: [],
  })
  .superRefine(checkMaintenanceRange);

export const MaintenanceOccurrenceSchema = z
  .object({ startsAt: z.iso.datetime(), endsAt: z.iso.datetime() })
  .strict();

export const MaintenanceWindowSchema = z
  .object({
    id: z.uuid(),
    title: z.string(),
    monitorIds: MaintenanceMonitorIdsSchema,
    startsAt: z.iso.datetime(),
    endsAt: z.iso.datetime(),
    repeat: WeeklyRepeatSchema.nullable(),
    createdBy: MaintenanceCreatedBySchema.nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    /** Computed at request time: is an occurrence in progress now? */
    active: z.boolean(),
    /** Computed: the occurrence in progress, else the next one, else null (series over). */
    nextOccurrence: MaintenanceOccurrenceSchema.nullable(),
  })
  .strict();

/** The window affecting a monitor right now (`Monitor.maintenance`, `PublicMonitor.maintenance`). */
export const ActiveMaintenanceSchema = z
  .object({
    id: z.uuid(),
    title: z.string(),
    /** The current occurrence, clipped to the series bounds. */
    startsAt: z.iso.datetime(),
    endsAt: z.iso.datetime(),
  })
  .strict();

/** One entry in the status page's "Upcoming maintenance" list. */
export const PublicMaintenanceSchema = z
  .object({
    id: z.uuid(),
    title: z.string(),
    startsAt: z.iso.datetime(),
    endsAt: z.iso.datetime(),
    active: z.boolean(),
    allMonitors: z.boolean(),
    /** Public affected monitors only, in status-page order. */
    monitors: z.array(z.object({ id: z.uuid(), name: z.string() }).strict()),
  })
  .strict();

export type WeeklyRepeat = z.output<typeof WeeklyRepeatSchema>;
export type MaintenanceMonitorIds = z.infer<typeof MaintenanceMonitorIdsSchema>;
export type MaintenanceCreatedBy = z.infer<typeof MaintenanceCreatedBySchema>;
export type MaintenanceWindowCreateInput = z.input<typeof MaintenanceWindowCreateSchema>;
export type MaintenanceWindowCreate = z.output<typeof MaintenanceWindowCreateSchema>;
export type MaintenanceWindowUpdate = z.output<typeof MaintenanceWindowUpdateSchema>;
export type MaintenanceWindow = z.infer<typeof MaintenanceWindowSchema>;
export type MaintenanceOccurrence = z.infer<typeof MaintenanceOccurrenceSchema>;
export type ActiveMaintenance = z.infer<typeof ActiveMaintenanceSchema>;
export type PublicMaintenance = z.infer<typeof PublicMaintenanceSchema>;

/** What the evaluator needs. Accepts API rows, DB-mapped rows and form state alike. */
export type MaintenanceSchedule = {
  startsAt: string | Date;
  endsAt: string | Date;
  repeat: WeeklyRepeat | null;
};
export type MaintenanceTarget = MaintenanceSchedule & {
  id: string;
  title: string;
  monitorIds: MaintenanceMonitorIds;
};
type Interval = { start: number; end: number };

const ms = (value: string | Date) =>
  typeof value === 'string' ? Date.parse(value) : value.getTime();
const iso = (value: number) => new Date(value).toISOString();

/** `HH:MM` → minutes after midnight. Throws on malformed input (schemas reject it first). */
export function parseTimeOfDay(value: string): number {
  const match = TIME_OF_DAY.exec(value);
  if (!match) throw new RangeError(`invalid time of day: ${value}`);
  return Number(match[1]) * 60 + Number(match[2]);
}

/**
 * Occurrences overlapping `[from, to)`, clipped to the series bounds `[startsAt, endsAt)`,
 * sorted by start. A one-off window is its own single occurrence. Weekly occurrences that start
 * before `startsAt` are clipped, not dropped; occurrences may cross midnight and Sat→Sun.
 */
function intervals(window: MaintenanceSchedule, from: number, to: number): Interval[] {
  const seriesStart = ms(window.startsAt);
  const seriesEnd = ms(window.endsAt);
  const lo = Math.max(from, seriesStart);
  const hi = Math.min(to, seriesEnd);
  if (!(lo < hi)) return [];
  if (!window.repeat) return [{ start: seriesStart, end: seriesEnd }];
  const { weekdays, startTime, durationMinutes } = window.repeat;
  const offset = parseTimeOfDay(startTime) * MINUTE_MS;
  const duration = durationMinutes * MINUTE_MS;
  const result: Interval[] = [];
  // An occurrence lasts ≤ 7 days, so one starting 8 days before `lo` cannot reach it.
  const firstDay = Math.floor(lo / DAY_MS) * DAY_MS - 8 * DAY_MS;
  for (let day = firstDay; day < hi; day += DAY_MS) {
    if (!weekdays.includes(new Date(day).getUTCDay())) continue;
    const start = day + offset;
    const end = start + duration;
    const clipped = { start: Math.max(start, seriesStart), end: Math.min(end, seriesEnd) };
    const overlaps = clipped.start < clipped.end && clipped.start < hi && clipped.end > lo;
    if (overlaps) result.push(clipped);
  }
  return result;
}

const toOccurrence = (i: Interval): MaintenanceOccurrence => ({
  startsAt: iso(i.start),
  endsAt: iso(i.end),
});

/** Occurrences overlapping `[from, to)`. Callers SHOULD keep the range small (days, not years). */
export function occurrencesBetween(
  window: MaintenanceSchedule,
  from: Date,
  to: Date,
): MaintenanceOccurrence[] {
  return intervals(window, from.getTime(), to.getTime()).map(toOccurrence);
}

/** The occurrence containing `at`, or null. Overlapping occurrences → the earliest-starting one. */
export function currentOccurrence(
  window: MaintenanceSchedule,
  at: Date,
): MaintenanceOccurrence | null {
  const t = at.getTime();
  const hit = intervals(window, t, t + 1).find((i) => i.start <= t && t < i.end);
  return hit ? toOccurrence(hit) : null;
}

export function isWindowActive(window: MaintenanceSchedule, at: Date): boolean {
  return currentOccurrence(window, at) !== null;
}

/** The occurrence in progress at `at`, else the next one to start, else null. */
export function nextOccurrence(
  window: MaintenanceSchedule,
  at: Date,
): MaintenanceOccurrence | null {
  const current = currentOccurrence(window, at);
  if (current) return current;
  const t = at.getTime();
  const end = ms(window.endsAt);
  // Weekly occurrences recur within 7 days, so an 8-day look-ahead from the later of `at` and the
  // series start always finds the next one.
  const from = Math.max(t, ms(window.startsAt));
  const upTo = window.repeat ? Math.min(end, from + 8 * DAY_MS) : end;
  const next = intervals(window, t, upTo).find((i) => i.start >= t);
  return next ? toOccurrence(next) : null;
}

export function windowAppliesTo(
  window: Pick<MaintenanceTarget, 'monitorIds'>,
  monitorId: string,
): boolean {
  return window.monitorIds === ALL_MONITORS || window.monitorIds.includes(monitorId);
}

/**
 * The window that puts `monitorId` in maintenance at `at`, or null. When several are active the
 * one whose occurrence started first wins; ties break on `id` (ascending) so API, status page and
 * web agree.
 */
export function activeWindowFor(
  monitorId: string,
  windows: readonly MaintenanceTarget[],
  at: Date,
): ActiveMaintenance | null {
  let best: ActiveMaintenance | null = null;
  for (const window of windows) {
    if (!windowAppliesTo(window, monitorId)) continue;
    const occurrence = currentOccurrence(window, at);
    if (!occurrence) continue;
    if (
      !best ||
      occurrence.startsAt < best.startsAt ||
      (occurrence.startsAt === best.startsAt && window.id < best.id)
    ) {
      best = { id: window.id, title: window.title, ...occurrence };
    }
  }
  return best;
}

/**
 * Every occurrence of `windows` overlapping `[from, to)`, sorted by start then window id, capped at
 * `limit`. `active` marks occurrences in progress at `from`.
 */
export function upcomingOccurrences<W extends MaintenanceTarget>(
  windows: readonly W[],
  from: Date,
  to: Date,
  limit: number = UPCOMING_MAINTENANCE_LIMIT,
): (MaintenanceOccurrence & { window: W; active: boolean })[] {
  const t = from.getTime();
  return windows
    .flatMap((window) =>
      intervals(window, t, to.getTime()).map((i) => ({
        ...toOccurrence(i),
        window,
        active: i.start <= t,
      })),
    )
    .sort((a, b) =>
      a.startsAt === b.startsAt
        ? a.window.id < b.window.id
          ? -1
          : a.window.id > b.window.id
            ? 1
            : 0
        : a.startsAt < b.startsAt
          ? -1
          : 1,
    )
    .slice(0, limit);
}
