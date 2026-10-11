import { useRef, useState, type FormEvent } from 'react';
import {
  HTTP_METHODS,
  MONITOR_DEFAULTS,
  MONITOR_LIMITS,
  MonitorCreateSchema,
  type ApiIssue,
  type HttpMethod,
  type MonitorCreateInput,
} from '@pulse/shared';
import { api, ApiClientError, type ApiClient } from '../api/client';
import type { Monitor } from '../api/types';

export interface AddMonitorFormProps {
  onCreated: (m: Monitor) => void;
  client?: ApiClient;
}

type FieldKey =
  | 'name'
  | 'url'
  | 'method'
  | 'intervalSeconds'
  | 'timeoutMs'
  | 'expectedStatus'
  | 'keyword'
  | 'enabled';

const FIELD_ORDER: FieldKey[] = [
  'name',
  'url',
  'method',
  'intervalSeconds',
  'timeoutMs',
  'expectedStatus',
  'keyword',
  'enabled',
];

interface Values {
  name: string;
  url: string;
  method: HttpMethod;
  intervalSeconds: string;
  timeoutMs: string;
  expectedStatus: string;
  keyword: string;
  enabled: boolean;
}

const initialValues = (): Values => ({
  name: '',
  url: '',
  method: MONITOR_DEFAULTS.method,
  intervalSeconds: String(MONITOR_DEFAULTS.intervalSeconds),
  timeoutMs: String(MONITOR_DEFAULTS.timeoutMs),
  expectedStatus: String(MONITOR_DEFAULTS.expectedStatus),
  keyword: '',
  enabled: MONITOR_DEFAULTS.enabled,
});

type Errors = Partial<Record<FieldKey, string>>;

const isFieldKey = (k: unknown): k is FieldKey => FIELD_ORDER.includes(k as FieldKey);

/** Splits issues into per-field messages (first message wins) and form-level messages. */
function mapIssues(
  issues: ReadonlyArray<{ path: PropertyKey[] | (string | number)[]; message: string }>,
) {
  const fields: Errors = {};
  const form: string[] = [];
  for (const issue of issues) {
    const key = issue.path[0];
    if (isFieldKey(key)) fields[key] ??= issue.message;
    else form.push(issue.message);
  }
  return { fields, form };
}

const inputClass =
  'block w-full rounded-md border border-slate-400 bg-white px-3 py-2 text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600 focus-visible:ring-offset-1 aria-[invalid=true]:border-red-700';

