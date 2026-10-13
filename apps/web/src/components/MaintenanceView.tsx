import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiClientError, type ApiClient } from '../api/client';
import type { MaintenanceWindow, Monitor } from '../api/types';
import { MaintenanceDialog } from './MaintenanceDialog';

type State =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; windows: MaintenanceWindow[]; monitors: Monitor[] };

type Editing = { kind: 'none' } | { kind: 'new' } | { kind: 'edit'; id: string };

const messageOf = (err: unknown) =>
  err instanceof ApiClientError ? err.message : 'Unexpected error';

const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** `2026-10-20T01:00:00.000Z` → `2026-10-20 01:00` (UTC). */
const utc = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;

function formatMinutes(total: number): string {
  const h = Math.floor(total / 60);
  const m = total % 60;
  return [h > 0 ? `${h} h` : '', m > 0 ? `${m} min` : ''].filter(Boolean).join(' ');
}

export function describeSchedule(w: MaintenanceWindow): string {
  if (!w.repeat) return `${utc(w.startsAt)} – ${utc(w.endsAt)} UTC`;
  const days = w.repeat.weekdays.map((d) => WEEKDAY_NAMES[d]).join(', ');
  return `${days} ${w.repeat.startTime} UTC for ${formatMinutes(w.repeat.durationMinutes)} · until ${w.endsAt.slice(0, 10)}`;
}

const btn =
  'rounded-md border border-slate-400 bg-white px-2.5 py-1 text-sm font-medium text-slate-900 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:text-slate-600';
const dangerBtn =
  'rounded-md bg-red-700 px-2.5 py-1 text-sm font-medium text-white hover:bg-red-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-700 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:bg-slate-500';

