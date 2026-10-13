import { render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from './App';
import { fakeClient, makeMaintenance } from './test/fixtures';

afterEach(() => {
  window.location.hash = '';
});

describe('App maintenance route', () => {
  it('renders the view at #/maintenance and marks the nav link current', async () => {
    window.location.hash = '#/maintenance';
    const client = fakeClient();
    client.listMaintenance = (() =>
      Promise.resolve([makeMaintenance({ title: 'Routed' })])) as typeof client.listMaintenance;
    render(<App client={client} />);
    expect(
      await screen.findByRole('heading', { level: 2, name: 'Maintenance' }),
    ).toBeInTheDocument();
    expect(await screen.findByText('Routed')).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'Main' });
    expect(within(nav).getByRole('link', { name: 'Maintenance' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(within(nav).getByRole('link', { name: 'Monitors' })).not.toHaveAttribute('aria-current');
    const labels = within(nav)
      .getAllByRole('link')
      .map((a) => a.textContent);
    expect(labels.indexOf('Maintenance')).toBe(labels.indexOf('Channels') + 1);
    expect(labels.indexOf('API keys')).toBe(labels.indexOf('Maintenance') + 1);
  });
});
