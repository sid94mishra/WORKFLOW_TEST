import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ApiClientError } from '../api/client';
import { fakeClient, makeChannel, makeMonitor } from '../test/fixtures';
import { ChannelForm } from './ChannelForm';

const monitors = [
  makeMonitor({ id: 'm1', name: 'Alpha' }),
  makeMonitor({ id: 'm2', name: 'Beta' }),
];

describe('ChannelForm', () => {
  it('creates a channel with selected monitors', async () => {
    const created = makeChannel();
    const createChannel = vi.fn().mockResolvedValue(created);
    const onSaved = vi.fn();
    render(
      <ChannelForm
        monitors={monitors}
        onSaved={onSaved}
        onCancel={vi.fn()}
        client={fakeClient({ createChannel })}
      />,
    );
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: ' Ops ' } });
    await userEvent.selectOptions(screen.getByLabelText('Type'), 'slack');
    fireEvent.change(screen.getByLabelText('Webhook URL'), {
      target: { value: 'https://hooks.slack.com/x' },
    });
    await userEvent.click(screen.getByRole('checkbox', { name: 'Beta' }));
    await userEvent.click(screen.getByRole('button', { name: 'Add channel' }));
    expect(createChannel).toHaveBeenCalledWith({
      name: 'Ops',
      kind: 'slack',
      url: 'https://hooks.slack.com/x',
      enabled: true,
      monitorIds: ['m2'],
    });
    expect(onSaved).toHaveBeenCalledWith(created);
  });

  it('validates on the client without calling the API', async () => {
    const createChannel = vi.fn();
    render(
      <ChannelForm
        monitors={[]}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
        client={fakeClient({ createChannel })}
      />,
    );
    expect(screen.getByText('No monitors yet.')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Webhook URL'), { target: { value: 'ftp://x' } });
    await userEvent.click(screen.getByRole('button', { name: 'Add channel' }));
    expect(screen.getByLabelText('Name')).toBeInvalid();
    expect(screen.getByLabelText('Webhook URL')).toBeInvalid();
    expect(createChannel).not.toHaveBeenCalled();
  });

  it('edits sending only changed fields', async () => {
    const channel = makeChannel({ monitorIds: ['m1'] });
    const updateChannel = vi.fn().mockResolvedValue({ ...channel, name: 'Renamed' });
    render(
      <ChannelForm
        channel={channel}
        monitors={monitors}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
        client={fakeClient({ updateChannel })}
      />,
    );
    expect(screen.getByRole('checkbox', { name: 'Alpha' })).toBeChecked();
    const name = screen.getByLabelText('Name');
    await userEvent.clear(name);
    fireEvent.change(name, { target: { value: 'Renamed' } });
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(updateChannel).toHaveBeenCalledWith(channel.id, { name: 'Renamed' });
  });

  it('maps a server 400 at [url] under the Webhook URL field', async () => {
    const createChannel = vi
      .fn()
      .mockRejectedValue(
        new ApiClientError(400, 'VALIDATION_ERROR', 'Invalid', [
          { code: 'custom', path: ['url'], message: 'blocked address: 127.0.0.1 (loopback)' },
        ]),
      );
    render(
      <ChannelForm
        monitors={[]}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
        client={fakeClient({ createChannel })}
      />,
    );
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'x' } });
    fireEvent.change(screen.getByLabelText('Webhook URL'), {
      target: { value: 'http://127.0.0.1/h' },
    });
    await userEvent.click(screen.getByRole('button', { name: 'Add channel' }));
    const url = await screen.findByLabelText('Webhook URL');
    expect(url).toBeInvalid();
    expect(url).toHaveAccessibleDescription('blocked address: 127.0.0.1 (loopback)');
    expect(url).toHaveFocus();
  });

  it('shows Saving… while pending and a form alert on other errors; Cancel works', async () => {
    let reject!: (e: unknown) => void;
    const createChannel = vi.fn().mockReturnValue(new Promise((_, r) => (reject = r)));
    const onCancel = vi.fn();
    render(
      <ChannelForm
        monitors={[]}
        onSaved={vi.fn()}
        onCancel={onCancel}
        client={fakeClient({ createChannel })}
      />,
    );
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'x' } });
    fireEvent.change(screen.getByLabelText('Webhook URL'), {
      target: { value: 'https://example.com/h' },
    });
    await userEvent.click(screen.getByRole('button', { name: 'Add channel' }));
    expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled();
    reject(new ApiClientError(500, 'INTERNAL_ERROR', 'boom'));
    expect(await screen.findByRole('alert')).toHaveTextContent('boom');
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalled();
  });
});
