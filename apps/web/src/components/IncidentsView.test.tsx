import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ApiClientError } from '../api/client';
import { fakeClient, makeIncident } from '../test/fixtures';
import { IncidentsView } from './IncidentsView';

const now = () => new Date('2026-10-11T09:02:05.000Z');

describe('IncidentsView', () => {
  it('shows loading, then open before resolved with durations and monitor links', async () => {
    const listIncidents = vi.fn().mockResolvedValue([
      makeIncident({ monitorName: 'Alpha', monitorId: 'm1' }),
      makeIncident({
        monitorName: 'Beta',
        monitorId: 'm2',
        status: 'resolved',
        cause: null,
        startedAt: '2026-10-10T09:00:00.000Z',
        resolvedAt: '2026-10-10T10:00:00.000Z',
        durationSeconds: 3600,
      }),
    ]);
    render(<IncidentsView client={fakeClient({ listIncidents })} now={now} />);
    expect(screen.getByText('Loading incidents…')).toBeInTheDocument();
    const open = await screen.findByRole('region', { name: 'Open' }, { timeout: 10_000 });
    expect(within(open).getByRole('link', { name: 'Alpha' })).toHaveAttribute(
      'href',
      '#/monitors/m1',
    );
    expect(within(open).getByText('Ongoing · 2m 5s')).toBeInTheDocument();
    expect(within(open).getByText(/connect ECONNREFUSED/)).toBeInTheDocument();
    const resolved = screen.getByRole('region', { name: 'Resolved' });
    expect(within(resolved).getByText('Lasted 1h')).toBeInTheDocument();
    expect(within(resolved).getByText('Cause: —')).toBeInTheDocument();
    expect(open.compareDocumentPosition(resolved) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(listIncidents).toHaveBeenCalledWith(
      { status: 'all', limit: 200 },
      expect.any(AbortSignal),
    );
  });

  it('omits the Open section when nothing is open', async () => {
    const listIncidents = vi
      .fn()
      .mockResolvedValue([makeIncident({ status: 'resolved', durationSeconds: 5 })]);
    render(<IncidentsView client={fakeClient({ listIncidents })} now={now} />);
    await screen.findByRole('region', { name: 'Resolved' }, { timeout: 10_000 });
    expect(screen.queryByRole('region', { name: 'Open' })).not.toBeInTheDocument();
  });

  it('shows the empty state', async () => {
    render(<IncidentsView client={fakeClient()} />);
    expect(
      await screen.findByText('No incidents yet. Incidents open when a monitor goes down.'),
    ).toBeInTheDocument();
  });

  it('shows an error alert and refetches on Retry', async () => {
    const listIncidents = vi
      .fn()
      .mockRejectedValueOnce(new ApiClientError(0, 'NETWORK_ERROR', 'Network error'))
      .mockResolvedValueOnce([makeIncident()]);
    render(<IncidentsView client={fakeClient({ listIncidents })} now={now} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Network error');
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('region', { name: 'Open' })).toBeInTheDocument();
    expect(listIncidents).toHaveBeenCalledTimes(2);
  });
});
