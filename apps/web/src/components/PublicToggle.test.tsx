import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ApiClientError } from '../api/client';
import { fakeClient, makeMonitor } from '../test/fixtures';
import { PublicToggle } from './PublicToggle';

describe('PublicToggle', () => {
  it('toggles public, disabled while saving, and reports the server response', async () => {
    const m = makeMonitor();
    let resolve!: (v: unknown) => void;
    const updateMonitor = vi.fn().mockReturnValue(new Promise((r) => (resolve = r)));
    const onChange = vi.fn();
    render(<PublicToggle monitor={m} onChange={onChange} client={fakeClient({ updateMonitor })} />);
    const box = screen.getByLabelText('Show on public status page');
    expect(box).not.toBeChecked();
    await userEvent.click(box);
    expect(updateMonitor).toHaveBeenCalledWith(m.id, { public: true });
    expect(box).toBeDisabled();
    resolve({ ...m, public: true });
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledWith({ ...m, public: true }));
    expect(box).toBeEnabled();
  });

  it('stays unchanged and shows an alert on error', async () => {
    const m = makeMonitor({ public: true });
    const updateMonitor = vi
      .fn()
      .mockRejectedValue(new ApiClientError(500, 'INTERNAL_ERROR', 'boom'));
    const onChange = vi.fn();
    render(<PublicToggle monitor={m} onChange={onChange} client={fakeClient({ updateMonitor })} />);
    const box = screen.getByLabelText('Show on public status page');
    await userEvent.click(box);
    expect(updateMonitor).toHaveBeenCalledWith(m.id, { public: false });
    expect(await screen.findByRole('alert')).toHaveTextContent('boom');
    expect(box).toBeChecked();
    expect(onChange).not.toHaveBeenCalled();
  });
});
