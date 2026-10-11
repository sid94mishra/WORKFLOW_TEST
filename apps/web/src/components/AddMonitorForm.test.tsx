import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ApiClientError } from '../api/client';
import { AddMonitorForm } from './AddMonitorForm';
import { fakeClient, makeMonitor } from '../test/fixtures';

const LABELS = [
  'Name',
  'URL',
  'Method',
  'Check interval (seconds)',
  'Timeout (ms)',
  'Expected status',
  'Keyword (optional)',
  'Enabled',
];

describe('AddMonitorForm', () => {
  it('exposes every control by its label with defaults', () => {
    render(<AddMonitorForm onCreated={vi.fn()} client={fakeClient()} />);
    for (const l of LABELS) expect(screen.getByLabelText(l)).toBeInTheDocument();
    expect(screen.getByLabelText('Method')).toHaveValue('GET');
    expect(screen.getByLabelText('Check interval (seconds)')).toHaveValue(60);
    expect(screen.getByLabelText('Timeout (ms)')).toHaveValue(10000);
    expect(screen.getByLabelText('Expected status')).toHaveValue(200);
    expect(screen.getByLabelText('Enabled')).toBeChecked();
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });

  it('validates client-side: errors, aria wiring, focus on Name, no API call', async () => {
    const client = fakeClient();
    render(<AddMonitorForm onCreated={vi.fn()} client={client} />);
    await userEvent.click(screen.getByRole('button', { name: 'Add monitor' }));

    for (const [label, field] of [
      ['Name', 'name'],
      ['URL', 'url'],
    ] as const) {
      const input = screen.getByLabelText(label);
      expect(input).toHaveAttribute('aria-invalid', 'true');
      const errorId = input.getAttribute('aria-describedby');
      expect(errorId).toBe(`monitor-${field}-error`);
      expect(document.getElementById(errorId!)).toHaveTextContent(/\S/);
    }
    expect(screen.getByLabelText('Name')).toHaveFocus();
    expect(client.createMonitor).not.toHaveBeenCalled();
  });

  it('clears a field error when the field is edited', async () => {
    render(<AddMonitorForm onCreated={vi.fn()} client={fakeClient()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Add monitor' }));
    await userEvent.type(screen.getByLabelText('Name'), 'x');
    expect(screen.getByLabelText('Name')).not.toHaveAttribute('aria-invalid');
    expect(screen.getByLabelText('URL')).toHaveAttribute('aria-invalid', 'true');
  });

  it('maps server 400 issues to fields and focuses the first invalid one', async () => {
    const createMonitor = vi.fn().mockRejectedValue(
      new ApiClientError(400, 'VALIDATION_ERROR', 'Request validation failed', [
        { path: ['url'], message: 'Server says bad URL', code: 'invalid_format' },
        { path: [], message: 'Unrecognized key: "id"', code: 'unrecognized_keys' },
      ]),
    );
    render(<AddMonitorForm onCreated={vi.fn()} client={fakeClient({ createMonitor })} />);
    await userEvent.type(screen.getByLabelText('Name'), 'Site');
    await userEvent.type(screen.getByLabelText('URL'), 'https://site.test');
    await userEvent.click(screen.getByRole('button', { name: 'Add monitor' }));

    const url = screen.getByLabelText('URL');
    expect(url).toHaveAttribute('aria-invalid', 'true');
    expect(document.getElementById(url.getAttribute('aria-describedby')!)).toHaveTextContent(
      'Server says bad URL',
    );
    expect(url).toHaveFocus();
    expect(screen.getByRole('alert')).toHaveTextContent('Unrecognized key');
    expect(screen.getByLabelText('Name')).toHaveValue('Site');
  });

  it('shows non-validation errors in an alert and preserves inputs', async () => {
    const createMonitor = vi
      .fn()
      .mockRejectedValue(new ApiClientError(0, 'NETWORK_ERROR', 'Network error'));
    render(<AddMonitorForm onCreated={vi.fn()} client={fakeClient({ createMonitor })} />);
    await userEvent.type(screen.getByLabelText('Name'), 'Site');
    await userEvent.type(screen.getByLabelText('URL'), 'https://site.test');
    await userEvent.click(screen.getByRole('button', { name: 'Add monitor' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Network error');
    expect(screen.getByLabelText('URL')).toHaveValue('https://site.test');
  });

  it('disables the button and shows "Adding…" while submitting', async () => {
    let resolve!: (m: ReturnType<typeof makeMonitor>) => void;
    const createMonitor = vi.fn().mockReturnValue(new Promise((r) => (resolve = r)));
    render(<AddMonitorForm onCreated={vi.fn()} client={fakeClient({ createMonitor })} />);
    await userEvent.type(screen.getByLabelText('Name'), 'Site');
    await userEvent.type(screen.getByLabelText('URL'), 'https://site.test');
    await userEvent.click(screen.getByRole('button', { name: 'Add monitor' }));

    const busy = screen.getByRole('button', { name: 'Adding…' });
    expect(busy).toBeDisabled();
    expect(busy.closest('form')).toHaveAttribute('aria-busy', 'true');
    resolve(makeMonitor({ name: 'Site' }));
    expect(await screen.findByRole('button', { name: 'Add monitor' })).toBeEnabled();
  });

  it('on success calls onCreated, resets, focuses Name and announces', async () => {
    const created = makeMonitor({ name: 'Site', url: 'https://site.test' });
    const createMonitor = vi.fn().mockResolvedValue(created);
    const onCreated = vi.fn();
    render(<AddMonitorForm onCreated={onCreated} client={fakeClient({ createMonitor })} />);
    await userEvent.type(screen.getByLabelText('Name'), 'Site');
    await userEvent.type(screen.getByLabelText('URL'), 'https://site.test');
    await userEvent.selectOptions(screen.getByLabelText('Method'), 'POST');
    await userEvent.click(screen.getByLabelText('Enabled'));
    await userEvent.click(screen.getByRole('button', { name: 'Add monitor' }));

    expect(createMonitor).toHaveBeenCalledWith({
      name: 'Site',
      url: 'https://site.test',
      method: 'POST',
      intervalSeconds: 60,
      timeoutMs: 10000,
      expectedStatus: 200,
      enabled: false,
    });
    expect(onCreated).toHaveBeenCalledWith(created);
    expect(await screen.findByRole('status')).toHaveTextContent('Monitor "Site" added.');
    expect(screen.getByLabelText('Name')).toHaveValue('');
    expect(screen.getByLabelText('URL')).toHaveValue('');
    expect(screen.getByLabelText('Method')).toHaveValue('GET');
    expect(screen.getByLabelText('Enabled')).toBeChecked();
    expect(screen.getByLabelText('Name')).toHaveFocus();
  });
});