export function MaintenanceView({ client = api }: { client?: ApiClient }) {
  const [state, setState] = useState<State>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [editing, setEditing] = useState<Editing>({ kind: 'none' });
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  const scheduleRef = useRef<HTMLButtonElement | null>(null);
  const deleteRefs = useRef(new Map<string, HTMLButtonElement>());
  const restoreFocusId = useRef<string | null>(null);

  // The inline confirm swaps the Delete button out, so move focus explicitly: to the confirm
  // button when it opens (and again after a failed delete), back to Delete on Cancel, or to
  // Schedule maintenance once the row is gone.
  useEffect(() => {
    if (deletingId) return;
    if (confirmId) confirmRef.current?.focus();
    else if (restoreFocusId.current) {
      (deleteRefs.current.get(restoreFocusId.current) ?? scheduleRef.current)?.focus();
      restoreFocusId.current = null;
    }
  }, [confirmId, deletingId]);

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: 'loading' });
    Promise.all([client.listMaintenance(controller.signal), client.listMonitors(controller.signal)])
      .then(([windows, monitors]) => setState({ status: 'ready', windows, monitors }))
      .catch((err: unknown) => {
        if (!controller.signal.aborted) setState({ status: 'error', message: messageOf(err) });
      });
    return () => controller.abort();
  }, [client, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  async function confirmDelete(w: MaintenanceWindow) {
    setDeletingId(w.id);
    setDeleteError(null);
    try {
      await client.deleteMaintenance(w.id);
      setState((s) =>
        s.status === 'ready' ? { ...s, windows: s.windows.filter((x) => x.id !== w.id) } : s,
      );
      setConfirmId(null);
    } catch (err) {
      setDeleteError(`Couldn't delete "${w.title}": ${messageOf(err)}`);
    } finally {
      setDeletingId(null);
    }
  }

  function onSaved(saved: MaintenanceWindow) {
    setState((s) => {
      if (s.status !== 'ready') return s;
      const exists = s.windows.some((w) => w.id === saved.id);
      return {
        ...s,
        windows: exists
          ? s.windows.map((w) => (w.id === saved.id ? saved : w))
          : [saved, ...s.windows],
      };
    });
    setEditing({ kind: 'none' });
  }

  let body;
  if (state.status === 'loading') {
    body = (
      <p role="status" className="text-slate-700">
        Loading maintenance…
      </p>
    );
  } else if (state.status === 'error') {
    body = (
      <div role="alert" className="rounded-md border border-red-300 bg-red-50 p-4 text-red-900">
        <p>Couldn't load maintenance: {state.message}</p>
        <button type="button" onClick={retry} className={`mt-3 ${dangerBtn}`}>
          Retry
        </button>
      </div>
    );
  } else {
    const { windows, monitors } = state;
    const names = new Map(monitors.map((m) => [m.id, m.name]));
    const monitorsText = (w: MaintenanceWindow) =>
      w.monitorIds === 'all'
        ? 'All monitors'
        : w.monitorIds.map((id) => names.get(id) ?? 'Unknown monitor').join(', ');
    const editingWindow =
      editing.kind === 'edit' ? windows.find((w) => w.id === editing.id) : undefined;

    body = (
      <div className="space-y-4">
        <button
          type="button"
          ref={scheduleRef}
          onClick={() => setEditing({ kind: 'new' })}
          className={btn}
        >
          Schedule maintenance
        </button>
        {deleteError && (
          <div role="alert" className="rounded-md border border-red-300 bg-red-50 p-3 text-red-900">
            {deleteError}
          </div>
        )}
        {windows.length === 0 ? (
          <p className="text-slate-700">No maintenance windows yet.</p>
        ) : (
          <div className="overflow-x-auto rounded-md border border-slate-300 bg-white">
            <table className="w-full min-w-[48rem] text-left text-sm">
              <caption className="sr-only">Maintenance windows</caption>
              <thead className="bg-slate-100 text-slate-800">
                <tr>
                  {['Title', 'Monitors', 'Schedule', 'Status', 'Actions'].map((h) => (
                    <th key={h} scope="col" className="px-3 py-2 font-semibold">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {windows.map((w) => (
                  <tr key={w.id} className="align-top">
                    <td className="break-words px-3 py-2 font-medium">{w.title}</td>
                    <td className="px-3 py-2">{monitorsText(w)}</td>
                    <td className="px-3 py-2">{describeSchedule(w)}</td>
                    <td className="px-3 py-2">
                      {w.active ? (
                        <span className="rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-900">
                          Active
                        </span>
                      ) : w.nextOccurrence ? (
                        `Next: ${utc(w.nextOccurrence.startsAt)} UTC`
                      ) : (
                        'Ended'
                      )}
                    </td>
                    <td className="px-3 py-2">
                      {confirmId === w.id ? (
                        <div className="flex flex-wrap items-center gap-2">
                          <span>Delete {w.title}? Alerts for its monitors resume immediately.</span>
                          <button
                            type="button"
                            ref={confirmRef}
                            disabled={deletingId === w.id}
                            onClick={() => void confirmDelete(w)}
                            className={dangerBtn}
                          >
                            {deletingId === w.id ? 'Deleting…' : 'Delete window'}
                          </button>
                          <button
                            type="button"
                            disabled={deletingId === w.id}
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
                            aria-label={`Edit ${w.title}`}
                            onClick={() => setEditing({ kind: 'edit', id: w.id })}
                            className={btn}
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            ref={(el) => {
                              if (el) deleteRefs.current.set(w.id, el);
                              else deleteRefs.current.delete(w.id);
                            }}
                            aria-label={`Delete ${w.title}`}
                            onClick={() => {
                              setDeleteError(null);
                              restoreFocusId.current = w.id;
                              setConfirmId(w.id);
                            }}
                            className={btn}
                          >
                            Delete
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {editing.kind === 'new' && (
          <MaintenanceDialog
            key="new"
            monitors={monitors}
            client={client}
            onSaved={onSaved}
            onClose={() => setEditing({ kind: 'none' })}
          />
        )}
        {editingWindow && (
          <MaintenanceDialog
            key={editingWindow.id}
            item={editingWindow}
            monitors={monitors}
            client={client}
            onSaved={onSaved}
            onClose={() => setEditing({ kind: 'none' })}
          />
        )}
      </div>
    );
  }

  return (
    <section aria-labelledby="maintenance-heading" className="space-y-4">
      <h2 id="maintenance-heading" className="text-xl font-semibold">
        Maintenance
      </h2>
      {body}
    </section>
  );
}
