import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { MAINTENANCE_LIMITS } from '@pulse/shared';
import { api, ApiClientError, type ApiClient } from '../api/client';
import type {
  MaintenanceWindow,
  MaintenanceWindowCreateInput,
  MaintenanceWindowUpdate,
  Monitor,
  WeeklyRepeat,
} from '../api/types';

export interface MaintenanceDialogProps {
  /** Present when editing; absent when scheduling a new window. */
  item?: MaintenanceWindow;
  monitors: Monitor[];
  onSaved: (w: MaintenanceWindow) => void;
  onClose: () => void;
  client?: ApiClient;
}

type FieldKey = 'title' | 'monitorIds' | 'startsAt' | 'endsAt' | 'repeat';
const FIELD_ORDER: FieldKey[] = ['title', 'monitorIds', 'startsAt', 'endsAt', 'repeat'];
type Errors = Partial<Record<FieldKey, string>>;

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const TIME_OF_DAY = /^([01]\d|2[0-3]):([0-5]\d)$/;
const FOCUSABLE =
  'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

const inputClass =
  'block w-full rounded-md border border-slate-400 bg-white px-3 py-2 text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600 focus-visible:ring-offset-1 aria-[invalid=true]:border-red-700';
const checkboxClass =
  'size-4 rounded border-slate-400 text-indigo-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600 focus-visible:ring-offset-1';

/** ISO instant → value for `<input type="datetime-local">`, read as UTC (no zone shift). */
export function isoToUtcInput(iso: string): string {
  return iso.slice(0, 16);
}