export function AddMonitorForm({ onCreated, client = api }: AddMonitorFormProps) {
  const [values, setValues] = useState<Values>(initialValues);
  const [errors, setErrors] = useState<Errors>({});
  const [formErrors, setFormErrors] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [statusMessage, setStatusMessage] = useState('');
  const refs = useRef<Partial<Record<FieldKey, HTMLElement | null>>>({});

  const id = (f: FieldKey) => `monitor-${f}`;
  const errId = (f: FieldKey) => `monitor-${f}-error`;

  function setField<K extends FieldKey>(key: K, value: Values[K]) {
    setValues((v) => ({ ...v, [key]: value }));
    setErrors((e) => {
      if (!e[key]) return e;
      const { [key]: _removed, ...rest } = e;
      return rest;
    });
  }

  function focusFirstInvalid(fields: Errors) {
    const first = FIELD_ORDER.find((f) => fields[f]);
    if (first) refs.current[first]?.focus();
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    setStatusMessage('');
    setFormErrors([]);

    const input: MonitorCreateInput = {
      name: values.name,
      url: values.url,
      method: values.method,
      intervalSeconds: Number(values.intervalSeconds),
      timeoutMs: Number(values.timeoutMs),
      expectedStatus: Number(values.expectedStatus),
      enabled: values.enabled,
      ...(values.keyword !== '' ? { keyword: values.keyword } : {}),
    };

    const parsed = MonitorCreateSchema.safeParse(input);
    if (!parsed.success) {
      const { fields, form } = mapIssues(parsed.error.issues);
      setErrors(fields);
      setFormErrors(form);
      focusFirstInvalid(fields);
      return;
    }
    setErrors({});

    setSubmitting(true);
    try {
      const monitor = await client.createMonitor(input);
      onCreated(monitor);
      setValues(initialValues());
      setStatusMessage(`Monitor "${monitor.name}" added.`);
      refs.current.name?.focus();
    } catch (err) {
      if (err instanceof ApiClientError && err.status === 400 && err.code === 'VALIDATION_ERROR') {
        const { fields, form } = mapIssues(err.issues as ApiIssue[]);
        setErrors(fields);
        setFormErrors(form.length === 0 && Object.keys(fields).length === 0 ? [err.message] : form);
        focusFirstInvalid(fields);
      } else {
        setFormErrors([err instanceof ApiClientError ? err.message : 'Unexpected error']);
      }
    } finally {
      setSubmitting(false);
    }
  }

  const setRef = (f: FieldKey) => (el: HTMLElement | null) => {
    refs.current[f] = el;
  };
  const a11y = (f: FieldKey) => ({
    id: id(f),
    'aria-invalid': errors[f] ? (true as const) : undefined,
    'aria-describedby': errors[f] ? errId(f) : undefined,
  });
  const error = (f: FieldKey) =>
    errors[f] ? (
      <p id={errId(f)} className="mt-1 text-sm text-red-800">
        {errors[f]}
      </p>
    ) : null;
  const label = (f: FieldKey, text: string) => (
    <label htmlFor={id(f)} className="mb-1 block text-sm font-medium text-slate-900">
      {text}
    </label>
  );

  return (
    <form
      noValidate
      aria-labelledby="add-heading"
      aria-busy={submitting}
      onSubmit={handleSubmit}
      className="space-y-4 rounded-md border border-slate-300 bg-white p-4 sm:p-6"
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          {label('name', 'Name')}
          <input
            {...a11y('name')}
            ref={setRef('name')}
            type="text"
            required
            maxLength={MONITOR_LIMITS.nameMaxLength * 2}
            value={values.name}
            onChange={(e) => setField('name', e.target.value)}
            className={inputClass}
          />
          {error('name')}
        </div>
        <div>
          {label('url', 'URL')}
          <input
            {...a11y('url')}
            ref={setRef('url')}
            type="url"
            required
            placeholder="https://example.com"
            value={values.url}
            onChange={(e) => setField('url', e.target.value)}
            className={inputClass}
          />
          {error('url')}
        </div>
        <div>
          {label('method', 'Method')}
          <select
            {...a11y('method')}
            ref={setRef('method')}
            value={values.method}
            onChange={(e) => setField('method', e.target.value as HttpMethod)}
            className={inputClass}
          >
            {HTTP_METHODS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          {error('method')}
        </div>
        <div>
          {label('intervalSeconds', 'Check interval (seconds)')}
          <input
            {...a11y('intervalSeconds')}
            ref={setRef('intervalSeconds')}
            type="number"
            min={MONITOR_LIMITS.intervalSeconds.min}
            max={MONITOR_LIMITS.intervalSeconds.max}
            value={values.intervalSeconds}
            onChange={(e) => setField('intervalSeconds', e.target.value)}
            className={inputClass}
          />
          {error('intervalSeconds')}
        </div>
        <div>
          {label('timeoutMs', 'Timeout (ms)')}
          <input
            {...a11y('timeoutMs')}
            ref={setRef('timeoutMs')}
            type="number"
            min={MONITOR_LIMITS.timeoutMs.min}
            max={MONITOR_LIMITS.timeoutMs.max}
            value={values.timeoutMs}
            onChange={(e) => setField('timeoutMs', e.target.value)}
            className={inputClass}
          />
          {error('timeoutMs')}
        </div>
        <div>
          {label('expectedStatus', 'Expected status')}
          <input
            {...a11y('expectedStatus')}
            ref={setRef('expectedStatus')}
            type="number"
            min={MONITOR_LIMITS.expectedStatus.min}
            max={MONITOR_LIMITS.expectedStatus.max}
            value={values.expectedStatus}
            onChange={(e) => setField('expectedStatus', e.target.value)}
            className={inputClass}
          />
          {error('expectedStatus')}
        </div>
        <div className="sm:col-span-2">
          {label('keyword', 'Keyword (optional)')}
          <input
            {...a11y('keyword')}
            ref={setRef('keyword')}
            type="text"
            value={values.keyword}
            onChange={(e) => setField('keyword', e.target.value)}
            className={inputClass}
          />
          {error('keyword')}
        </div>
      </div>

      <div>
        <div className="flex items-center gap-2">
          <input
            {...a11y('enabled')}
            ref={setRef('enabled')}
            type="checkbox"
            checked={values.enabled}
            onChange={(e) => setField('enabled', e.target.checked)}
            className="size-4 rounded border-slate-400 text-indigo-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600 focus-visible:ring-offset-1"
          />
          <label htmlFor={id('enabled')} className="text-sm font-medium text-slate-900">
            Enabled
          </label>
        </div>
        {error('enabled')}
      </div>

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

      <button
        type="submit"
        disabled={submitting}
        className="w-full rounded-md bg-indigo-700 px-4 py-2 font-medium text-white hover:bg-indigo-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:bg-slate-500 sm:w-auto"
      >
        {submitting ? 'Adding…' : 'Add monitor'}
      </button>

      <div role="status" aria-live="polite" className="text-sm font-medium text-green-900">
        {statusMessage}
      </div>
    </form>
  );
}
