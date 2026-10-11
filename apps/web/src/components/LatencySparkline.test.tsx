import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { LatencySparkline } from './LatencySparkline';
import { makeResult } from '../test/fixtures';

describe('LatencySparkline', () => {
  it('renders nothing when empty', () => {
    const { container } = render(<LatencySparkline results={[]} />);
    expect(container.querySelector('svg')).toBeNull();
  });

  it('plots oldest to newest with failure marks and a summary label', () => {
    // newest first
    const results = [
      makeResult({ latencyMs: 101 }),
      makeResult({ ok: false, status: 'degraded', statusCode: null, error: 'timeout' }),
      makeResult({ latencyMs: 340 }),
      makeResult({ latencyMs: 80 }),
    ];
    const { container } = render(<LatencySparkline results={results} />);
    const img = screen.getByRole('img');
    expect(img).toHaveAttribute(
      'aria-label',
      'Latency over the last 4 checks: min 80 ms, median 101 ms, max 340 ms, latest 101 ms, 1 failed.',
    );
    expect(screen.getAllByTestId('failure-mark')).toHaveLength(1);
    const pts = container
      .querySelector('polyline')!
      .getAttribute('points')!
      .split(' ')
      .map((p) => Number(p.split(',')[1]));
    // oldest (80) is lower on screen (larger y) than 340 (smaller y); newest 101 in between
    expect(pts).toHaveLength(3);
    expect(pts[0]!).toBeGreaterThan(pts[2]!);
    expect(pts[1]!).toBeLessThan(pts[0]!);
  });

  it('draws a circle for a single ok result and handles all-failed', () => {
    const { container, rerender } = render(<LatencySparkline results={[makeResult()]} />);
    expect(container.querySelector('circle')).not.toBeNull();
    rerender(
      <LatencySparkline
        results={[makeResult({ ok: false, status: 'down', statusCode: null, error: 'x' })]}
      />,
    );
    expect(screen.getByRole('img')).toHaveAttribute(
      'aria-label',
      'No successful checks in the last 1 checks.',
    );
  });
});
