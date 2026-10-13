import { describe, expect, it } from 'vitest';
import {
  CHECK_DURATION_BUCKETS,
  METRICS,
  METRICS_CONTENT_TYPE,
  bucketIndex,
  escapeLabelValue,
  histogramSamples,
  renderPrometheus,
} from '../src/index.js';

describe('prometheus rendering', () => {
  it('escapes label values', () => {
    expect(escapeLabelValue('a\\b"c\nd')).toBe('a\\\\b\\"c\\nd');
  });

  it('renders HELP, TYPE and samples with a trailing newline', () => {
    const text = renderPrometheus([
      {
        ...METRICS.monitorUp,
        samples: [{ labels: { monitor: 'API "prod"', id: 'x' }, value: 1 }],
      },
      { ...METRICS.openIncidents, samples: [{ value: 0 }] },
    ]);
    expect(text).toBe(
      [
        `# HELP pulse_monitor_up ${METRICS.monitorUp.help}`,
        '# TYPE pulse_monitor_up gauge',
        'pulse_monitor_up{monitor="API \\"prod\\"",id="x"} 1',
        `# HELP pulse_open_incidents ${METRICS.openIncidents.help}`,
        '# TYPE pulse_open_incidents gauge',
        'pulse_open_incidents 0',
        '',
      ].join('\n'),
    );
    expect(renderPrometheus([])).toBe('');
    expect(METRICS_CONTENT_TYPE).toBe('text/plain; version=0.0.4; charset=utf-8');
  });

  it('builds cumulative histogram samples', () => {
    const buckets = [...CHECK_DURATION_BUCKETS];
    const counts = new Array<number>(buckets.length + 1).fill(0);
    for (const seconds of [0.01, 0.05, 0.3, 61]) {
      const i = bucketIndex(buckets, seconds);
      counts[i] = (counts[i] ?? 0) + 1;
    }
    const samples = histogramSamples(buckets, counts, 61.36);
    expect(samples.find((s) => s.labels?.le === '0.05')?.value).toBe(2);
    expect(samples.find((s) => s.labels?.le === '0.5')?.value).toBe(3);
    expect(samples.find((s) => s.labels?.le === '60')?.value).toBe(3);
    expect(samples.find((s) => s.labels?.le === '+Inf')?.value).toBe(4);
    expect(samples.at(-2)).toEqual({ suffix: '_sum', labels: {}, value: 61.36 });
    expect(samples.at(-1)).toEqual({ suffix: '_count', labels: {}, value: 4 });
    const text = renderPrometheus([{ ...METRICS.checkDuration, samples }]);
    expect(text).toContain('pulse_check_duration_seconds_bucket{le="+Inf"} 4\n');
    expect(text).toContain('pulse_check_duration_seconds_count 4\n');
  });
});
