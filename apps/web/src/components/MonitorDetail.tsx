import { useCallback, useEffect, useState } from 'react';
import { api, ApiClientError, type ApiClient } from '../api/client';
import { UPTIME_WINDOWS, type CheckResult, type Monitor, type UptimeWindow } from '../api/types';
import { LatencySparkline } from './LatencySparkline';
import { StatusBadge } from './StatusBadge';
import { UptimeSummary, type UptimeItem } from './UptimeSummary';

type Section<T> =
  { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; value: T };

const loadingUptime = (): Record<UptimeWindow, UptimeItem> => ({
  '24h': { status: 'loading' },
  '7d': { status: 'loading' },
  '30d': { status: 'loading' },
});

const messageOf = (err: unknown) =>
  err instanceof ApiClientError ? err.message : 'Unexpected error';

const BACK = (
  <a
    href="#/"
    className="text-sm font-medium text-blue-800 underline hover:text-blue-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-700 focus-visible:ring-offset-2"
  >
    ← All monitors
  </a>
);

export function MonitorDetail({ id, client = api }: { id: string; client?: ApiClient }) {
  const [monitor, setMonitor] = useState<Section<Monitor> | { status: 'notFound' }>({
    status: 'loading',
  });
  const [results, setResults] = useState<Section<CheckResult[]>>({ status: 'loading' });
  const [uptime, setUptime] = useState(loadingUptime);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    setMonitor({ status: 'loading' });
    setResults({ status: 'loading' });
    setUptime(loadingUptime());

    client
      .getMonitor(id, signal)
      .then((value) => setMonitor({ status: 'ready', value }))
      .catch((err: unknown) => {
        if (signal.aborted) return;
        setMonitor(
          err instanceof ApiClientError && err.status === 404
            ? { status: 'notFound' }
            : { status: 'error', message: messageOf(err) },
        );
      });
    client
      .listResults(id, { limit: 50 }, signal)
      .then((value) => setResults({ status: 'ready', value }))
      .catch((err: unknown) => {
        if (!signal.aborted) setResults({ status: 'error', message: messageOf(err) });
      });
    for (const w of UPTIME_WINDOWS) {
      client
        .getUptime(id, w, signal)
        .then((summary) => setUptime((u) => ({ ...u, [w]: { status: 'ready', summary } })))
        .catch((err: unknown) => {
          if (!signal.aborted)
            setUptime((u) => ({ ...u, [w]: { status: 'error', message: messageOf(err) } }));
        });
    }
    return () => controller.abort();
  }, [client, id, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  if (monitor.status === 'loading') {
    return (
      <p role="status" className="text-slate-700">
        Loading monitor…
      </p>
    );
  }

  if (monitor.status === 'notFound') {
    return (
      <div className="space-y-3">
        <p className="text-slate-900">Monitor not found.</p>
        {BACK}
      </div>
    );
  }

  if (monitor.status === 'error') {
    return (
      <div className="space-y-3">
        {BACK}
        <div role="alert" className="rounded-md border border-red-300 bg-red-50 p-4 text-red-900">
          <p>Couldn't load monitor: {monitor.message}</p>
          <button
            type="button"
            onClick={retry}
            className="mt-3 rounded-md bg-red-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-700 focus-visible:ring-offset-2"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  const m = monitor.value;
  return (
    <article className="space-y-6">
      {BACK}
      <header className="space-y-2">
        <h2 className="text-xl font-semibold">{m.name}</h2>
        <p className="break-all text-sm text-slate-700">{m.url}</p>
        <div className="flex flex-wrap items-center gap-3 text-sm text-slate-700">
          <StatusBadge status={m.status} enabled={m.enabled} />
          <span>
            {m.lastCheckedAt ? (
              <>
                Last checked <time dateTime={m.lastCheckedAt}>{m.lastCheckedAt}</time>
              </>
            ) : (
              'Not checked yet'
            )}
          </span>
        </div>
      </header>

      <section aria-labelledby="latency-heading" className="space-y-2">
        <h3 id="latency-heading" className="text-lg font-semibold">
          Latency (last 50 checks)
        </h3>
        {results.status === 'loading' ? (
          <p role="status" className="text-slate-700">
            Loading results…
          </p>
        ) : results.status === 'error' ? (
          <p className="text-red-900">Results unavailable: {results.message}</p>
        ) : results.value.length === 0 ? (
          <p className="text-slate-700">
            No checks yet. The first check runs shortly after the monitor is enabled.
          </p>
        ) : (
          <LatencySparkline results={results.value} />
        )}
      </section>

      <section aria-labelledby="uptime-heading" className="space-y-2">
        <h3 id="uptime-heading" className="text-lg font-semibold">
          Uptime
        </h3>
        <UptimeSummary items={uptime} />
      </section>
    </article>
  );
}
