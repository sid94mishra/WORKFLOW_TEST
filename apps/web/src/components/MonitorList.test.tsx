import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { MonitorList } from './MonitorList';
import { makeMonitor } from '../test/fixtures';

describe('MonitorList', () => {
  it('shows a loading status', () => {
    render(<MonitorList state={{ status: 'loading' }} onRetry={vi.fn()} />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading monitors…');
  });

  it('shows an error alert with a working Retry button', async () => {
    const onRetry = vi.fn();
    render(<MonitorList state={{ status: 'error', message: 'Network error' }} onRetry={onRetry} />);
    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't load monitors: Network error");
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('shows the empty message', () => {
    render(<MonitorList state={{ status: 'ready', monitors: [] }} onRetry={vi.fn()} />);
    expect(screen.getByText('No monitors yet. Add your first one below.')).toBeInTheDocument();
  });

  it('renders a table with headers and one row per monitor in order', () => {
    const monitors = [
      makeMonitor({ id: '1', name: 'Alpha', intervalSeconds: 30, enabled: true }),
      makeMonitor({
        id: '2',
        name: 'Beta',
        url: 'https://beta.test',
        method: 'HEAD',
        enabled: false,
      }),
    ];
    render(<MonitorList state={{ status: 'ready', monitors }} onRetry={vi.fn()} />);

    const table = screen.getByRole('table', { name: 'Monitors' });
    const headers = within(table)
      .getAllByRole('columnheader')
      .map((h) => h.textContent);
    expect(headers).toEqual(['Name', 'URL', 'Method', 'Interval', 'Expected status', 'Status']);

    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByText('Alpha')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('30s')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('Pending')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('Beta')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('https://beta.test')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('HEAD')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('Paused')).toBeInTheDocument();
    expect(within(rows[0]!).getByRole('link', { name: 'Alpha' })).toHaveAttribute(
      'href',
      `#/monitors/${monitors[0]!.id}`,
    );
  });
});
