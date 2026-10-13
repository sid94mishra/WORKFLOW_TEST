import { describe, expect, it } from 'vitest';
import {
  ActiveMaintenanceSchema,
  MAINTENANCE_LIMITS,
  MaintenanceWindowCreateSchema,
  MaintenanceWindowSchema,
  MaintenanceWindowUpdateSchema,
  MonitorSchema,
  STATUS_BADGE_COLORS,
  StatusPageSchema,
  activeWindowFor,
  currentOccurrence,
  isWindowActive,
  nextOccurrence,
  occurrencesBetween,
  overallStatus,
  parseTimeOfDay,
  publicMonitorStatus,
  upcomingOccurrences,
  windowAppliesTo,
  type MaintenanceTarget,
} from '../src/index.js';

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const W1 = '00000000-0000-4000-8000-000000000001';
const W2 = '00000000-0000-4000-8000-000000000002';
const at = (s: string) => new Date(s);
// 2026-10-10 is a Saturday, 2026-10-11 a Sunday, 2026-10-13 a Tuesday.
const SAT = '2026-10-10';
const SUN = '2026-10-11';

const oneOff = (over: Partial<MaintenanceTarget> = {}): MaintenanceTarget => ({
  id: W1,
  title: 'DB upgrade',
  monitorIds: [A],
  startsAt: '2026-10-13T10:00:00.000Z',
  endsAt: '2026-10-13T11:00:00.000Z',
  repeat: null,
  ...over,
});
const weekly = (
  repeat: MaintenanceTarget['repeat'],
  over: Partial<MaintenanceTarget> = {},
): MaintenanceTarget => ({
  id: W1,
  title: 'Nightly backup',
  monitorIds: 'all',
  startsAt: '2026-01-01T00:00:00.000Z',
  endsAt: '2027-01-01T00:00:00.000Z',
  repeat,
  ...over,
});

describe('calendar assumptions', () => {
  it('uses UTC weekdays (0 = Sunday)', () => {
    expect(at(`${SAT}T12:00:00Z`).getUTCDay()).toBe(6);
    expect(at(`${SUN}T12:00:00Z`).getUTCDay()).toBe(0);
  });
});

describe('one-off windows', () => {
  const w = oneOff();
  it('is active on [startsAt, endsAt)', () => {
    expect(isWindowActive(w, at('2026-10-13T09:59:59.999Z'))).toBe(false);
    expect(isWindowActive(w, at('2026-10-13T10:00:00.000Z'))).toBe(true);
    expect(isWindowActive(w, at('2026-10-13T10:59:59.999Z'))).toBe(true);
    expect(isWindowActive(w, at('2026-10-13T11:00:00.000Z'))).toBe(false);
  });
  it('reports its occurrence and the next one', () => {
    expect(currentOccurrence(w, at('2026-10-13T10:30:00Z'))).toEqual({
      startsAt: '2026-10-13T10:00:00.000Z',
      endsAt: '2026-10-13T11:00:00.000Z',
    });
    expect(nextOccurrence(w, at('2026-10-01T00:00:00Z'))?.startsAt).toBe(
      '2026-10-13T10:00:00.000Z',
    );
    expect(nextOccurrence(w, at('2026-10-13T11:00:00Z'))).toBeNull();
  });
  it('accepts Date bounds', () => {
    const d = oneOff({ startsAt: at('2026-10-13T10:00:00Z'), endsAt: at('2026-10-13T11:00:00Z') });
    expect(isWindowActive(d, at('2026-10-13T10:00:00Z'))).toBe(true);
  });
  it('lists the occurrence only when it overlaps the range', () => {
    expect(occurrencesBetween(w, at('2026-10-13T00:00:00Z'), at('2026-10-13T10:00:00Z'))).toEqual(
      [],
    );
    expect(
      occurrencesBetween(w, at('2026-10-13T10:59:00Z'), at('2026-10-14T00:00:00Z')),
    ).toHaveLength(1);
  });
});

