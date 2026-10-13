import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ApiClientError } from './api/client';
import { App } from './App';
import { fakeClient, makeMonitor, makeUptime } from './test/fixtures';

describe('App', () => {
  it('lists monitors from the API', async () => {
    const listMonitors = vi
      .fn()
      .mockImplementation(
        () => new Promise((r) => setTimeout(() => r([makeMonitor({ name: 'Alpha' })]), 30)),
      );
    render(<App client={fakeClient({ listMonitors })} />);
    expect(await screen.findByText('Loading monitors…')).toBeInTheDocument();
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

  it('navigates between the dashboard and a monitor detail via the hash', async () => {
    window.location.hash = '';
    const mon = makeMonitor({ name: 'Alpha' });
    const client = fakeClient({
      listMonitors: vi.fn().mockResolvedValue([mon]),
      getMonitor: vi.fn().mockResolvedValue(mon),
      getUptime: vi.fn().mockResolvedValue(makeUptime()),
    });
    render(<App client={client} />);
    await userEvent.click(await screen.findByRole('link', { name: 'Alpha' }, { timeout: 10_000 }));
    expect(window.location.hash).toBe(`#/monitors/${mon.id}`);
    expect(await screen.findByRole('heading', { level: 2, name: 'Alpha' })).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();
    await userEvent.click(screen.getByRole('link', { name: '← All monitors' }));
    expect(await screen.findByRole('table', { name: 'Monitors' })).toBeInTheDocument();
    window.location.hash = '';
  });

  it('renders the main nav with aria-current following the hash', async () => {
    window.location.hash = '';
    render(<App client={fakeClient()} />);
    const nav = await screen.findByRole('navigation', { name: 'Main' });
    const link = (name: string) => within(nav).getByRole('link', { name });
    expect(link('Monitors')).toHaveAttribute('aria-current', 'page');
    expect(link('Incidents')).not.toHaveAttribute('aria-current');
    expect(link('Status page')).toHaveAttribute('href', '/status');
    expect(link('Status page')).toHaveAttribute('target', '_blank');
    expect(link('Status page')).toHaveAttribute('rel', 'noopener');

    await userEvent.click(link('Incidents'));
    expect(await screen.findByRole('heading', { name: 'Incidents' })).toBeInTheDocument();
    expect(link('Incidents')).toHaveAttribute('aria-current', 'page');
    expect(link('Monitors')).not.toHaveAttribute('aria-current');

    await userEvent.click(link('Channels'));
    expect(await screen.findByRole('heading', { name: 'Channels' })).toBeInTheDocument();
    expect(link('Channels')).toHaveAttribute('aria-current', 'page');
    window.location.hash = '';
  });

  it('shows the signed-in email, the API keys route and logs out', async () => {
    window.location.hash = '#/settings/api-keys';
    let finish!: () => void;
    const logout = vi.fn().mockReturnValue(new Promise<void>((r) => (finish = r)));
    render(<App client={fakeClient({ logout })} />);
    expect(await screen.findByText('admin@example.com')).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'API keys' })).toBeInTheDocument();
    expect(
      within(screen.getByRole('navigation', { name: 'Main' })).getByRole('link', {
        name: 'API keys',
      }),
    ).toHaveAttribute('aria-current', 'page');

    await userEvent.click(screen.getByRole('button', { name: 'Log out' }));
    expect(screen.getByRole('button', { name: 'Logging out…' })).toBeDisabled();
    finish();
    expect(await screen.findByRole('heading', { name: 'Sign in to Pulse' })).toBeInTheDocument();
    expect(window.location.hash).toBe('#/settings/api-keys');
    window.location.hash = '';
  });

  it('shows an alert and stays signed in when logout fails', async () => {
    window.location.hash = '';
    const logout = vi.fn().mockRejectedValue(new ApiClientError(500, 'INTERNAL_ERROR', 'boom'));
    render(<App client={fakeClient({ logout })} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Log out' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not log out');
    expect(screen.getByText('admin@example.com')).toBeInTheDocument();
  });
});
