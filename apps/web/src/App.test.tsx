import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ApiClientError } from './api/client';
import { App } from './App';
import { fakeClient, makeMonitor } from './test/fixtures';

describe('App', () => {
  it('lists monitors from the API', async () => {
    const listMonitors = vi.fn().mockResolvedValue([makeMonitor({ name: 'Alpha' })]);
    render(<App client={fakeClient({ listMonitors })} />);
    expect(screen.getByText('Loading monitors…')).toBeInTheDocument();
    const table = await screen.findByRole('table', { name: 'Monitors' });
    expect(within(table).getByText('Alpha')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Pulse' })).toBeInTheDocument();
  });

  it('retries after an error', async () => {
    const listMonitors = vi
      .fn()
      .mockRejectedValueOnce(new ApiClientError(0, 'NETWORK_ERROR', 'Network error'))
      .mockResolvedValueOnce([]);
    render(<App client={fakeClient({ listMonitors })} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Network error');
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(
      await screen.findByText('No monitors yet. Add your first one below.'),
    ).toBeInTheDocument();
  });

  it('appends a created monitor to the list without refetching', async () => {
    const created = makeMonitor({ id: '2', name: 'Fresh' });
    const client = fakeClient({ createMonitor: vi.fn().mockResolvedValue(created) });
    render(<App client={client} />);
    await screen.findByText('No monitors yet. Add your first one below.');
    await userEvent.type(screen.getByLabelText('Name'), 'Fresh');
    await userEvent.type(screen.getByLabelText('URL'), 'https://example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Add monitor' }));
    const table = await screen.findByRole('table', { name: 'Monitors' });
    expect(within(table).getByText('Fresh')).toBeInTheDocument();
    expect(client.listMonitors).toHaveBeenCalledTimes(1);
  });
});