describe('weekly windows (UTC)', () => {
  it('evaluates start time and duration in UTC on the listed weekdays', () => {
    // Tuesdays and Thursdays 02:00–03:30 UTC.
    const w = weekly({ weekdays: [2, 4], startTime: '02:00', durationMinutes: 90 });
    expect(isWindowActive(w, at('2026-10-13T01:59:59.999Z'))).toBe(false);
    expect(isWindowActive(w, at('2026-10-13T02:00:00.000Z'))).toBe(true);
    expect(isWindowActive(w, at('2026-10-13T03:29:59.999Z'))).toBe(true);
    expect(isWindowActive(w, at('2026-10-13T03:30:00.000Z'))).toBe(false);
    expect(isWindowActive(w, at('2026-10-14T02:30:00Z'))).toBe(false); // Wednesday
    expect(isWindowActive(w, at('2026-10-15T02:30:00Z'))).toBe(true); // Thursday
  });

  it('handles an occurrence crossing midnight', () => {
    // Tuesday 23:00 for 2 h → Wednesday 01:00.
    const w = weekly({ weekdays: [2], startTime: '23:00', durationMinutes: 120 });
    expect(isWindowActive(w, at('2026-10-13T22:59:00Z'))).toBe(false);
    expect(isWindowActive(w, at('2026-10-13T23:30:00Z'))).toBe(true);
    expect(isWindowActive(w, at('2026-10-14T00:30:00Z'))).toBe(true);
    expect(isWindowActive(w, at('2026-10-14T01:00:00Z'))).toBe(false);
    // Monday 23:30 is not covered: the weekday is the occurrence's start day.
    expect(isWindowActive(w, at('2026-10-12T23:30:00Z'))).toBe(false);
    expect(currentOccurrence(w, at('2026-10-14T00:30:00Z'))).toEqual({
      startsAt: '2026-10-13T23:00:00.000Z',
      endsAt: '2026-10-14T01:00:00.000Z',
    });
  });

  it('handles an occurrence crossing Saturday → Sunday (week boundary)', () => {
    const w = weekly({ weekdays: [6], startTime: '22:00', durationMinutes: 4 * 60 });
    expect(isWindowActive(w, at(`${SAT}T21:59:00Z`))).toBe(false);
    expect(isWindowActive(w, at(`${SAT}T23:00:00Z`))).toBe(true);
    expect(isWindowActive(w, at(`${SUN}T01:59:00Z`))).toBe(true);
    expect(isWindowActive(w, at(`${SUN}T02:00:00Z`))).toBe(false);
  });

  it('handles a 7-day occurrence that spans the whole week', () => {
    const w = weekly({
      weekdays: [0],
      startTime: '00:00',
      durationMinutes: MAINTENANCE_LIMITS.maxDurationMinutes,
    });
    for (const day of ['11', '12', '13', '14', '15', '16', '17'])
      expect(isWindowActive(w, at(`2026-10-${day}T12:00:00Z`))).toBe(true);
    expect(currentOccurrence(w, at('2026-10-17T23:59:59Z'))?.startsAt).toBe(
      '2026-10-11T00:00:00.000Z',
    );
  });

  it('clips occurrences to the series bounds', () => {
    // Saturday 22:00 for 4 h, but the series starts Sunday 01:00 and ends the next Sunday 00:30.
    const w = weekly(
      { weekdays: [6], startTime: '22:00', durationMinutes: 240 },
      { startsAt: `${SUN}T01:00:00.000Z`, endsAt: '2026-10-18T00:30:00.000Z' },
    );
    expect(isWindowActive(w, at(`${SUN}T00:30:00Z`))).toBe(false); // before the series
    expect(currentOccurrence(w, at(`${SUN}T01:30:00Z`))).toEqual({
      startsAt: `${SUN}T01:00:00.000Z`,
      endsAt: `${SUN}T02:00:00.000Z`,
    });
    expect(currentOccurrence(w, at('2026-10-17T23:00:00Z'))).toEqual({
      startsAt: '2026-10-17T22:00:00.000Z',
      endsAt: '2026-10-18T00:30:00.000Z',
    });
    expect(isWindowActive(w, at('2026-10-18T00:30:00Z'))).toBe(false); // series over
    expect(nextOccurrence(w, at('2026-10-18T00:30:00Z'))).toBeNull();
  });

  it('lists occurrences in a range and finds the next one', () => {
    const w = weekly({ weekdays: [1, 3, 5], startTime: '06:15', durationMinutes: 30 });
    const list = occurrencesBetween(w, at('2026-10-13T00:00:00Z'), at('2026-10-20T00:00:00Z'));
    expect(list.map((o) => o.startsAt)).toEqual([
      '2026-10-14T06:15:00.000Z',
      '2026-10-16T06:15:00.000Z',
      '2026-10-19T06:15:00.000Z',
    ]);
    expect(nextOccurrence(w, at('2026-10-13T00:00:00Z'))).toEqual({
      startsAt: '2026-10-14T06:15:00.000Z',
      endsAt: '2026-10-14T06:45:00.000Z',
    });
    expect(nextOccurrence(w, at('2026-10-14T06:20:00Z'))?.startsAt).toBe(
      '2026-10-14T06:15:00.000Z',
    );
    // A series that starts months from now (on a Monday) still reports its first occurrence.
    const later = { ...w, startsAt: '2027-03-01T00:00:00.000Z', endsAt: '2027-06-01T00:00:00Z' };
    expect(nextOccurrence(later, at('2026-10-13T00:00:00Z'))?.startsAt).toBe(
      '2027-03-01T06:15:00.000Z',
    );
  });

  it('parses HH:MM', () => {
    expect(parseTimeOfDay('00:00')).toBe(0);
    expect(parseTimeOfDay('23:59')).toBe(1439);
    expect(() => parseTimeOfDay('24:00')).toThrow(RangeError);
  });
});