/** `datetime-local` value (`YYYY-MM-DDTHH:MM[:SS]`) typed as UTC → ISO string, or null. */
export function utcInputToIso(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(value)) return null;
  const date = new Date(value.length === 16 ? `${value}:00Z` : `${value}Z`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function mapIssues(issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>) {
  const fields: Errors = {};
  const form: string[] = [];
  for (const issue of issues) {
    const key = issue.path[0];
    if (FIELD_ORDER.includes(key as FieldKey)) fields[key as FieldKey] ??= issue.message;
    else form.push(issue.message);
  }
  return { fields, form };
}

const sameSet = <T,>(a: T[], b: T[]) => a.length === b.length && a.every((x) => b.includes(x));
const sameRepeat = (a: WeeklyRepeat | null, b: WeeklyRepeat | null) =>
  a === null || b === null
    ? a === b
    : a.startTime === b.startTime &&
      a.durationMinutes === b.durationMinutes &&
      sameSet(a.weekdays, b.weekdays);

export function MaintenanceDialog({
  item: existing,
  monitors,
  onSaved,
  onClose,
  client = api,
}: MaintenanceDialogProps) {
  const original = existing?.repeat ?? null;
  const [title, setTitle] = useState(existing?.title ?? '');
  const [allMonitors, setAllMonitors] = useState(existing ? existing.monitorIds === 'all' : false);
  const [monitorIds, setMonitorIds] = useState<string[]>(
    existing && existing.monitorIds !== 'all' ? existing.monitorIds : [],
  );
  const [startsAt, setStartsAt] = useState(existing ? isoToUtcInput(existing.startsAt) : '');
  const [endsAt, setEndsAt] = useState(existing ? isoToUtcInput(existing.endsAt) : '');
  const [weekly, setWeekly] = useState(original !== null);
  const [weekdays, setWeekdays] = useState<number[]>(original?.weekdays ?? []);
  const [startTime, setStartTime] = useState(original?.startTime ?? '');
  const [hours, setHours] = useState(
    original ? String(Math.floor(original.durationMinutes / 60)) : '',
  );
  const [minutes, setMinutes] = useState(original ? String(original.durationMinutes % 60) : '');
  const [errors, setErrors] = useState<Errors>({});
  const [formErrors, setFormErrors] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  const dialogRef = useRef<HTMLDivElement>(null);
  const fieldRefs = useRef<Partial<Record<FieldKey, HTMLElement | null>>>({});
  const opener = useRef<Element | null>(document.activeElement);

  useEffect(() => {
    const returnTo = opener.current;
    fieldRefs.current.title?.focus();
    return () => {
      if (returnTo instanceof HTMLElement) returnTo.focus();
    };
  }, []);

  const id = (f: string) => `maintenance-${f}`;
  const errId = (f: FieldKey) => `maintenance-${f}-error`;
  const clear = (f: FieldKey) =>
    setErrors((e) => {
      if (!e[f]) return e;
      const { [f]: _removed, ...rest } = e;
      return rest;
    });
  const a11y = (f: FieldKey) => ({
    id: id(f),
    'aria-invalid': errors[f] ? (true as const) : undefined,
    'aria-describedby': errors[f] ? errId(f) : undefined,
  });
  const setRef = (f: FieldKey) => (el: HTMLElement | null) => {
    fieldRefs.current[f] = el;
  };
  const error = (f: FieldKey) =>
    errors[f] ? (
      <p id={errId(f)} className="mt-1 text-sm text-red-800">
        {errors[f]}
      </p>
    ) : null;
  const label = (f: string, text: string) => (
    <label htmlFor={id(f)} className="mb-1 block text-sm font-medium text-slate-900">
      {text}
    </label>
  );

  function showErrors(fields: Errors, form: string[]) {
    setErrors(fields);
    setFormErrors(form);
    const first = FIELD_ORDER.find((f) => fields[f]);
    if (first) fieldRefs.current[first]?.focus();
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.stopPropagation();
      if (!saving) onClose();
      return;
    }
    if (event.key !== 'Tab' || !dialogRef.current) return;
    const items = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE));
    const first = items[0];
    const last = items[items.length - 1];
    if (!first || !last) return;
    const active = document.activeElement;
    if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function validate(): { fields: Errors; repeat: WeeklyRepeat | null } {
    const fields: Errors = {};
    if (title.trim().length === 0) fields.title = 'Title is required';
    else if (title.trim().length > MAINTENANCE_LIMITS.titleMaxLength)
      fields.title = `Title must be at most ${MAINTENANCE_LIMITS.titleMaxLength} characters`;
    if (!allMonitors && monitorIds.length === 0)
      fields.monitorIds = 'Select at least one monitor, or choose All monitors';
    if (utcInputToIso(startsAt) === null) fields.startsAt = 'Enter a start date and time (UTC)';
    if (utcInputToIso(endsAt) === null) fields.endsAt = 'Enter an end date and time (UTC)';
    let repeat: WeeklyRepeat | null = null;
    if (weekly) {
      const total = (Number(hours) || 0) * 60 + (Number(minutes) || 0);
      if (weekdays.length === 0) fields.repeat = 'Select at least one weekday';
      else if (!TIME_OF_DAY.test(startTime)) fields.repeat = 'Enter a start time as HH:MM (UTC)';
      else if (
        !Number.isInteger(total) ||
        total < 1 ||
        total > MAINTENANCE_LIMITS.maxDurationMinutes
      )
        fields.repeat = 'Duration must be between 1 minute and 7 days';
      else
        repeat = {
          weekdays: [...weekdays].sort((a, b) => a - b),
          startTime,
          durationMinutes: total,
        };
    }
    return { fields, repeat };
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    setFormErrors([]);
    const { fields, repeat } = validate();
    if (Object.keys(fields).length > 0) {
      showErrors(fields, []);
      return;
    }
    setErrors({});
    const startIso = utcInputToIso(startsAt)!;
    const endIso = utcInputToIso(endsAt)!;
    const targets = allMonitors ? ('all' as const) : monitorIds;

    setSaving(true);
    try {
      let saved: MaintenanceWindow;
      if (existing) {
        const patch: MaintenanceWindowUpdate = {};
        if (title.trim() !== existing.title) patch.title = title.trim();
        const sameTargets =
          existing.monitorIds === 'all' || targets === 'all'
            ? existing.monitorIds === targets
            : sameSet(existing.monitorIds, targets);
        if (!sameTargets) patch.monitorIds = targets;
        if (startsAt !== isoToUtcInput(existing.startsAt)) patch.startsAt = startIso;
        if (endsAt !== isoToUtcInput(existing.endsAt)) patch.endsAt = endIso;
        if (!sameRepeat(original, repeat)) patch.repeat = repeat;
        if (Object.keys(patch).length === 0) {
          onClose();
          return;
        }
        saved = await client.updateMaintenance(existing.id, patch);
      } else {
        const input: MaintenanceWindowCreateInput = {
          title: title.trim(),
          monitorIds: targets,
          startsAt: startIso,
          endsAt: endIso,
          repeat,
        };
        saved = await client.createMaintenance(input);
      }
      onSaved(saved);
    } catch (err) {
      if (err instanceof ApiClientError && err.status === 400 && err.code === 'VALIDATION_ERROR') {
        const { fields, form } = mapIssues(
          err.issues as { path: PropertyKey[]; message: string }[],
        );
        showErrors(
          fields,
          form.length === 0 && Object.keys(fields).length === 0 ? [err.message] : form,
        );
      } else {
        setFormErrors([err instanceof ApiClientError ? err.message : 'Unexpected error']);
      }
    } finally {
      setSaving(false);
    }
  }

  const heading = existing ? 'Edit maintenance' : 'Schedule maintenance';
  const monitorLabel = (m: Monitor) => m.name;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/50 p-3 sm:p-6"
      onKeyDown={onKeyDown}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="maintenance-dialog-heading"
        className="my-auto w-full max-w-xl rounded-md bg-white p-4 shadow-xl sm:p-6"
      >
        <h2 id="maintenance-dialog-heading" className="mb-4 text-xl font-semibold text-slate-900">
          {heading}
        </h2>
        <form noValidate aria-busy={saving} onSubmit={handleSubmit}>
          <fieldset disabled={saving} className="min-w-0 space-y-4">
            <div>
              {label('title', 'Title')}
              <input
                {...a11y('title')}
                ref={setRef('title')}
                type="text"
                required
                aria-describedby={
                  errors.title
                    ? `${errId('title')} maintenance-title-hint`
                    : 'maintenance-title-hint'
                }
                value={title}
                onChange={(e) => {
                  setTitle(e.target.value);
                  clear('title');
                }}
                className={inputClass}
              />
              <p id="maintenance-title-hint" className="mt-1 text-sm text-slate-700">
                Shown on the public status page if a public monitor is affected.
              </p>
              {error('title')}
            </div>

            <fieldset
              aria-describedby={errors.monitorIds ? errId('monitorIds') : undefined}
              className="min-w-0 space-y-2"
            >
              <legend className="mb-1 text-sm font-medium text-slate-900">Monitors</legend>
              <div className="flex items-center gap-2">
                <input
                  {...a11y('monitorIds')}
                  ref={setRef('monitorIds')}
                  type="checkbox"
                  checked={allMonitors}
                  onChange={(e) => {
                    setAllMonitors(e.target.checked);
                    clear('monitorIds');
                  }}
                  className={checkboxClass}
                />
                <label htmlFor={id('monitorIds')} className="text-sm font-medium text-slate-900">
                  All monitors
                </label>
              </div>
              {!allMonitors &&
                (monitors.length === 0 ? (
                  <p className="text-sm text-slate-700">No monitors yet.</p>
                ) : (
                  <ul className="max-h-48 space-y-2 overflow-y-auto pl-1">
                    {monitors.map((m) => (
                      <li key={m.id} className="flex items-center gap-2">
                        <input
                          id={`maintenance-monitor-${m.id}`}
                          type="checkbox"
                          checked={monitorIds.includes(m.id)}
                          onChange={(e) => {
                            clear('monitorIds');
                            setMonitorIds((ids) =>
                              e.target.checked ? [...ids, m.id] : ids.filter((x) => x !== m.id),
                            );
                          }}
                          className={checkboxClass}
                        />
                        <label
                          htmlFor={`maintenance-monitor-${m.id}`}
                          className="break-all text-sm text-slate-900"
                        >
                          {monitorLabel(m)}
                        </label>
                      </li>
                    ))}
                  </ul>
                ))}
              {error('monitorIds')}
            </fieldset>

            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                {label('startsAt', weekly ? 'Repeat from (UTC)' : 'Starts (UTC)')}
                <input
                  {...a11y('startsAt')}
                  ref={setRef('startsAt')}
                  type="datetime-local"
                  required
                  value={startsAt}
                  onChange={(e) => {
                    setStartsAt(e.target.value);
                    clear('startsAt');
                  }}
                  className={inputClass}
                />
                {error('startsAt')}
              </div>
              <div>
                {label('endsAt', weekly ? 'Repeat until (UTC)' : 'Ends (UTC)')}
                <input
                  {...a11y('endsAt')}
                  ref={setRef('endsAt')}
                  type="datetime-local"
                  required
                  value={endsAt}
                  onChange={(e) => {
                    setEndsAt(e.target.value);
                    clear('endsAt');
                  }}
                  className={inputClass}
                />
                {error('endsAt')}
              </div>
            </div>
            <p className="text-sm text-slate-700">All times are UTC, not your local time zone.</p>

            <div className="flex items-center gap-2">
              <input
                id={id('weekly')}
                type="checkbox"
                checked={weekly}
                onChange={(e) => {
                  setWeekly(e.target.checked);
                  clear('repeat');
                }}
                className={checkboxClass}
              />
              <label htmlFor={id('weekly')} className="text-sm font-medium text-slate-900">
                Repeat weekly
              </label>
            </div>

            {weekly && (
              <div className="space-y-3 rounded-md border border-slate-300 p-3">
                <fieldset className="min-w-0">
                  <legend className="mb-1 text-sm font-medium text-slate-900">
                    Weekdays (UTC)
                  </legend>
                  <div className="flex flex-wrap gap-x-4 gap-y-2">
                    {WEEKDAYS.map((name, day) => (
                      <div key={name} className="flex items-center gap-1.5">
                        <input
                          id={`maintenance-weekday-${day}`}
                          type="checkbox"
                          checked={weekdays.includes(day)}
                          onChange={(e) => {
                            clear('repeat');
                            setWeekdays((days) =>
                              e.target.checked ? [...days, day] : days.filter((d) => d !== day),
                            );
                          }}
                          className={checkboxClass}
                        />
                        <label
                          htmlFor={`maintenance-weekday-${day}`}
                          className="text-sm text-slate-900"
                        >
                          {name}
                        </label>
                      </div>
                    ))}
                  </div>
                </fieldset>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    {label('start-time', 'Start time (UTC)')}
                    <input
                      id={id('start-time')}
                      ref={setRef('repeat')}
                      type="time"
                      aria-invalid={errors.repeat ? true : undefined}
                      aria-describedby={errors.repeat ? errId('repeat') : undefined}
                      value={startTime}
                      onChange={(e) => {
                        setStartTime(e.target.value);
                        clear('repeat');
                      }}
                      className={inputClass}
                    />
                  </div>
                  <fieldset className="min-w-0">
                    <legend className="mb-1 text-sm font-medium text-slate-900">Duration</legend>
                    <div className="flex items-center gap-2">
                      <input
                        id={id('hours')}
                        type="number"
                        min={0}
                        max={168}
                        inputMode="numeric"
                        aria-label="Duration hours"
                        aria-invalid={errors.repeat ? true : undefined}
                        value={hours}
                        onChange={(e) => {
                          setHours(e.target.value);
                          clear('repeat');
                        }}
                        className={inputClass}
                      />
                      <span className="text-sm text-slate-900">h</span>
                      <input
                        id={id('minutes')}
                        type="number"
                        min={0}
                        max={59}
                        inputMode="numeric"
                        aria-label="Duration minutes"
                        aria-invalid={errors.repeat ? true : undefined}
                        value={minutes}
                        onChange={(e) => {
                          setMinutes(e.target.value);
                          clear('repeat');
                        }}
                        className={inputClass}
                      />
                      <span className="text-sm text-slate-900">min</span>
                    </div>
                  </fieldset>
                </div>
                {error('repeat')}
              </div>
            )}

            {formErrors.length > 0 && (
              <div
                role="alert"
                className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-900"
              >
                {formErrors.map((m) => (
                  <p key={m}>{m}</p>
                ))}
              </div>
            )}

            <div className="flex flex-wrap gap-3">
              <button
                type="submit"
                className="rounded-md bg-indigo-700 px-4 py-2 font-medium text-white hover:bg-indigo-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:bg-slate-500"
              >
                {saving ? 'Saving…' : existing ? 'Save' : 'Create'}
              </button>
              <button
                type="button"
                onClick={onClose}
                className="rounded-md border border-slate-400 bg-white px-4 py-2 font-medium text-slate-900 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:text-slate-600"
              >
                Cancel
              </button>
            </div>
          </fieldset>
        </form>
      </div>
    </div>
  );
}
