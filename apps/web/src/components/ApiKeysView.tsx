import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { api, ApiClientError, type ApiClient } from '../api/client';
import type { ApiKey, ApiKeyCreated, ApiKeyScope } from '../api/types';

type State =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; keys: ApiKey[] };

const NAME_MAX = 100;
const messageOf = (err: unknown) =>
  err instanceof ApiClientError ? err.message : 'Unexpected error';

const btn =
  'rounded-md border border-slate-400 bg-white px-2.5 py-1 text-sm font-medium text-slate-900 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:text-slate-600';
const dangerBtn =
  'rounded-md bg-red-700 px-2.5 py-1 text-sm font-medium text-white hover:bg-red-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-700 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:bg-slate-500';
const primaryBtn =
  'rounded-md bg-indigo-700 px-4 py-2 font-medium text-white hover:bg-indigo-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:bg-slate-500';
const inputClass =
  'block w-full rounded-md border border-slate-400 bg-white px-3 py-2 text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600 focus-visible:ring-offset-1 aria-[invalid=true]:border-red-700';

export function formatRelative(iso: string, now = Date.now()): string {
  const diff = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 1000));
  if (diff < 60) return 'just now';
  const units: [number, string][] = [
    [86400, 'day'],
    [3600, 'hour'],
    [60, 'minute'],
  ];
  for (const [secs, label] of units) {
    if (diff >= secs) {
      const n = Math.floor(diff / secs);
      return `${n} ${label}${n === 1 ? '' : 's'} ago`;
    }
  }
  return 'just now';
}

const SCOPE_LABEL: Record<ApiKeyScope, string> = { read: 'Read only', write: 'Read & write' };

function NewKeyPanel({ created, onDone }: { created: ApiKeyCreated; onDone: () => void }) {
  const [copy, setCopy] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  async function onCopy() {
    clearTimeout(timer.current);
    try {
      await navigator.clipboard.writeText(created.key);
      setCopy('copied');
      timer.current = setTimeout(() => setCopy('idle'), 2000);
    } catch {
      setCopy('failed');
    }
  }

  return (
    <section
      role="region"
      aria-label="New API key"
      className="space-y-3 rounded-md border border-amber-400 bg-amber-50 p-4 text-amber-950"
    >
      <p>Copy this key now. You won't be able to see it again.</p>
      <label htmlFor="new-api-key" className="sr-only">
        New API key
      </label>
      <input
        id="new-api-key"
        readOnly
        value={created.key}
        onFocus={(e) => e.currentTarget.select()}
        className={`${inputClass} font-mono text-sm`}
      />
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={() => void onCopy()} className={btn}>
          {copy === 'copied' ? 'Copied' : 'Copy'}
        </button>
        <button type="button" onClick={onDone} className={btn}>
          Done
        </button>
        <span role="status" aria-live="polite" className="text-sm">
          {copy === 'failed' ? 'Copy failed — select and copy manually' : ''}
        </span>
      </div>
    </section>
  );
}

