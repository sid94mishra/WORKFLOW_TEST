import { useCallback, useEffect, useState } from 'react';
import { api, ApiClientError, type ApiClient } from '../api/client';
import type { Channel, Monitor } from '../api/types';
import { ChannelForm } from './ChannelForm';

type State =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; channels: Channel[]; monitors: Monitor[] };

type TestResult = { status: 'sending' } | { status: 'done'; message: string };
type Editing = { kind: 'none' } | { kind: 'new' } | { kind: 'edit'; id: string };

const messageOf = (err: unknown) =>
  err instanceof ApiClientError ? err.message : 'Unexpected error';

export function maskUrl(url: string): string {
  try {
    return `${new URL(url).origin}/…`;
  } catch {
    return '—';
  }
}

const btn =
  'rounded-md border border-slate-400 bg-white px-2.5 py-1 text-sm font-medium text-slate-900 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:text-slate-600';
const dangerBtn =
  'rounded-md bg-red-700 px-2.5 py-1 text-sm font-medium text-white hover:bg-red-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-700 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:bg-slate-500';

export function ChannelsView({ client = api }: { client?: ApiClient }) {
  const [state, setState] = useState<State>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [editing, setEditing] = useState<Editing>({ kind: 'none' });
  const [tests, setTests] = useState<Record<string, TestResult>>({});
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: 'loading' });
    Promise.all([client.listChannels(controller.signal), client.listMonitors(controller.signal)])
      .then(([channels, monitors]) => setState({ status: 'ready', channels, monitors }))
      .catch((err: unknown) => {
        if (!controller.signal.aborted) setState({ status: 'error', message: messageOf(err) });
      });
    return () => controller.abort();
  }, [client, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  async function sendTest(c: Channel) {
    setTests((t) => ({ ...t, [c.id]: { status: 'sending' } }));
    let message: string;
    try {
      const result = await client.testChannel(c.id);
      message = result.ok
        ? `Delivered (HTTP ${result.statusCode ?? '—'})`
        : `Failed: ${result.error ?? 'unknown error'}`;
    } catch (err) {
      message = `Failed: ${messageOf(err)}`;
    }
    setTests((t) => ({ ...t, [c.id]: { status: 'done', message } }));
  }

  async function confirmDelete(c: Channel) {
    setDeletingId(c.id);
    setDeleteError(null);
    try {
      await client.deleteChannel(c.id);
      setState((s) =>
        s.status === 'ready' ? { ...s, channels: s.channels.filter((x) => x.id !== c.id) } : s,
      );
      setConfirmId(null);
    } catch (err) {
      setDeleteError(`Couldn't delete "${c.name}": ${messageOf(err)}`);
    } finally {
      setDeletingId(null);
    }
  }

  function onSaved(saved: Channel) {
    setState((s) => {
      if (s.status !== 'ready') return s;
      const exists = s.channels.some((c) => c.id === saved.id);
      return {
        ...s,
        channels: exists
          ? s.channels.map((c) => (c.id === saved.id ? saved : c))
          : [...s.channels, saved],
      };
    });
    setEditing({ kind: 'none' });
  }

  let body;
  if (state.status === 'loading') {
    body = (
      <p role="status" className="text-slate-700">
        Loading channels…
      </p>
    );
  } else if (state.status === 'error') {
    body = (
      <div role="alert" className="rounded-md border border-red-300 bg-red-50 p-4 text-red-900">
        <p>Couldn't load channels: {state.message}</p>
        <button type="button" onClick={retry} className={`mt-3 ${dangerBtn}`}>
          Retry
        </button>
      </div>
    );
  } else {
    const { channels, monitors } = state;
    const editingChannel =
      editing.kind === 'edit' ? channels.find((c) => c.id === editing.id) : undefined;
    body = (
      <div className="space-y-4">
        {deleteError && (
          <div role="alert" className="rounded-md border border-red-300 bg-red-50 p-3 text-red-900">
            {deleteError}
          </div>
        )}
        {channels.length === 0 ? (
          <p className="text-slate-700">
            No channels yet. Add a webhook or Slack channel to get notified about incidents.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-md border border-slate-300 bg-white">
            <table className="w-full min-w-[44rem] text-left text-sm">
              <caption className="sr-only">Notification channels</caption>
              <thead className="bg-slate-100 text-slate-800">
                <tr>
                  {['Name', 'Type', 'URL', 'State', 'Monitors', 'Actions'].map((h) => (
                    <th key={h} scope="col" className="px-3 py-2 font-semibold">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {channels.map((c) => {
                  const test = tests[c.id];
                  return (
                    <tr key={c.id} className="align-top">
                      <td className="px-3 py-2 font-medium">{c.name}</td>
                      <td className="px-3 py-2">{c.kind === 'slack' ? 'Slack' : 'Webhook'}</td>
                      <td className="break-all px-3 py-2">{maskUrl(c.url)}</td>
                      <td className="px-3 py-2">{c.enabled ? 'Enabled' : 'Disabled'}</td>
                      <td className="px-3 py-2">{c.monitorIds.length}</td>
                      <td className="space-y-2 px-3 py-2">
                        {confirmId === c.id ? (
                          <div className="flex flex-wrap items-center gap-2">
                            <span>Delete "{c.name}"?</span>
                            <button
                              type="button"
                              disabled={deletingId === c.id}
                              onClick={() => void confirmDelete(c)}
                              className={dangerBtn}
                            >
                              Delete
                            </button>
                            <button
                              type="button"
                              disabled={deletingId === c.id}
                              onClick={() => setConfirmId(null)}
                              className={btn}
                            >
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <div className="flex flex-wrap gap-2">
                            <button
                              type="button"
                              disabled={test?.status === 'sending'}
                              onClick={() => void sendTest(c)}
                              className={btn}
                            >
                              {test?.status === 'sending' ? 'Sending…' : 'Send test'}
                            </button>
                            <button
                              type="button"
                              onClick={() => setEditing({ kind: 'edit', id: c.id })}
                              className={btn}
                            >
                              Edit
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setDeleteError(null);
                                setConfirmId(c.id);
                              }}
                              className={btn}
                            >
                              Delete
                            </button>
                          </div>
                        )}
                        <div role="status" aria-live="polite" className="text-sm text-slate-800">
                          {test?.status === 'done' ? test.message : ''}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {editing.kind === 'new' && (
          <ChannelForm
            key="new"
            monitors={monitors}
            client={client}
            onSaved={onSaved}
            onCancel={() => setEditing({ kind: 'none' })}
          />
        )}
        {editingChannel && (
          <ChannelForm
            key={editingChannel.id}
            channel={editingChannel}
            monitors={monitors}
            client={client}
            onSaved={onSaved}
            onCancel={() => setEditing({ kind: 'none' })}
          />
        )}
        {editing.kind === 'none' && (
          <button type="button" onClick={() => setEditing({ kind: 'new' })} className={btn}>
            Add channel
          </button>
        )}
      </div>
    );
  }

  return (
    <section aria-labelledby="channels-heading" className="space-y-4">
      <h2 id="channels-heading" className="text-xl font-semibold">
        Channels
      </h2>
      {body}
    </section>
  );
}
