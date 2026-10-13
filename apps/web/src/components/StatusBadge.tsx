import type { ActiveMaintenance, MonitorStatus } from '../api/types';

type Variant = MonitorStatus | 'paused' | 'maintenance';

const STYLES: Record<Variant, { label: string; classes: string }> = {
  paused: { label: 'Paused', classes: 'bg-slate-200 text-slate-800' },
  maintenance: { label: 'Maintenance', classes: 'bg-blue-100 text-blue-900' },
  pending: { label: 'Pending', classes: 'bg-slate-100 text-slate-800' },
  up: { label: 'Up', classes: 'bg-green-100 text-green-900' },
  degraded: { label: 'Degraded', classes: 'bg-amber-100 text-amber-900' },
  down: { label: 'Down', classes: 'bg-red-100 text-red-900' },
};

/** Paused beats maintenance beats the stored status (same precedence as the status page). */
export function StatusBadge({
  status,
  enabled,
  maintenance,
}: {
  status: MonitorStatus;
  enabled: boolean;
  maintenance?: ActiveMaintenance | null;
}) {
  const active = enabled ? (maintenance ?? null) : null;
  const variant: Variant = !enabled ? 'paused' : active ? 'maintenance' : status;
  const { label, classes } = STYLES[variant];
  const title = active ? `${active.title} · until ${active.endsAt.slice(11, 16)} UTC` : undefined;
  return (
    <span title={title} className={`rounded-full px-2 py-0.5 text-xs font-medium ${classes}`}>
      {label}
    </span>
  );
}
