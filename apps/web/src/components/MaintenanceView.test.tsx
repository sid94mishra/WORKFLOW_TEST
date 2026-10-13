import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ApiClientError } from '../api/client';
import { fakeClient, makeMaintenance, makeMonitor } from '../test/fixtures';
import { MaintenanceView, describeSchedule } from './MaintenanceView';

const alpha = makeMonitor({ id: 'a1', name: 'Alpha' });
const beta = makeMonitor({ id: 'b2', name: 'Beta' });

const validation = (path: (string | number)[], message: string) =>
  new ApiClientError(400, 'VALIDATION_ERROR', 'Invalid request', [
    { path, code: 'custom', message },
  ]);

function setup(over: Parameters<typeof fakeClient>[0] = {}) {
  const client = fakeClient({ listMonitors: vi.fn().mockResolvedValue([alpha, beta]), ...over });
  render(<MaintenanceView client={client} />);
  return client;
}

describe('MaintenanceView', () => {
  it('shows loading, then the empty state with a Schedule button', async () => {
    setup();
    expect(screen.getByRole('status')).toHaveTextContent('Loading maintenance…');
    expect(await screen.findByText('No maintenance windows yet.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Schedule maintenance' })).toBeInTheDocument();
  });

  it('shows an error alert and Retry reloads', async () => {
    const listMaintenance = vi
      .fn()
      .mockRejectedValueOnce(new ApiClientError(0, 'NETWORK_ERROR', 'Network error'))
      .mockResolvedValueOnce([makeMaintenance({ title: 'Reboot' })]);
    setup({ listMaintenance });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      "Couldn't load maintenance: Network error",
    );
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Reboot')).toBeInTheDocument();
  });

  it('renders rows: monitor names, unknown ids, all, schedule and status', async () => {
    setup({
      listMaintenance: vi.fn().mockResolvedValue([
        makeMaintenance({ title: 'One', monitorIds: ['a1', 'zz'], active: true }),
        makeMaintenance({
          title: 'Two',
          monitorIds: 'all',
          startsAt: '2026-10-13T00:00:00.000Z',
          endsAt: '2027-10-13T00:00:00.000Z',
          repeat: { weekdays: [0, 6], startTime: '23:30', durationMinutes: 90 },
          nextOccurrence: {
            startsAt: '2026-10-17T23:30:00.000Z',
            endsAt: '2026-10-18T01:00:00.000Z',
          },
        }),
        makeMaintenance({ title: 'Three', nextOccurrence: null }),
      ]),
    });
    const table = await screen.findByRole('table', { name: 'Maintenance windows' });
    const rows = within(table).getAllByRole('row');
    expect(within(rows[1]!).getByText('Alpha, Unknown monitor')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('Active')).toBeInTheDocument();
    expect(
      within(rows[1]!).getByText('2026-10-20 01:00 – 2026-10-20 03:00 UTC'),
    ).toBeInTheDocument();
    expect(within(rows[2]!).getByText('All monitors')).toBeInTheDocument();
    expect(
      within(rows[2]!).getByText('Sun, Sat 23:30 UTC for 1 h 30 min · until 2027-10-13'),
    ).toBeInTheDocument();
    expect(within(rows[2]!).getByText('Next: 2026-10-17 23:30 UTC')).toBeInTheDocument();
    expect(within(rows[3]!).getByText('Ended')).toBeInTheDocument();
  });

  it('describeSchedule formats whole hours and minutes only', () => {
    const w = makeMaintenance({
      repeat: { weekdays: [1], startTime: '02:00', durationMinutes: 120 },
    });
    expect(describeSchedule(w)).toBe('Mon 02:00 UTC for 2 h · until 2026-10-20');
    expect(
      describeSchedule({ ...w, repeat: { weekdays: [1], startTime: '02:00', durationMinutes: 5 } }),
    ).toBe('Mon 02:00 UTC for 5 min · until 2026-10-20');
  });

  it('creates a window, closes the dialog and shows the new row first', async () => {
    const created = makeMaintenance({ title: 'New window' });
    const existing = makeMaintenance({ title: 'Old window' });
    const createMaintenance = vi.fn().mockResolvedValue(created);
    setup({ listMaintenance: vi.fn().mockResolvedValue([existing]), createMaintenance });
    await screen.findByText('Old window');
    await userEvent.click(screen.getByRole('button', { name: 'Schedule maintenance' }));
    const dialog = await screen.findByRole('dialog', { name: 'Schedule maintenance' });
    fireEvent.change(within(dialog).getByLabelText('Title'), { target: { value: 'New window' } });
    await userEvent.click(within(dialog).getByRole('checkbox', { name: 'All monitors' }));
    fireEvent.change(within(dialog).getByLabelText('Starts (UTC)'), {
      target: { value: '2026-10-20T01:00' },
    });
    fireEvent.change(within(dialog).getByLabelText('Ends (UTC)'), {
      target: { value: '2026-10-20T03:00' },
    });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(createMaintenance).toHaveBeenCalledWith({
      title: 'New window',
      monitorIds: 'all',
      startsAt: '2026-10-20T01:00:00.000Z',
      endsAt: '2026-10-20T03:00:00.000Z',
      repeat: null,
    });
    const rows = within(screen.getByRole('table')).getAllByRole('row');
    expect(rows[1]).toHaveTextContent('New window');
    expect(rows[2]).toHaveTextContent('Old window');
  });

  it('opens Edit pre-filled and replaces the row after a PATCH with only changed fields', async () => {
    const w = makeMaintenance({ title: 'Upgrade', monitorIds: ['a1'] });
    const updated = { ...w, title: 'Upgrade v2' };
    const updateMaintenance = vi.fn().mockResolvedValue(updated);
    setup({ listMaintenance: vi.fn().mockResolvedValue([w]), updateMaintenance });
    await userEvent.click(await screen.findByRole('button', { name: 'Edit Upgrade' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit maintenance' });
    expect(within(dialog).getByLabelText('Title')).toHaveValue('Upgrade');
    expect(within(dialog).getByLabelText('Starts (UTC)')).toHaveValue('2026-10-20T01:00');
    expect(within(dialog).getByLabelText('Ends (UTC)')).toHaveValue('2026-10-20T03:00');
    expect(within(dialog).getByRole('checkbox', { name: 'Alpha' })).toBeChecked();
    expect(within(dialog).getByRole('checkbox', { name: 'Beta' })).not.toBeChecked();
    fireEvent.change(within(dialog).getByLabelText('Title'), { target: { value: 'Upgrade v2' } });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(updateMaintenance).toHaveBeenCalledWith(w.id, { title: 'Upgrade v2' });
    expect(await screen.findByText('Upgrade v2')).toBeInTheDocument();
  });

  it('requires confirmation, shows Deleting…, then removes the row', async () => {
    const w = makeMaintenance({ title: 'Doomed' });
    let resolve!: () => void;
    const deleteMaintenance = vi.fn(() => new Promise<void>((r) => (resolve = r)));
    setup({ listMaintenance: vi.fn().mockResolvedValue([w]), deleteMaintenance });
    await userEvent.click(await screen.findByRole('button', { name: 'Delete Doomed' }));
    expect(deleteMaintenance).not.toHaveBeenCalled();
    expect(
      screen.getByText('Delete Doomed? Alerts for its monitors resume immediately.'),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Delete window' }));
    expect(await screen.findByRole('button', { name: 'Deleting…' })).toBeDisabled();
    expect(deleteMaintenance).toHaveBeenCalledWith(w.id);
    resolve();
    await waitFor(() => expect(screen.queryByText('Doomed')).toBeNull());
    expect(screen.getByText('No maintenance windows yet.')).toBeInTheDocument();
  });

  it('cancelling the confirmation keeps the row', async () => {
    const deleteMaintenance = vi.fn();
    setup({
      listMaintenance: vi.fn().mockResolvedValue([makeMaintenance({ title: 'Keep' })]),
      deleteMaintenance,
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Delete Keep' }));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('button', { name: 'Delete Keep' })).toBeInTheDocument();
    expect(deleteMaintenance).not.toHaveBeenCalled();
  });

  it('moves focus to the confirm button and back to Delete on Cancel', async () => {
    setup({ listMaintenance: vi.fn().mockResolvedValue([makeMaintenance({ title: 'Focus' })]) });
    await userEvent.click(await screen.findByRole('button', { name: 'Delete Focus' }));
    expect(screen.getByRole('button', { name: 'Delete window' })).toHaveFocus();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('button', { name: 'Delete Focus' })).toHaveFocus();
  });

  it('keeps focus in the row after a failed delete', async () => {
    const deleteMaintenance = vi
      .fn()
      .mockRejectedValue(new ApiClientError(500, 'INTERNAL_ERROR', 'Boom'));
    setup({
      listMaintenance: vi.fn().mockResolvedValue([makeMaintenance({ title: 'Sticky' })]),
      deleteMaintenance,
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Delete Sticky' }));
    await userEvent.click(screen.getByRole('button', { name: 'Delete window' }));
    await screen.findByRole('alert');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Delete window' })).toHaveFocus(),
    );
  });

  it('keeps the row and shows an alert when delete fails', async () => {
    const deleteMaintenance = vi
      .fn()
      .mockRejectedValue(new ApiClientError(500, 'INTERNAL_ERROR', 'Boom'));
    setup({
      listMaintenance: vi.fn().mockResolvedValue([makeMaintenance({ title: 'Stays' })]),
      deleteMaintenance,
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Delete Stays' }));
    await userEvent.click(screen.getByRole('button', { name: 'Delete window' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Couldn\'t delete "Stays": Boom');
    expect(screen.getByText('Stays')).toBeInTheDocument();
  });

  it('shows a 400 at endsAt under Ends with aria-invalid', async () => {
    const createMaintenance = vi
      .fn()
      .mockRejectedValue(validation(['endsAt'], 'endsAt must be after startsAt'));
    setup({ createMaintenance });
    await userEvent.click(await screen.findByRole('button', { name: 'Schedule maintenance' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Title'), { target: { value: 'X' } });
    await userEvent.click(within(dialog).getByRole('checkbox', { name: 'All monitors' }));
    fireEvent.change(within(dialog).getByLabelText('Starts (UTC)'), {
      target: { value: '2026-10-20T03:00' },
    });
    fireEvent.change(within(dialog).getByLabelText('Ends (UTC)'), {
      target: { value: '2026-10-20T01:00' },
    });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
    const ends = await within(dialog).findByLabelText('Ends (UTC)');
    await waitFor(() => expect(ends).toHaveAttribute('aria-invalid', 'true'));
    expect(within(dialog).getByText('endsAt must be after startsAt')).toBeInTheDocument();
    expect(ends).toHaveAccessibleDescription('endsAt must be after startsAt');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});
