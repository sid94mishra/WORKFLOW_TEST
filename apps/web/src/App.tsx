import { useCallback, useEffect, useState } from 'react';
import type { Monitor } from './api/types';
import { api, ApiClientError, type ApiClient } from './api/client';
import { AddMonitorForm } from './components/AddMonitorForm';
import { ChannelsView } from './components/ChannelsView';
import { IncidentsView } from './components/IncidentsView';
import { MonitorDetail } from './components/MonitorDetail';
import { useHashRoute } from './hooks/useHashRoute';
import { MonitorList, type MonitorListState } from './components/MonitorList';

const NAV: {
  label: string;
  href: string;
  current?: (route: string) => boolean;
  external?: boolean;
}[] = [
  { label: 'Monitors', href: '#/', current: (r) => r === 'dashboard' || r === 'monitor' },
  { label: 'Incidents', href: '#/incidents', current: (r) => r === 'incidents' },
  { label: 'Channels', href: '#/channels', current: (r) => r === 'channels' },
  { label: 'Status page', href: '/status', external: true },
];

export function App({ client = api }: { client?: ApiClient }) {
  const [state, setState] = useState<MonitorListState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const route = useHashRoute();

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: 'loading' });
    client
      .listMonitors(controller.signal)
      .then((monitors) => setState({ status: 'ready', monitors }))
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

  const onCreated = useCallback((monitor: Monitor) => {
    setState((s) =>
      s.status === 'ready' ? { status: 'ready', monitors: [...s.monitors, monitor] } : s,
    );
  }, []);

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <header className="border-b border-slate-300 bg-white">
        <div className="mx-auto max-w-5xl px-4 py-4">
          <h1 className="text-2xl font-bold">Pulse</h1>
          <nav aria-label="Main" className="mt-3">
            <ul className="flex flex-wrap gap-x-5 gap-y-2 text-sm font-medium">
              {NAV.map((item) => (
                <li key={item.label}>
                  <a
                    href={item.href}
                    aria-current={item.current?.(route.name) ? 'page' : undefined}
                    {...(item.external ? { target: '_blank', rel: 'noopener' } : {})}
                    className="rounded text-blue-800 underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-700 focus-visible:ring-offset-2 aria-[current=page]:font-bold aria-[current=page]:text-slate-900 aria-[current=page]:underline"
                  >
                    {item.label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-5xl space-y-10 px-4 py-8">
        {route.name === 'monitor' ? (
          <MonitorDetail id={route.id} client={client} />
        ) : route.name === 'incidents' ? (
          <IncidentsView client={client} />
        ) : route.name === 'channels' ? (
          <ChannelsView client={client} />
        ) : (
          <>
            <section aria-labelledby="monitors-heading">
              <h2 id="monitors-heading" className="mb-4 text-xl font-semibold">
                Monitors
              </h2>
              <MonitorList state={state} onRetry={retry} />
            </section>
            <section aria-labelledby="add-heading">
              <h2 id="add-heading" className="mb-4 text-xl font-semibold">
                Add monitor
              </h2>
              <AddMonitorForm onCreated={onCreated} client={client} />
            </section>
          </>
        )}
      </main>
    </div>
  );
}
