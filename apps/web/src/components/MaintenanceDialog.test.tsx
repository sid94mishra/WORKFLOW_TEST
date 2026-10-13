import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ApiClientError } from '../api/client';
import { fakeClient, makeMaintenance, makeMonitor } from '../test/fixtures';
import { MaintenanceDialog, isoToUtcInput, utcInputToIso } from './MaintenanceDialog';

const alpha = makeMonitor({ id: 'a1', name: 'Alpha' });
const beta = makeMonitor({ id: 'b2', name: 'Beta' });

function open(props: Partial<Parameters<typeof MaintenanceDialog>[0]> = {}, clientOver = {}) {
  const client = fakeClient({
    createMaintenance: vi.fn().mockResolvedValue(makeMaintenance()),
    updateMaintenance: vi.fn().mockResolvedValue(makeMaintenance()),
    ...clientOver,
  });
  const onSaved = vi.fn();
  const onClose = vi.fn();
  render(
    <MaintenanceDialog
      monitors={[alpha, beta]}
      client={client}
      onSaved={onSaved}
      onClose={onClose}
      {...props}
    />,
  );
  return { client, onSaved, onClose, dialog: screen.getByRole('dialog') };
}

const fillBasics = (dialog: HTMLElement) => {
  fireEvent.change(within(dialog).getByLabelText('Title'), { target: { value: 'Backup' } });
  fireEvent.change(within(dialog).getByLabelText(/^(Starts|Repeat from)/), {
    target: { value: '2026-10-13T00:00' },
  });
  fireEvent.change(within(dialog).getByLabelText(/^(Ends|Repeat until)/), {
    target: { value: '2027-10-13T00:00' },
  });
};

describe('UTC conversion helpers', () => {
  it('reads datetime-local values as UTC regardless of the process time zone', () => {
    expect(utcInputToIso('2026-10-20T01:00')).toBe('2026-10-20T01:00:00.000Z');
    expect(utcInputToIso('2026-10-20T01:00:30')).toBe('2026-10-20T01:00:30.000Z');
    expect(utcInputToIso('')).toBeNull();
    expect(utcInputToIso('2026-13-40T99:00')).toBeNull();
    expect(isoToUtcInput('2026-10-20T23:30:00.000Z')).toBe('2026-10-20T23:30');
  });
});

