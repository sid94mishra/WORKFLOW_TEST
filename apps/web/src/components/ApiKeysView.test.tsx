import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiClientError } from '../api/client';
import { fakeClient, makeApiKey } from '../test/fixtures';
import { ApiKeysView } from './ApiKeysView';

const KEY = `pulse_${'A'.repeat(43)}`;
const created = (over = {}) => ({ ...makeApiKey({ name: 'Deploy' }), key: KEY, ...over });

let writeText: ReturnType<typeof vi.fn>;
let user: ReturnType<typeof userEvent.setup>;
beforeEach(() => {
  user = userEvent.setup();
  writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
  });
});
afterEach(() => vi.useRealTimers());

describe('ApiKeysView', () => {
  it('shows loading then the empty state', async () => {
    render(<ApiKeysView client={fakeClient()} />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading API keys…');
    expect(await screen.findByText('No API keys yet.')).toBeInTheDocument();
  });

  it('shows an error with Retry', async () => {
    const listApiKeys = vi
      .fn()
      .mockRejectedValueOnce(new ApiClientError(500, 'INTERNAL_ERROR', 'boom'))
      .mockResolvedValueOnce([makeApiKey({ name: 'CI', scope: 'write', lastUsedAt: null })]);
    render(<ApiKeysView client={fakeClient({ listApiKeys })} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('boom');
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    const table = await screen.findByRole('table', { name: 'API keys' });
    expect(within(table).getByText('Read & write')).toBeInTheDocument();
    expect(within(table).getByText('pulse_abc123…')).toBeInTheDocument();
    expect(within(table).getByText('Never')).toBeInTheDocument();
  });

  it('creates a key, shows it once, copies it and clears it on Done', async () => {
    let resolve!: (v: ReturnType<typeof created>) => void;
    const createApiKey = vi.fn().mockReturnValue(new Promise((r) => (resolve = r)));
    render(<ApiKeysView client={fakeClient({ createApiKey })} />);
    await screen.findByText('No API keys yet.');
    expect(screen.getByRole('radio', { name: 'Read only' })).toBeChecked();
    await user.type(screen.getByLabelText('Name'), 'Deploy');
    await user.click(screen.getByRole('button', { name: 'Create key' }));
    expect(screen.getByRole('button', { name: 'Creating…' })).toBeDisabled();
    expect(createApiKey).toHaveBeenCalledWith({ name: 'Deploy', scope: 'read' });
    await act(async () => resolve(created()));

    const panel = screen.getByRole('region', { name: 'New API key' });
    expect(within(panel).getByDisplayValue(KEY)).toHaveAttribute('readonly');
    expect(screen.getByRole('table')).toHaveTextContent('Deploy');
    expect(screen.getByRole('table')).not.toHaveTextContent(KEY);

    vi.useFakeTimers({ shouldAdvanceTime: true });
    await user.click(within(panel).getByRole('button', { name: 'Copy' }));
    expect(writeText).toHaveBeenCalledWith(KEY);
    expect(within(panel).getByRole('button', { name: 'Copied' })).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(2100));
    expect(within(panel).getByRole('button', { name: 'Copy' })).toBeInTheDocument();

    await user.click(within(panel).getByRole('button', { name: 'Done' }));
    expect(screen.queryByDisplayValue(KEY)).toBeNull();
    expect(document.body).not.toHaveTextContent(KEY);
  });

  it('sends the chosen write scope', async () => {
    const createApiKey = vi.fn().mockResolvedValue(created({ scope: 'write' }));
    render(<ApiKeysView client={fakeClient({ createApiKey })} />);
    await screen.findByText('No API keys yet.');
    await user.type(screen.getByLabelText('Name'), 'W');
    await user.click(screen.getByRole('radio', { name: 'Read & write' }));
    await user.click(screen.getByRole('button', { name: 'Create key' }));
    expect(createApiKey).toHaveBeenCalledWith({ name: 'W', scope: 'write' });
  });

  it('shows fallback text when the clipboard rejects', async () => {
    writeText.mockRejectedValue(new Error('denied'));
    render(
      <ApiKeysView client={fakeClient({ createApiKey: vi.fn().mockResolvedValue(created()) })} />,
    );
    await screen.findByText('No API keys yet.');
    await user.type(screen.getByLabelText('Name'), 'Deploy');
    await user.click(screen.getByRole('button', { name: 'Create key' }));
    await user.click(await screen.findByRole('button', { name: 'Copy' }));
    expect(await screen.findByText('Copy failed — select and copy manually')).toBeInTheDocument();
  });

  it('shows a server name error inline with aria-invalid', async () => {
    const createApiKey = vi
      .fn()
      .mockRejectedValue(
        new ApiClientError(400, 'VALIDATION_ERROR', 'Invalid', [
          { path: ['name'], message: 'Too long', code: 'too_big' },
        ]),
      );
    render(<ApiKeysView client={fakeClient({ createApiKey })} />);
    await screen.findByText('No API keys yet.');
    await user.type(screen.getByLabelText('Name'), 'x');
    await user.click(screen.getByRole('button', { name: 'Create key' }));
    const input = screen.getByLabelText('Name');
    expect(await screen.findByText('Too long')).toBeInTheDocument();
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription('Too long');
  });

  it('requires a name client-side', async () => {
    const createApiKey = vi.fn();
    render(<ApiKeysView client={fakeClient({ createApiKey })} />);
    await screen.findByText('No API keys yet.');
    await user.click(screen.getByRole('button', { name: 'Create key' }));
    expect(screen.getByLabelText('Name')).toHaveAttribute('aria-invalid', 'true');
    expect(createApiKey).not.toHaveBeenCalled();
  });

  it('revokes after confirmation, showing Revoking…', async () => {
    const key = makeApiKey({ name: 'Old' });
    let resolve!: () => void;
    const revokeApiKey = vi.fn().mockReturnValue(new Promise<void>((r) => (resolve = r)));
    render(
      <ApiKeysView
        client={fakeClient({ listApiKeys: vi.fn().mockResolvedValue([key]), revokeApiKey })}
      />,
    );
    await user.click(await screen.findByRole('button', { name: 'Revoke Old' }));
    expect(screen.getByText('Revoke Old? Apps using it will stop working.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Revoke key' }));
    expect(screen.getByRole('button', { name: 'Revoking…' })).toBeDisabled();
    await act(async () => resolve());
    expect(revokeApiKey).toHaveBeenCalledWith(key.id);
    expect(screen.queryByText('Old')).toBeNull();
  });

  it('cancels a revoke and keeps the row with an alert when revoke fails', async () => {
    const key = makeApiKey({ name: 'Old' });
    const revokeApiKey = vi.fn().mockRejectedValue(new ApiClientError(500, 'INTERNAL_ERROR', 'x'));
    render(
      <ApiKeysView
        client={fakeClient({ listApiKeys: vi.fn().mockResolvedValue([key]), revokeApiKey })}
      />,
    );
    await user.click(await screen.findByRole('button', { name: 'Revoke Old' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(revokeApiKey).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Revoke Old' }));
    await user.click(screen.getByRole('button', { name: 'Revoke key' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Couldn\'t revoke "Old"');
    expect(screen.getByText('Old')).toBeInTheDocument();
  });
});
