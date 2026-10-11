import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ApiClientError } from '../api/client';
import { MonitorDetail } from './MonitorDetail';
import { fakeClient, makeMonitor, makeResult, makeUptime } from '../test/fixtures';

const m = makeMonitor({ name: 'Alpha' });

describe('MonitorDetail', () => {
  it('shows independent results and uptime loading states after the monitor loads', async () => {
    const pending = () => new Promise<never>(() => {});
    const client = fakeClient({
      getMonitor: vi.fn().mockResolvedValue(m),
      listResults: vi.fn(pending),
      getUptime: vi.fn(pending),
    });
    render(<MonitorDetail id={m.id} client={client} />);
    expect(screen.getByText('Loading monitor…')).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Alpha' })).toBeInTheDocument();
    expect(screen.getByText('Loading results…')).toBeInTheDocument();
    expect(screen.getAllByText('Loading…')).toHaveLength(3);
  });

  it('shows loading, then monitor, sparkline and uptime tiles', async () => {
    const client = fakeClient({
      getMonitor: vi
        .fn()
        .mockResolvedValue({ ...m, status: 'down', lastCheckedAt: '2026-10-11T09:31:00.000Z' }),
      listResults: vi
        .fn()
        .mockResolvedValue([
          makeResult(),
          makeResult({ ok: false, status: 'down', statusCode: null, error: 'x' }),
        ]),
      getUptime: vi.fn().mockResolvedValue(makeUptime()),
    });
    render(<MonitorDetail id={m.id} client={client} />);
    expect(screen.getByText('Loading monitor…')).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Alpha' })).toBeInTheDocument();
    expect(screen.getByText('Down')).toBeInTheDocument();
    expect(await screen.findByRole('img')).toBeInTheDocument();
    expect(await screen.findAllByText('99.00%')).toHaveLength(3);
    expect(client.listResults).toHaveBeenCalledWith(m.id, { limit: 50 }, expect.any(AbortSignal));
    expect(client.getUptime).toHaveBeenCalledTimes(3);
    expect(screen.getByRole('link', { name: '← All monitors' })).toHaveAttribute('href', '#/');
  });

  it('shows Paused and empty states', async () => {
    const client = fakeClient({
      getMonitor: vi.fn().mockResolvedValue({ ...m, enabled: false }),
      getUptime: vi.fn().mockResolvedValue(
        makeUptime({
          totalChecks: 0,
          okChecks: 0,
          uptimePercent: null,
          latencyP50Ms: null,
          latencyP95Ms: null,
        }),
      ),
    });
    const { container } = render(<MonitorDetail id={m.id} client={client} />);
    expect(await screen.findByText('Paused')).toBeInTheDocument();
    expect(screen.getByText('Not checked yet')).toBeInTheDocument();
    expect(
      await screen.findByText(/No checks yet\. The first check runs shortly/),
    ).toBeInTheDocument();
    expect(await screen.findAllByText('No data')).toHaveLength(3);
    expect(container.querySelector('svg')).toBeNull();
  });

  it('shows not found on 404', async () => {
    const client = fakeClient({
      getMonitor: vi.fn().mockRejectedValue(new ApiClientError(404, 'NOT_FOUND', 'nope')),
      listResults: vi.fn().mockRejectedValue(new ApiClientError(404, 'NOT_FOUND', 'nope')),
      getUptime: vi.fn().mockRejectedValue(new ApiClientError(404, 'NOT_FOUND', 'nope')),
    });
    render(<MonitorDetail id={m.id} client={client} />);
    expect(await screen.findByText('Monitor not found.')).toBeInTheDocument();
  });

  it('shows an alert on other errors and retries', async () => {
    const getMonitor = vi
      .fn()
      .mockRejectedValueOnce(new ApiClientError(0, 'NETWORK_ERROR', 'Network error'))
      .mockResolvedValueOnce(m);
    const client = fakeClient({ getMonitor, getUptime: vi.fn().mockResolvedValue(makeUptime()) });
    render(<MonitorDetail id={m.id} client={client} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Network error');
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('heading', { name: 'Alpha' })).toBeInTheDocument();
    expect(getMonitor).toHaveBeenCalledTimes(2);
  });

  it('toggles public and shows badge snippets only for public monitors', async () => {
    const updateMonitor = vi.fn().mockResolvedValue({ ...m, public: true });
    const client = fakeClient({
      getMonitor: vi.fn().mockResolvedValue(m),
      getUptime: vi.fn().mockResolvedValue(makeUptime()),
      updateMonitor,
    });
    render(<MonitorDetail id={m.id} client={client} />);
    await screen.findByRole('heading', { name: 'Alpha' });
    expect(screen.getByText('Make this monitor public to get a status badge.')).toBeInTheDocument();
    expect(screen.queryByLabelText('Uptime badge (Markdown)')).not.toBeInTheDocument();
    await userEvent.click(screen.getByLabelText('Show on public status page'));
    expect(updateMonitor).toHaveBeenCalledWith(m.id, { public: true });
    expect(await screen.findByLabelText('Uptime badge (Markdown)')).toHaveValue(
      `![uptime](${window.location.origin}/badge/${m.id}.svg)`,
    );
    expect(screen.getByLabelText('Status badge (Markdown)')).toBeInTheDocument();
    expect(screen.queryByText('Make this monitor public to get a status badge.')).toBeNull();
  });
});