describe('MaintenanceDialog', () => {
  it('is a labelled modal with focus on Title; Escape and Cancel close it', async () => {
    const { dialog, onClose } = open();
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleName('Schedule maintenance');
    expect(within(dialog).getByLabelText('Title')).toHaveFocus();
    expect(
      within(dialog).getByText('Shown on the public status page if a public monitor is affected.'),
    ).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('validates required fields without calling the API', async () => {
    const { client, dialog } = open();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
    expect(within(dialog).getByLabelText('Title')).toHaveAttribute('aria-invalid', 'true');
    expect(within(dialog).getByText('Title is required')).toBeInTheDocument();
    expect(within(dialog).getByText(/Select at least one monitor/)).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Starts (UTC)')).toHaveAttribute('aria-invalid', 'true');
    expect(client.createMaintenance).not.toHaveBeenCalled();
  });

  it('hides the monitor list when All monitors is checked', async () => {
    const { dialog } = open();
    expect(within(dialog).getByRole('checkbox', { name: 'Alpha' })).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('checkbox', { name: 'All monitors' }));
    expect(within(dialog).queryByRole('checkbox', { name: 'Alpha' })).toBeNull();
  });

  it('sends selected monitor ids for a one-off window', async () => {
    const { client, dialog } = open();
    fillBasics(dialog);
    await userEvent.click(within(dialog).getByRole('checkbox', { name: 'Beta' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(client.createMaintenance).toHaveBeenCalled());
    expect(client.createMaintenance).toHaveBeenCalledWith({
      title: 'Backup',
      monitorIds: ['b2'],
      startsAt: '2026-10-13T00:00:00.000Z',
      endsAt: '2027-10-13T00:00:00.000Z',
      repeat: null,
    });
  });

  it('builds the weekly repeat from the inputs', async () => {
    const { client, dialog } = open();
    await userEvent.click(within(dialog).getByRole('checkbox', { name: 'All monitors' }));
    await userEvent.click(within(dialog).getByRole('checkbox', { name: 'Repeat weekly' }));
    expect(within(dialog).getByLabelText('Repeat from (UTC)')).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Repeat until (UTC)')).toBeInTheDocument();
    fillBasics(dialog);
    await userEvent.click(within(dialog).getByRole('checkbox', { name: 'Sat' }));
    await userEvent.click(within(dialog).getByRole('checkbox', { name: 'Sun' }));
    fireEvent.change(within(dialog).getByLabelText('Start time (UTC)'), {
      target: { value: '23:30' },
    });
    fireEvent.change(within(dialog).getByLabelText('Duration hours'), { target: { value: '1' } });
    fireEvent.change(within(dialog).getByLabelText('Duration minutes'), {
      target: { value: '30' },
    });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(client.createMaintenance).toHaveBeenCalled());
    expect(client.createMaintenance).toHaveBeenCalledWith({
      title: 'Backup',
      monitorIds: 'all',
      startsAt: '2026-10-13T00:00:00.000Z',
      endsAt: '2027-10-13T00:00:00.000Z',
      repeat: { weekdays: [0, 6], startTime: '23:30', durationMinutes: 90 },
    });
  });

  it('requires a weekday when repeating weekly', async () => {
    const { client, dialog } = open();
    await userEvent.click(within(dialog).getByRole('checkbox', { name: 'All monitors' }));
    await userEvent.click(within(dialog).getByRole('checkbox', { name: 'Repeat weekly' }));
    fillBasics(dialog);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
    expect(within(dialog).getByText('Select at least one weekday')).toBeInTheDocument();
    expect(client.createMaintenance).not.toHaveBeenCalled();
  });

  it('shows Saving… and disables controls while submitting', async () => {
    let resolve!: (w: ReturnType<typeof makeMaintenance>) => void;
    const createMaintenance = vi.fn(
      () => new Promise<ReturnType<typeof makeMaintenance>>((r) => (resolve = r)),
    );
    const { dialog, onSaved } = open({}, { createMaintenance });
    await userEvent.click(within(dialog).getByRole('checkbox', { name: 'All monitors' }));
    fillBasics(dialog);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
    const saving = await within(dialog).findByRole('button', { name: 'Saving…' });
    expect(saving).toBeDisabled();
    expect(within(dialog).getByLabelText('Title')).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeDisabled();
    resolve(makeMaintenance());
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });

  it('shows a non-field error in an alert inside the dialog', async () => {
    const createMaintenance = vi
      .fn()
      .mockRejectedValue(new ApiClientError(500, 'INTERNAL_ERROR', 'Server exploded'));
    const { dialog, onSaved } = open({}, { createMaintenance });
    await userEvent.click(within(dialog).getByRole('checkbox', { name: 'All monitors' }));
    fillBasics(dialog);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Server exploded');
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('maps a monitorIds issue to the Monitors group', async () => {
    const createMaintenance = vi
      .fn()
      .mockRejectedValue(
        new ApiClientError(400, 'VALIDATION_ERROR', 'Invalid', [
          { path: ['monitorIds', 0], code: 'custom', message: 'monitor not found' },
        ]),
      );
    const { dialog } = open({}, { createMaintenance });
    fillBasics(dialog);
    await userEvent.click(within(dialog).getByRole('checkbox', { name: 'Alpha' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
    expect(await within(dialog).findByText('monitor not found')).toBeInTheDocument();
  });

  describe('editing', () => {
    const weekly = makeMaintenance({
      title: 'Nightly',
      monitorIds: 'all',
      startsAt: '2026-10-13T00:00:00.000Z',
      endsAt: '2027-10-13T00:00:00.000Z',
      repeat: { weekdays: [0, 6], startTime: '23:30', durationMinutes: 90 },
    });

    it('pre-fills the weekly fields and sends nothing when unchanged', async () => {
      const { client, dialog, onClose } = open({ item: weekly });
      expect(dialog).toHaveAccessibleName('Edit maintenance');
      expect(within(dialog).getByRole('checkbox', { name: 'All monitors' })).toBeChecked();
      expect(within(dialog).getByRole('checkbox', { name: 'Repeat weekly' })).toBeChecked();
      expect(within(dialog).getByRole('checkbox', { name: 'Sat' })).toBeChecked();
      expect(within(dialog).getByRole('checkbox', { name: 'Mon' })).not.toBeChecked();
      expect(within(dialog).getByLabelText('Start time (UTC)')).toHaveValue('23:30');
      expect(within(dialog).getByLabelText('Duration hours')).toHaveValue(1);
      expect(within(dialog).getByLabelText('Duration minutes')).toHaveValue(30);
      await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
      expect(client.updateMaintenance).not.toHaveBeenCalled();
      expect(onClose).toHaveBeenCalled();
    });

    it('PATCHes only the changed repeat when a weekday is added', async () => {
      const { client, dialog } = open({ item: weekly });
      await userEvent.click(within(dialog).getByRole('checkbox', { name: 'Mon' }));
      await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(client.updateMaintenance).toHaveBeenCalled());
      expect(client.updateMaintenance).toHaveBeenCalledWith(weekly.id, {
        repeat: { weekdays: [0, 1, 6], startTime: '23:30', durationMinutes: 90 },
      });
    });

    it('sends repeat: null when Repeat weekly is switched off', async () => {
      const { client, dialog } = open({ item: weekly });
      await userEvent.click(within(dialog).getByRole('checkbox', { name: 'Repeat weekly' }));
      await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(client.updateMaintenance).toHaveBeenCalled());
      expect(client.updateMaintenance).toHaveBeenCalledWith(weekly.id, { repeat: null });
    });

    it('PATCHes monitorIds and endsAt when those change', async () => {
      const oneOff = makeMaintenance({ monitorIds: 'all' });
      const { client, dialog } = open({ item: oneOff });
      await userEvent.click(within(dialog).getByRole('checkbox', { name: 'All monitors' }));
      await userEvent.click(within(dialog).getByRole('checkbox', { name: 'Alpha' }));
      fireEvent.change(within(dialog).getByLabelText('Ends (UTC)'), {
        target: { value: '2026-10-20T04:15' },
      });
      await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(client.updateMaintenance).toHaveBeenCalled());
      expect(client.updateMaintenance).toHaveBeenCalledWith(oneOff.id, {
        monitorIds: ['a1'],
        endsAt: '2026-10-20T04:15:00.000Z',
      });
    });
  });
});
