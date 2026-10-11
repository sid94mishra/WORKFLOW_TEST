import type { MonitorStatus } from '../api/types';

const STYLES: Record<MonitorStatus | 'paused', { label: string; classes: string }> = {
  paused: { label: 'Paused', classes: 'bg-slate-200 text-slate-800' },
  pending: { label: 'Pending', classes: 'bg-slate-100 text-slate-800' },
  up: { label: 'Up', classes: 'bg-green-100 text-green-900' },
  degraded: { label: 'Degraded', classes: 'bg-amber-100 text-amber-900' },
  down: { label: 'Down', classes: 'bg-red-100 text-red-900' },
};

export function StatusBadge({ status, enabled }: { status: MonitorStatus; enabled: boolean }) {
  const { label, classes } = STYLES[enabled ? status : 'paused'];
  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${classes}`}>{label}</span>;
}