describe('activeWindowFor', () => {
  const a = oneOff({ id: W2, title: 'Later start', startsAt: '2026-10-13T10:30:00.000Z' });
  const b = oneOff({ id: W1, title: 'Only B', monitorIds: [B] });
  const all = weekly({ weekdays: [2], startTime: '10:00', durationMinutes: 60 }, { id: W2 });
  it('applies to listed monitors or to all', () => {
    expect(windowAppliesTo(b, A)).toBe(false);
    expect(windowAppliesTo(b, B)).toBe(true);
    expect(windowAppliesTo(all, A)).toBe(true);
  });
  it('returns the earliest-started active window, then the lowest id', () => {
    const t = at('2026-10-13T10:45:00Z');
    expect(activeWindowFor(A, [a, b], t)).toEqual({
      id: W2,
      title: 'Later start',
      startsAt: '2026-10-13T10:30:00.000Z',
      endsAt: '2026-10-13T11:00:00.000Z',
    });
    const early = oneOff({ id: W2, title: 'Early' });
    const tie = oneOff({ id: W1, title: 'Tie' });
    expect(activeWindowFor(A, [early, tie], t)?.title).toBe('Tie');
    expect(activeWindowFor(A, [a, all], t)?.id).toBe(W2);
    expect(activeWindowFor(A, [a], at('2026-10-13T11:00:00Z'))).toBeNull();
    expect(ActiveMaintenanceSchema.safeParse(activeWindowFor(B, [b], t)).success).toBe(true);
  });
});

describe('upcomingOccurrences', () => {
  it('sorts, flags in-progress occurrences and caps the list', () => {
    const now = at('2026-10-13T10:30:00Z');
    const w = weekly({ weekdays: [0, 1, 2, 3, 4, 5, 6], startTime: '10:00', durationMinutes: 60 });
    const one = oneOff({
      id: W2,
      startsAt: '2026-10-15T09:00:00.000Z',
      endsAt: '2026-10-15T09:30:00.000Z',
    });
    const list = upcomingOccurrences([w, one], now, at('2026-10-20T10:30:00Z'));
    expect(list[0]).toMatchObject({ startsAt: '2026-10-13T10:00:00.000Z', active: true });
    expect(list.filter((o) => o.active)).toHaveLength(1);
    expect(list.map((o) => o.startsAt)).toEqual([...list.map((o) => o.startsAt)].sort());
    // Daily Oct 13 (in progress) … Oct 20 10:00 = 8, plus the one-off on Oct 15.
    expect(list).toHaveLength(9);
    expect(list.some((o) => o.window.id === W2)).toBe(true);
    expect(upcomingOccurrences([w], now, at('2026-12-31T00:00:00Z'))).toHaveLength(20);
  });
});

