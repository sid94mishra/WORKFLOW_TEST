import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { UptimeSummary } from './UptimeSummary';
import { makeUptime } from '../test/fixtures';

describe('UptimeSummary', () => {
  it('renders ready, empty, loading and error tiles', () => {
    render(
      <UptimeSummary
        items={{
          '24h': {
            status: 'ready',
            summary: makeUptime({ uptimePercent: 99.95, totalChecks: 10080, latencyP95Ms: null }),
          },
          '7d': { status: 'ready', summary: makeUptime({ totalChecks: 0, uptimePercent: null }) },
          '30d': { status: 'error', message: 'boom' },
        }}
      />,
    );
    expect(screen.getByText('24 hours')).toBeInTheDocument();
    expect(screen.getByText('99.95%')).toBeInTheDocument();
    expect(screen.getByText('p50 112 ms · p95 —')).toBeInTheDocument();
    expect(screen.getByText('10080 checks')).toBeInTheDocument();
    expect(screen.getByText('No data')).toBeInTheDocument();
    expect(screen.getByText('Unavailable')).toBeInTheDocument();
  });

  it('announces loading', () => {
    const loading = { status: 'loading' } as const;
    render(<UptimeSummary items={{ '24h': loading, '7d': loading, '30d': loading }} />);
    expect(within(screen.getByRole('status')).getAllByText('Loading…')).toHaveLength(3);
  });
});
