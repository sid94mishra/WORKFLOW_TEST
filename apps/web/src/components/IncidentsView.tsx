import { useCallback, useEffect, useState } from 'react';
import { api, ApiClientError, type ApiClient } from '../api/client';
import { formatDuration } from '../api/contract';
import type { Incident } from '../api/types';

type State =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; incidents: Incident[] };

export interface IncidentsViewProps {
  client?: ApiClient;
  now?: () => Date;
}

function IncidentRow({ incident, now }: { incident: Incident; now: Date }) {
  const open = incident.status === 'open';
  const duration = open
    ? `Ongoing · ${formatDuration((now.getTime() - Date.parse(incident.startedAt)) / 1000)}`
    : `Lasted ${formatDuration(incident.durationSeconds ?? 0)}`;
  return (
    <li className="space-y-1 p-3 sm:p-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <a
          href={`#/monitors/${encodeURIComponent(incident.monitorId)}`}
          className="font-medium text-blue-800 underline hover:text-blue-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-700 focus-visible:ring-offset-2"
        >
          {incident.monitorName}
        </a>
        <span
          className={`rounded-full px-2 py-0.5 text-xs font-medium ${
            open ? 'bg-red-100 text-red-900' : 'bg-green-100 text-green-900'
          }`}
        >
          {open ? 'Open' : 'Resolved'}
        </span>
        <span className="text-sm text-slate-700">{duration}</span>
      </div>
      <p className="text-sm text-slate-700">
        Started <time dateTime={incident.startedAt}>{incident.startedAt}</time>
      </p>
      <p className="break-words text-sm text-slate-700">Cause: {incident.cause ?? '—'}</p>
    </li>
  );
}

function Group({ title, incidents, now }: { title: string; incidents: Incident[]; now: Date }) {
  const headingId = `incidents-${title.toLowerCase()}`;
  return (
    <section aria-labelledby={headingId} className="space-y-2">
      <h3 id={headingId} className="text-lg font-semibold">
        {title}
      </h3>
      <ul className="divide-y divide-slate-200 rounded-md border border-slate-300 bg-white">
        {incidents.map((i) => (
          <IncidentRow key={i.id} incident={i} now={now} />
        ))}
      </ul>
    </section>
  );
}

export function IncidentsView({ client = api, now = () => new Date() }: IncidentsViewProps) {
  const [state, setState] = useState<State>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: 'loading' });
    client
      .listIncidents({ status: 'all', limit: 200 }, controller.signal)
      .then((incidents) => setState({ status: 'ready', incidents }))
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setState({
          status: 'error',
          message: err instanceof ApiClientError ? err.message : 'Unexpected error',
        });
      });
    return () => controller.abort();
  }, [client, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  let body;
  if (state.status === 'loading') {
    body = (
      <p role="status" className="text-slate-700">
        Loading incidents…
      </p>
    );
  } else if (state.status === 'error') {
    body = (
      <div role="alert" className="rounded-md border border-red-300 bg-red-50 p-4 text-red-900">
        <p>Couldn't load incidents: {state.message}</p>
        <button
          type="button"
          onClick={retry}
          className="mt-3 rounded-md bg-red-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-700 focus-visible:ring-offset-2"
        >
          Retry
        </button>
      </div>
    );
  } else if (state.incidents.length === 0) {
    body = (
      <p className="text-slate-700">No incidents yet. Incidents open when a monitor goes down.</p>
    );
  } else {
    const current = now();
    const open = state.incidents.filter((i) => i.status === 'open');
    const resolved = state.incidents.filter((i) => i.status === 'resolved');
    body = (
      <div className="space-y-6">
        {open.length > 0 && <Group title="Open" incidents={open} now={current} />}
        {resolved.length > 0 && <Group title="Resolved" incidents={resolved} now={current} />}
      </div>
    );
  }

  return (
    <section aria-labelledby="incidents-heading" className="space-y-4">
      <h2 id="incidents-heading" className="text-xl font-semibold">
        Incidents
      </h2>
      {body}
    </section>
  );
}