describe('maintenance schemas', () => {
  const base = {
    title: '  DB upgrade ',
    monitorIds: [A],
    startsAt: '2026-10-13T10:00:00.000Z',
    endsAt: '2026-10-13T11:00:00.000Z',
  };
  it('creates one-off windows with defaults and trims the title', () => {
    expect(MaintenanceWindowCreateSchema.parse(base)).toEqual({
      ...base,
      title: 'DB upgrade',
      repeat: null,
    });
    expect(MaintenanceWindowCreateSchema.parse({ ...base, monitorIds: 'all' }).monitorIds).toBe(
      'all',
    );
  });
  it('rejects bad ranges, empty targets and unknown fields', () => {
    const bad = (body: object) => MaintenanceWindowCreateSchema.safeParse({ ...base, ...body });
    expect(bad({ endsAt: base.startsAt }).error?.issues[0]?.path).toEqual(['endsAt']);
    expect(bad({ endsAt: '2026-10-20T10:00:00.001Z' }).success).toBe(false); // > 7 days one-off
    expect(bad({ endsAt: '2026-10-20T10:00:00.000Z' }).success).toBe(true); // exactly 7 days
    expect(bad({ monitorIds: [] }).success).toBe(false);
    expect(bad({ monitorIds: ['nope'] }).success).toBe(false);
    expect(bad({ monitorIds: 'some' }).success).toBe(false);
    expect(bad({ title: ' ' }).success).toBe(false);
    expect(bad({ title: 'x'.repeat(121) }).success).toBe(false);
    expect(bad({ createdBy: null }).success).toBe(false);
    expect(bad({ startsAt: '2026-10-13T10:00:00+02:00' }).success).toBe(false); // UTC only
  });
  it('validates weekly repeat and allows long series', () => {
    const repeat = { weekdays: [6, 0], startTime: '22:00', durationMinutes: 240 };
    const parsed = MaintenanceWindowCreateSchema.parse({
      ...base,
      endsAt: '2027-10-13T10:00:00.000Z',
      repeat,
    });
    expect(parsed.repeat?.weekdays).toEqual([0, 6]);
    const bad = (r: object) =>
      MaintenanceWindowCreateSchema.safeParse({ ...base, repeat: { ...repeat, ...r } }).success;
    expect(bad({ weekdays: [] })).toBe(false);
    expect(bad({ weekdays: [7] })).toBe(false);
    expect(bad({ weekdays: [1, 1] })).toBe(false);
    expect(bad({ startTime: '24:00' })).toBe(false);
    expect(bad({ startTime: '2:00' })).toBe(false);
    expect(bad({ durationMinutes: 0 })).toBe(false);
    expect(bad({ durationMinutes: 10_081 })).toBe(false);
    expect(bad({ extra: 1 })).toBe(false);
    expect(
      MaintenanceWindowCreateSchema.safeParse({
        ...base,
        endsAt: '2031-12-31T00:00:00.000Z',
        repeat,
      }).success,
    ).toBe(false); // series > 1830 days
  });
  it('accepts partial updates, clearing repeat, and rejects empty bodies', () => {
    expect(MaintenanceWindowUpdateSchema.safeParse({ repeat: null }).success).toBe(true);
    expect(MaintenanceWindowUpdateSchema.safeParse({ title: 'x' }).success).toBe(true);
    expect(MaintenanceWindowUpdateSchema.safeParse({}).success).toBe(false);
    expect(
      MaintenanceWindowUpdateSchema.safeParse({ startsAt: base.endsAt, endsAt: base.startsAt })
        .success,
    ).toBe(false);
  });
  it('describes the response shape', () => {
    const window = {
      id: W1,
      ...base,
      title: 'DB upgrade',
      repeat: null,
      createdBy: { kind: 'apiKey', id: W2 },
      createdAt: '2026-10-12T00:00:00.000Z',
      updatedAt: '2026-10-12T00:00:00.000Z',
      active: false,
      nextOccurrence: { startsAt: base.startsAt, endsAt: base.endsAt },
    };
    expect(MaintenanceWindowSchema.safeParse(window).success).toBe(true);
    expect(MaintenanceWindowSchema.safeParse({ ...window, createdBy: null }).success).toBe(true);
  });
});

describe('display status', () => {
  it('derives maintenance with paused taking precedence', () => {
    expect(publicMonitorStatus({ enabled: true, status: 'down' }, true)).toBe('maintenance');
    expect(publicMonitorStatus({ enabled: false, status: 'down' }, true)).toBe('paused');
    expect(publicMonitorStatus({ enabled: true, status: 'down' }, false)).toBe('down');
    expect(STATUS_BADGE_COLORS.maintenance).toBe('#007ec6');
  });
  it('ignores monitors in maintenance for the overall status', () => {
    expect(overallStatus([{ status: 'maintenance' }, { status: 'up' }])).toBe('operational');
    expect(overallStatus([{ status: 'maintenance' }, { status: 'down' }])).toBe('major_outage');
    expect(overallStatus([{ status: 'maintenance' }, { status: 'paused' }])).toBe('maintenance');
    expect(overallStatus([{ status: 'paused' }])).toBe('unknown');
  });
  it('keeps older monitor and status page payloads valid', () => {
    const monitor = {
      id: A,
      name: 'API',
      url: 'https://example.test',
      method: 'GET',
      intervalSeconds: 60,
      timeoutMs: 1000,
      expectedStatus: 200,
      keyword: null,
      enabled: true,
      public: false,
      status: 'down',
      lastCheckedAt: null,
      createdAt: '2026-10-11T00:00:00.000Z',
    };
    expect(MonitorSchema.safeParse(monitor).success).toBe(true);
    expect(MonitorSchema.safeParse({ ...monitor, maintenance: null }).success).toBe(true);
    expect(
      MonitorSchema.safeParse({
        ...monitor,
        maintenance: { id: W1, title: 'x', startsAt: monitor.createdAt, endsAt: monitor.createdAt },
      }).success,
    ).toBe(true);
    const page = {
      generatedAt: '2026-10-13T00:00:00.000Z',
      overall: 'maintenance',
      monitors: [],
      incidents: { open: [], resolved: [] },
    };
    expect(StatusPageSchema.safeParse(page).success).toBe(true);
    expect(
      StatusPageSchema.safeParse({
        ...page,
        upcomingMaintenance: [
          {
            id: W1,
            title: 'DB upgrade',
            startsAt: '2026-10-13T10:00:00.000Z',
            endsAt: '2026-10-13T11:00:00.000Z',
            active: false,
            allMonitors: false,
            monitors: [{ id: A, name: 'API' }],
          },
        ],
      }).success,
    ).toBe(true);
  });
});
