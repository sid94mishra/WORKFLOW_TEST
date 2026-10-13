/**
 * Prometheus metrics (iteration 5 spec §3.7). Names, help text, buckets and a pure renderer for
 * the text exposition format 0.0.4, so `@pulse/api` only has to collect values.
 */
export const METRICS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';
export const CHECK_RESULT_LABELS = ['ok', 'fail'] as const;
/** Seconds. The largest monitor timeout is 60 s. `+Inf` is implicit. */
export const CHECK_DURATION_BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60] as const;

export const METRICS = {
  monitorUp: {
    name: 'pulse_monitor_up',
    type: 'gauge',
    help: 'Whether the last check of the monitor succeeded (1) or failed (0). Paused and pending monitors are omitted.',
  },
  checkDuration: {
    name: 'pulse_check_duration_seconds',
    type: 'histogram',
    help: 'Duration of checks recorded since the process started.',
  },
  checksTotal: {
    name: 'pulse_checks_total',
    type: 'counter',
    help: 'Checks recorded since the process started, by result.',
  },
  openIncidents: {
    name: 'pulse_open_incidents',
    type: 'gauge',
    help: 'Number of open incidents.',
  },
  maintenanceActive: {
    name: 'pulse_maintenance_active',
    type: 'gauge',
    help: 'Whether a maintenance window is active for the monitor (1) or not (0).',
  },
} as const;

export type CheckResultLabel = (typeof CHECK_RESULT_LABELS)[number];
export type MetricType = 'gauge' | 'counter' | 'histogram';
export type MetricSample = {
  /** Defaults to the family name; histograms use `_bucket` / `_sum` / `_count` suffixes. */
  suffix?: '_bucket' | '_sum' | '_count';
  labels?: Readonly<Record<string, string>>;
  value: number;
};
export type MetricFamily = {
  name: string;
  type: MetricType;
  help: string;
  samples: readonly MetricSample[];
};

/** Label values escape `\`, `"` and newline. */
export const escapeLabelValue = (value: string): string =>
  value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n');
/** HELP text escapes `\` and newline. */
export const escapeHelp = (value: string): string =>
  value.replaceAll('\\', '\\\\').replaceAll('\n', '\\n');

export function formatMetricValue(value: number): string {
  if (Number.isNaN(value)) return 'NaN';
  if (value === Infinity) return '+Inf';
  if (value === -Infinity) return '-Inf';
  return String(value);
}

/** `le` label text for a histogram bucket bound. */
export const formatBucketBound = (bound: number): string => formatMetricValue(bound);

/**
 * Renders families in the given order: `# HELP`, `# TYPE`, then one line per sample. Output ends
 * with a newline, as the format requires.
 */
export function renderPrometheus(families: readonly MetricFamily[]): string {
  const lines: string[] = [];
  for (const family of families) {
    lines.push(`# HELP ${family.name} ${escapeHelp(family.help)}`);
    lines.push(`# TYPE ${family.name} ${family.type}`);
    for (const sample of family.samples) {
      const labels = Object.entries(sample.labels ?? {});
      const labelText = labels.length
        ? `{${labels.map(([k, v]) => `${k}="${escapeLabelValue(v)}"`).join(',')}}`
        : '';
      lines.push(
        `${family.name}${sample.suffix ?? ''}${labelText} ${formatMetricValue(sample.value)}`,
      );
    }
  }
  return lines.length ? `${lines.join('\n')}\n` : '';
}

/**
 * Histogram samples (cumulative buckets, `+Inf`, `_sum`, `_count`) from per-bucket counts.
 * `counts[i]` is the number of observations `≤ buckets[i]` and `> buckets[i-1]`;
 * `counts[buckets.length]` is the overflow (> last bound).
 */
export function histogramSamples(
  buckets: readonly number[],
  counts: readonly number[],
  sum: number,
  labels: Readonly<Record<string, string>> = {},
): MetricSample[] {
  let cumulative = 0;
  const samples: MetricSample[] = buckets.map((bound, i) => {
    cumulative += counts[i] ?? 0;
    return {
      suffix: '_bucket',
      labels: { ...labels, le: formatBucketBound(bound) },
      value: cumulative,
    };
  });
  cumulative += counts[buckets.length] ?? 0;
  samples.push({ suffix: '_bucket', labels: { ...labels, le: '+Inf' }, value: cumulative });
  samples.push({ suffix: '_sum', labels, value: sum });
  samples.push({ suffix: '_count', labels, value: cumulative });
  return samples;
}

/** Index of the bucket an observation falls in (`buckets.length` = overflow). */
export function bucketIndex(buckets: readonly number[], value: number): number {
  const i = buckets.findIndex((bound) => value <= bound);
  return i === -1 ? buckets.length : i;
}
