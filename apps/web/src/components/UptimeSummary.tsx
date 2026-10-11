import type { UptimeSummary as Summary, UptimeWindow } from '../api/types';

export type UptimeItem =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; summary: Summary };

const LABELS: Record<UptimeWindow, string> = {
  '24h': '24 hours',
  '7d': '7 days',
  '30d': '30 days',
};
const ORDER: UptimeWindow[] = ['24h', '7d', '30d'];

function Tile({ item }: { item: UptimeItem }) {
  if (item.status === 'loading') return <span className="text-slate-700">Loading…</span>;
  if (item.status === 'error') return <span className="text-red-900">Unavailable</span>;
  const s = item.summary;
  if (s.totalChecks === 0) return <span className="text-slate-700">No data</span>;
  const ms = (v: number | null) => (v === null ? '—' : `${v} ms`);
  return (
    <>
      <span className="block text-2xl font-semibold text-slate-900">
        {(s.uptimePercent ?? 0).toFixed(2)}%
      </span>
      <span className="block text-sm text-slate-700">
        p50 {ms(s.latencyP50Ms)} · p95 {ms(s.latencyP95Ms)}
      </span>
      <span className="block text-sm text-slate-700">{s.totalChecks} checks</span>
    </>
  );
}

export function UptimeSummary({ items }: { items: Record<UptimeWindow, UptimeItem> }) {
  const loading = ORDER.some((w) => items[w].status === 'loading');
  return (
    <div role={loading ? 'status' : undefined}>
      <dl className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {ORDER.map((w) => (
          <div key={w} className="rounded-md border border-slate-300 bg-white p-3">
            <dt className="text-sm font-medium text-slate-800">{LABELS[w]}</dt>
            <dd className="mt-1">
              <Tile item={items[w]} />
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
