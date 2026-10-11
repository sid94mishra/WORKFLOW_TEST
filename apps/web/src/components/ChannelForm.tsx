import { useRef, useState, type FormEvent } from 'react';
import { api, ApiClientError, type ApiClient } from '../api/client';
import { CHANNEL_KINDS, validateChannelFields } from '../api/contract';
import type { Channel, ChannelKind, ChannelUpdate, Monitor } from '../api/types';

export interface ChannelFormProps {
  channel?: Channel;
  monitors: Monitor[];
  onSaved: (c: Channel) => void;
  onCancel: () => void;
  client?: ApiClient;
}

type FieldKey = 'name' | 'kind' | 'url' | 'enabled' | 'monitorIds';
const FIELD_ORDER: FieldKey[] = ['name', 'kind', 'url', 'enabled', 'monitorIds'];
type Errors = Partial<Record<FieldKey, string>>;

const KIND_LABEL: Record<ChannelKind, string> = { webhook: 'Webhook', slack: 'Slack' };

const inputClass =
  'block w-full rounded-md border border-slate-400 bg-white px-3 py-2 text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600 focus-visible:ring-offset-1 aria-[invalid=true]:border-red-700';
const checkboxClass =
  'size-4 rounded border-slate-400 text-indigo-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600 focus-visible:ring-offset-1';

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

const sameSet = (a: string[], b: string[]) =>
  a.length === b.length && a.every((x) => b.includes(x));

export function ChannelForm({
  channel,
  monitors,
  onSaved,
  onCancel,
  client = api,
}: ChannelFormProps) {
  const [name, setName] = useState(channel?.name ?? '');
  const [kind, setKind] = useState<ChannelKind>(channel?.kind ?? 'webhook');
  const [url, setUrl] = useState(channel?.url ?? '');
  const [enabled, setEnabled] = useState(channel?.enabled ?? true);
  const [monitorIds, setMonitorIds] = useState<string[]>(channel?.monitorIds ?? []);
  const [errors, setErrors] = useState<Errors>({});
  const [formErrors, setFormErrors] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const refs = useRef<Partial<Record<FieldKey, HTMLElement | null>>>({});

  const id = (f: FieldKey) => `channel-${f}`;
  const errId = (f: FieldKey) => `channel-${f}-error`;
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
    refs.current[f] = el;
  };
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

  function showErrors(fields: Errors, form: string[]) {
    setErrors(fields);
    setFormErrors(form);
    FIELD_ORDER.find((f) => fields[f]) &&
      refs.current[FIELD_ORDER.find((f) => fields[f])!]?.focus();
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    setFormErrors([]);

    const issues = validateChannelFields({ name, url });
    if (issues.length > 0) {
      const { fields, form } = mapIssues(issues);
      showErrors(fields, form);
      return;
    }
    setErrors({});

    setSaving(true);
    try {
      let saved: Channel;
      if (channel) {
        const patch: ChannelUpdate = {};
        if (name.trim() !== channel.name) patch.name = name.trim();
        if (kind !== channel.kind) patch.kind = kind;
        if (url !== channel.url) patch.url = url;
        if (enabled !== channel.enabled) patch.enabled = enabled;
        if (!sameSet(monitorIds, channel.monitorIds)) patch.monitorIds = monitorIds;
        if (Object.keys(patch).length === 0) {
          onCancel();
          return;
        }
        saved = await client.updateChannel(channel.id, patch);
      } else {
        saved = await client.createChannel({ name: name.trim(), kind, url, enabled, monitorIds });
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

  return (
    <form
      noValidate
      aria-label={channel ? `Edit channel ${channel.name}` : 'Add channel'}
      aria-busy={saving}
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
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              clear('name');
            }}
            className={inputClass}
          />
          {error('name')}
        </div>
        <div>
          {label('kind', 'Type')}
          <select
            {...a11y('kind')}
            ref={setRef('kind')}
            value={kind}
            onChange={(e) => {
              setKind(e.target.value as ChannelKind);
              clear('kind');
            }}
            className={inputClass}
          >
            {CHANNEL_KINDS.map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k]}
              </option>
            ))}
          </select>
          {error('kind')}
        </div>
        <div className="sm:col-span-2">
          {label('url', 'Webhook URL')}
          <input
            {...a11y('url')}
            ref={setRef('url')}
            type="url"
            required
            placeholder="https://hooks.example.com/…"
            value={url}
            onChange={(e) => {
              setUrl(e.target.value);
              clear('url');
            }}
            className={inputClass}
          />
          {error('url')}
        </div>
      </div>

      <div className="flex items-center gap-2">
        <input
          {...a11y('enabled')}
          ref={setRef('enabled')}
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
          className={checkboxClass}
        />
        <label htmlFor={id('enabled')} className="text-sm font-medium text-slate-900">
          Enabled
        </label>
      </div>

      <fieldset
        aria-describedby={errors.monitorIds ? errId('monitorIds') : undefined}
        className="space-y-2"
      >
        <legend className="mb-1 text-sm font-medium text-slate-900">
          Notify for these monitors
        </legend>
        {monitors.length === 0 ? (
          <p className="text-sm text-slate-700">No monitors yet.</p>
        ) : (
          monitors.map((m) => (
            <div key={m.id} className="flex items-center gap-2">
              <input
                id={`channel-monitor-${m.id}`}
                type="checkbox"
                checked={monitorIds.includes(m.id)}
                onChange={(e) =>
                  setMonitorIds((ids) =>
                    e.target.checked ? [...ids, m.id] : ids.filter((x) => x !== m.id),
                  )
                }
                className={checkboxClass}
              />
              <label htmlFor={`channel-monitor-${m.id}`} className="text-sm text-slate-900">
                {m.name}
              </label>
            </div>
          ))
        )}
        {error('monitorIds')}
      </fieldset>

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
          disabled={saving}
          className="rounded-md bg-indigo-700 px-4 py-2 font-medium text-white hover:bg-indigo-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:bg-slate-500"
        >
          {saving ? 'Saving…' : channel ? 'Save changes' : 'Add channel'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border border-slate-400 bg-white px-4 py-2 font-medium text-slate-900 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600 focus-visible:ring-offset-2"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
