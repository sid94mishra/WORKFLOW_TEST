import { useCallback, useEffect, useState } from 'react';
import type { Monitor } from './api/types';
import { api, ApiClientError, type ApiClient } from './api/client';
import { AddMonitorForm } from './components/AddMonitorForm';
import { MonitorDetail } from './components/MonitorDetail';
import { useHashRoute } from './hooks/useHashRoute';
import { MonitorList, type MonitorListState } from './components/MonitorList';

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
        </div>
      </header>
      <main className="mx-auto max-w-5xl space-y-10 px-4 py-8">
        {route.name === 'monitor' ? (
          <MonitorDetail id={route.id} client={client} />
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