export function ApiKeysView({ client = api }: { client?: ApiClient }) {
  const [state, setState] = useState<State>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [name, setName] = useState('');
  const [scope, setScope] = useState<ApiKeyScope>('read');
  const [creating, setCreating] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [created, setCreated] = useState<ApiKeyCreated | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [revokeError, setRevokeError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: 'loading' });
    client
      .listApiKeys(controller.signal)
      .then((keys) => setState({ status: 'ready', keys }))
      .catch((err: unknown) => {
        if (!controller.signal.aborted) setState({ status: 'error', message: messageOf(err) });
      });
    return () => controller.abort();
  }, [client, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    if (creating) return;
    const trimmed = name.trim();
    setNameError(null);
    setFormError(null);
    if (trimmed.length === 0) {
      setNameError('Name is required');
      return;
    }
    if (trimmed.length > NAME_MAX) {
      setNameError(`Name must be at most ${NAME_MAX} characters`);
      return;
    }
    setCreating(true);
    try {
      const key = await client.createApiKey({ name: trimmed, scope });
      const { key: _secret, ...row } = key;
      void _secret;
      setCreated(key);
      setState((s) => (s.status === 'ready' ? { ...s, keys: [row, ...s.keys] } : s));
      setName('');
      setScope('read');
    } catch (err) {
      const nameIssue =
        err instanceof ApiClientError && err.status === 400
          ? err.issues.find((i) => i.path[0] === 'name')
          : undefined;
      if (nameIssue) setNameError(nameIssue.message);
      else setFormError(`Couldn't create key: ${messageOf(err)}`);
    } finally {
      setCreating(false);
    }
  }

  async function onRevoke(k: ApiKey) {
    setRevokingId(k.id);
    setRevokeError(null);
    try {
      await client.revokeApiKey(k.id);
      setState((s) =>
        s.status === 'ready' ? { ...s, keys: s.keys.filter((x) => x.id !== k.id) } : s,
      );
      setConfirmId(null);
    } catch (err) {
      setRevokeError(`Couldn't revoke "${k.name}": ${messageOf(err)}`);
    } finally {
      setRevokingId(null);
    }
  }

  let body;
  if (state.status === 'loading') {
    body = (
      <p role="status" className="text-slate-700">
        Loading API keys…
      </p>
    );
  } else if (state.status === 'error') {
    body = (
      <div role="alert" className="rounded-md border border-red-300 bg-red-50 p-4 text-red-900">
        <p>Couldn't load API keys: {state.message}</p>
        <button type="button" onClick={retry} className={`mt-3 ${dangerBtn}`}>
          Retry
        </button>
      </div>
    );
  } else if (state.keys.length === 0) {
    body = <p className="text-slate-700">No API keys yet.</p>;
  } else {
    body = (
      <div className="overflow-x-auto rounded-md border border-slate-300 bg-white">
        <table className="w-full min-w-[44rem] text-left text-sm">
          <caption className="sr-only">API keys</caption>
          <thead className="bg-slate-100 text-slate-800">
            <tr>
              {['Name', 'Scope', 'Key', 'Created', 'Last used', 'Actions'].map((h) => (
                <th key={h} scope="col" className="px-3 py-2 font-semibold">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-200">
            {state.keys.map((k) => (
              <tr key={k.id} className="align-top">
                <td className="px-3 py-2 font-medium">{k.name}</td>
                <td className="px-3 py-2">{SCOPE_LABEL[k.scope]}</td>
                <td className="px-3 py-2 font-mono">{k.prefix}…</td>
                <td className="px-3 py-2">{formatRelative(k.createdAt)}</td>
                <td className="px-3 py-2">
                  {k.lastUsedAt ? formatRelative(k.lastUsedAt) : 'Never'}
                </td>
                <td className="px-3 py-2">
                  {confirmId === k.id ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <span>Revoke {k.name}? Apps using it will stop working.</span>
                      <button
                        type="button"
                        disabled={revokingId === k.id}
                        onClick={() => void onRevoke(k)}
                        className={dangerBtn}
                      >
                        {revokingId === k.id ? 'Revoking…' : 'Revoke key'}
                      </button>
                      <button
                        type="button"
                        disabled={revokingId === k.id}
                        onClick={() => setConfirmId(null)}
                        className={btn}
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      aria-label={`Revoke ${k.name}`}
                      onClick={() => {
                        setRevokeError(null);
                        setConfirmId(k.id);
                      }}
                      className={btn}
                    >
                      Revoke
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <section aria-labelledby="api-keys-heading" className="space-y-6">
      <h2 id="api-keys-heading" className="text-xl font-semibold">
        API keys
      </h2>
      {created && <NewKeyPanel created={created} onDone={() => setCreated(null)} />}
      {revokeError && (
        <div role="alert" className="rounded-md border border-red-300 bg-red-50 p-3 text-red-900">
          {revokeError}
        </div>
      )}
      {body}
      <form onSubmit={(e) => void onCreate(e)} className="max-w-md space-y-4" noValidate>
        <h3 className="text-lg font-semibold">Create API key</h3>
        {formError && (
          <div role="alert" className="rounded-md border border-red-300 bg-red-50 p-3 text-red-900">
            {formError}
          </div>
        )}
        <div>
          <label htmlFor="api-key-name" className="mb-1 block text-sm font-medium">
            Name
          </label>
          <input
            id="api-key-name"
            required
            maxLength={NAME_MAX}
            disabled={creating}
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setNameError(null);
            }}
            aria-invalid={nameError ? true : undefined}
            aria-describedby={nameError ? 'api-key-name-error' : undefined}
            className={inputClass}
          />
          {nameError && (
            <p id="api-key-name-error" className="mt-1 text-sm text-red-800">
              {nameError}
            </p>
          )}
        </div>
        <fieldset disabled={creating}>
          <legend className="mb-1 text-sm font-medium">Scope</legend>
          <div className="space-y-1">
            {(['read', 'write'] as const).map((s) => (
              <label key={s} className="flex items-center gap-2">
                <input
                  type="radio"
                  name="api-key-scope"
                  value={s}
                  checked={scope === s}
                  onChange={() => setScope(s)}
                  className="size-4 text-indigo-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600 focus-visible:ring-offset-1"
                />
                {SCOPE_LABEL[s]}
              </label>
            ))}
          </div>
        </fieldset>
        <button type="submit" disabled={creating} className={primaryBtn}>
          {creating ? 'Creating…' : 'Create key'}
        </button>
      </form>
    </section>
  );
}
