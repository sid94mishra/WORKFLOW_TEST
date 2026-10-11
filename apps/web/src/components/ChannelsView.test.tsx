import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ApiClientError } from '../api/client';
import { fakeClient, makeChannel, makeMonitor } from '../test/fixtures';
import { ChannelsView } from './ChannelsView';

const attempt = (over: object) => ({
  id: 'a',
  channelId: 'c',
  incidentId: null,
  event: 'test',
  attempt: 1,
  attemptedAt: '2026-10-11T09:30:00.000Z',
  ok: true,
  statusCode: 200,
  latencyMs: 5,
  error: null,
  ...over,
});

describe('ChannelsView', () => {
  it('shows loading, then a table with the URL masked to its origin', async () => {
    const client = fakeClient({
      listChannels: vi.fn().mockResolvedValue([
        makeChannel({
          url: 'https://hooks.slack.com/services/T/B/SECRET',
          monitorIds: ['a', 'b'],
        }),
      ]),
    });
    render(<ChannelsView client={client} />);
    expect(screen.getByText('Loading channels…')).toBeInTheDocument();
    const table = await screen.findByRole('table', { name: 'Notification channels' });
    expect(within(table).getByText('https://hooks.slack.com/…')).toBeInTheDocument();
    expect(table).not.toHaveTextContent('SECRET');
    expect(within(table).getByText('Slack')).toBeInTheDocument();
    expect(within(table).getByText('Enabled')).toBeInTheDocument();
    expect(within(table).getByText('2')).toBeInTheDocument();
  });

  it('shows the empty state and opens the add form', async () => {
    const client = fakeClient({ listMonitors: vi.fn().mockResolvedValue([makeMonitor()]) });
    render(<ChannelsView client={client} />);
    expect(
      await screen.findByText(
        'No channels yet. Add a webhook or Slack channel to get notified about incidents.',
      ),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Add channel' }));
    expect(screen.getByRole('form', { name: 'Add channel' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Example' })).toBeInTheDocument();
  });

  it('adds a created channel to the table', async () => {
    const createChannel = vi.fn().mockResolvedValue(makeChannel({ name: 'Fresh' }));
    render(<ChannelsView client={fakeClient({ createChannel })} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Add channel' }));
    await userEvent.type(screen.getByLabelText('Name'), 'Fresh');
    await userEvent.type(screen.getByLabelText('Webhook URL'), 'https://example.com/h');
    await userEvent.click(screen.getByRole('button', { name: 'Add channel' }));
    expect(await screen.findByText('Fresh')).toBeInTheDocument();
    expect(screen.queryByRole('form')).not.toBeInTheDocument();
  });

  it('shows an error with Retry', async () => {
    const listChannels = vi
      .fn()
      .mockRejectedValueOnce(new ApiClientError(0, 'NETWORK_ERROR', 'Network error'))
      .mockResolvedValueOnce([makeChannel()]);
    render(<ChannelsView client={fakeClient({ listChannels })} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Network error');
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Ops Slack')).toBeInTheDocument();
  });

  it('Send test shows Sending… then the delivery result', async () => {
    let resolve!: (v: unknown) => void;
    const testChannel = vi
      .fn()
      .mockReturnValueOnce(new Promise((r) => (resolve = r)))
      .mockResolvedValueOnce(attempt({ ok: false, statusCode: 500, error: 'HTTP 500' }))
      .mockRejectedValueOnce(new ApiClientError(404, 'NOT_FOUND', 'Channel not found'));
    const client = fakeClient({
      listChannels: vi.fn().mockResolvedValue([makeChannel()]),
      testChannel,
    });
    render(<ChannelsView client={client} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Send test' }));
    expect(screen.getByRole('button', { name: 'Sending…' })).toBeDisabled();
    resolve(attempt({}));
    expect(await screen.findByText('Delivered (HTTP 200)')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Send test' }));
    expect(await screen.findByText('Failed: HTTP 500')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Send test' }));
    expect(await screen.findByText('Failed: Channel not found')).toBeInTheDocument();
  });

  it('requires inline confirmation to delete, and removes the row', async () => {
    const deleteChannel = vi.fn().mockResolvedValue(undefined);
    const client = fakeClient({
      listChannels: vi.fn().mockResolvedValue([makeChannel()]),
      deleteChannel,
    });
    render(<ChannelsView client={client} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    expect(deleteChannel).not.toHaveBeenCalled();
    expect(screen.getByText('Delete "Ops Slack"?')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByText('Delete "Ops Slack"?')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await userEvent.click(within(screen.getByRole('table')).getAllByRole('button')[0]!);
    expect(deleteChannel).toHaveBeenCalledWith('20000000-0000-4000-8000-000000000001');
    expect(await screen.findByText(/No channels yet/)).toBeInTheDocument();
  });

  it('alerts when delete fails and keeps the row', async () => {
    const client = fakeClient({
      listChannels: vi.fn().mockResolvedValue([makeChannel()]),
      deleteChannel: vi.fn().mockRejectedValue(new ApiClientError(500, 'INTERNAL_ERROR', 'boom')),
    });
    render(<ChannelsView client={client} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    await userEvent.click(within(screen.getByRole('table')).getAllByRole('button')[0]!);
    expect(await screen.findByRole('alert')).toHaveTextContent('boom');
    expect(screen.getByText('Ops Slack')).toBeInTheDocument();
  });

  it('edits a channel inline and updates the row', async () => {
    const updateChannel = vi.fn().mockResolvedValue(makeChannel({ name: 'Renamed' }));
    const client = fakeClient({
      listChannels: vi.fn().mockResolvedValue([makeChannel()]),
      updateChannel,
    });
    render(<ChannelsView client={client} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    const name = screen.getByLabelText('Name');
    expect(name).toHaveValue('Ops Slack');
    await userEvent.clear(name);
    await userEvent.type(name, 'Renamed');
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Renamed')).toBeInTheDocument();
    expect(updateChannel).toHaveBeenCalledWith(expect.any(String), { name: 'Renamed' });
  });
});
