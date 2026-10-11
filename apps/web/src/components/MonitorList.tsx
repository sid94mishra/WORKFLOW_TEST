import type { Monitor } from '@pulse/shared';

export type MonitorListState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; monitors: Monitor[] };

export interface MonitorListProps {
  state: MonitorListState;
  onRetry: () => void;
}

const HEADERS = ['Name', 'URL', 'Method', 'Interval', 'Expected status', 'State'] as const;

export function MonitorList({ state, onRetry }: MonitorListProps) {
  if (state.status === 'loading') {
    return (
      <p role="status" className="text-slate-700">
        Loading monitors…
      </p>
    );
  }

  if (state.status === 'error') {
    return (
      <div role="alert" className="rounded-md border border-red-300 bg-red-50 p-4 text-red-900">
        <p>Couldn't load monitors: {state.message}</p>
        <button
          type="button"
          onClick={onRetry}
          className="mt-3 rounded-md bg-red-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-700 focus-visible:ring-offset-2"
        >
          Retry
        </button>
      </div>
    );
  }

  if (state.monitors.length === 0) {
    return <p className="text-slate-700">No monitors yet. Add your first one below.</p>;
  }

  return (
    <div className="overflow-x-auto rounded-md border border-slate-300 bg-white">
      <table className="w-full min-w-[40rem] text-left text-sm">
        <caption className="sr-only">Monitors</caption>
        <thead className="bg-slate-100 text-slate-800">
          <tr>
            {HEADERS.map((h) => (
              <th key={h} scope="col" className="px-3 py-2 font-semibold">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-200">
          {state.monitors.map((m) => (
            <tr key={m.id}>
              <td className="px-3 py-2 font-medium text-slate-900">{m.name}</td>
              <td className="break-all px-3 py-2 text-slate-700">{m.url}</td>
              <td className="px-3 py-2 text-slate-700">{m.method}</td>
              <td className="px-3 py-2 text-slate-700">{m.intervalSeconds}s</td>
              <td className="px-3 py-2 text-slate-700">{m.expectedStatus}</td>
              <td className="px-3 py-2">
                <span
                  className={
                    m.enabled
                      ? 'rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-900'
                      : 'rounded-full bg-slate-200 px-2 py-0.5 text-xs font-medium text-slate-800'
                  }
                >
                  {m.enabled ? 'Enabled' : 'Paused'}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
