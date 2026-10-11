import type { CheckResult } from '../api/types';

const W = 240;
const H = 48;
const PAD = 4;

function median(sorted: number[]): number {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

/** `results` arrive newest first; the chart plots oldest → newest. */
export function LatencySparkline({ results }: { results: CheckResult[] }) {
  if (results.length === 0) return null;

  const ordered = [...results].reverse();
  const n = ordered.length;
  const okLatencies = ordered.filter((r) => r.ok).map((r) => r.latencyMs);
  const failed = n - okLatencies.length;
  const maxLatency = Math.max(0, ...okLatencies);
  const x = (i: number) => (n === 1 ? W / 2 : PAD + (i * (W - 2 * PAD)) / (n - 1));
  const y = (ms: number) =>
    maxLatency === 0 ? H - PAD : H - PAD - (ms / maxLatency) * (H - 2 * PAD);

  const okPoints = ordered.flatMap((r, i) => (r.ok ? [{ x: x(i), y: y(r.latencyMs) }] : []));
  const marks = ordered.flatMap((r, i) => (r.ok ? [] : [x(i)]));

  let label: string;
  if (okLatencies.length === 0) {
    label = `No successful checks in the last ${n} checks.`;
  } else {
    const sorted = [...okLatencies].sort((a, b) => a - b);
    const latestOk = [...ordered].reverse().find((r) => r.ok)!.latencyMs;
    label =
      `Latency over the last ${n} checks: min ${sorted[0]} ms, median ${median(sorted)} ms, ` +
      `max ${sorted[sorted.length - 1]} ms, latest ${latestOk} ms, ${failed} failed.`;
  }

  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      width="100%"
      height={H}
      className="block rounded-md border border-slate-300 bg-white"
    >
      {okPoints.length === 1 ? (
        <circle cx={okPoints[0]!.x} cy={okPoints[0]!.y} r={2} className="fill-blue-700" />
      ) : okPoints.length > 1 ? (
        <polyline
          points={okPoints.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')}
          fill="none"
          strokeWidth={2}
          vectorEffect="non-scaling-stroke"
          className="stroke-blue-700"
        />
      ) : null}
      {marks.map((mx, i) => (
        <line
          key={i}
          data-testid="failure-mark"
          x1={mx}
          x2={mx}
          y1={H - PAD - 10}
          y2={H - PAD}
          strokeWidth={2}
          vectorEffect="non-scaling-stroke"
          className="stroke-red-700"
        />
      ))}
    </svg>
  );
}
