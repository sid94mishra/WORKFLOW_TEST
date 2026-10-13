import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { fakeClient, makeMonitor, makeUptime } from '../test/fixtures';
import { MonitorDetail } from './MonitorDetail';

const maintenance = {
  id: '50000000-0000-4000-8000-000000000099',
  title: 'DB upgrade',
  startsAt: '2026-10-20T01:00:00.000Z',
  endsAt: '2026-10-20T03:30:00.000Z',
};

function renderDetail(over: Parameters<typeof makeMonitor>[0]) {
  const m = makeMonitor({ name: 'Alpha', status: 'down', ...over });
  const client = fakeClient({
    getMonitor: vi.fn().mockResolvedValue(m),
    getUptime: vi.fn().mockResolvedValue(makeUptime()),
  });
  render(<MonitorDetail id={m.id} client={client} />);
}

describe('MonitorDetail maintenance badge', () => {
  it('shows Maintenance with the window title instead of the stored status', async () => {
    renderDetail({ maintenance });
    await screen.findByRole('heading', { name: 'Alpha' });
    const badge = screen.getByText('Maintenance');
    expect(badge).toHaveAttribute('title', 'DB upgrade · until 03:30 UTC');
    expect(screen.queryByText('Down')).toBeNull();
  });

  it('shows Paused for a disabled monitor even during maintenance', async () => {
    renderDetail({ maintenance, enabled: false });
    await screen.findByRole('heading', { name: 'Alpha' });
    expect(screen.getByText('Paused')).toBeInTheDocument();
    expect(screen.queryByText('Maintenance')).toBeNull();
  });
});
