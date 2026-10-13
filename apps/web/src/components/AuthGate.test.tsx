import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ApiClientError } from '../api/client';
import { fakeClient, makeSession } from '../test/fixtures';
import { AuthGate } from './AuthGate';

const unauthorized = () => new ApiClientError(401, 'UNAUTHORIZED', 'Authentication required');
const child = () => <p>Dashboard for secret-area</p>;

describe('AuthGate', () => {
  it('shows loading, then the children when a session exists', async () => {
    let resolve!: (v: ReturnType<typeof makeSession>) => void;
    const getSession = vi.fn().mockReturnValue(new Promise((r) => (resolve = r)));
    render(<AuthGate client={fakeClient({ getSession })}>{child}</AuthGate>);
    expect(screen.getByRole('status')).toHaveTextContent('Loading…');
    await act(async () => resolve(makeSession()));
    expect(screen.getByText('Dashboard for secret-area')).toBeInTheDocument();
  });

  it('shows the login page on 401 and the dashboard after signing in, keeping the hash', async () => {
    window.location.hash = '#/channels';
    const login = vi.fn().mockResolvedValue(makeSession());
    const client = fakeClient({ getSession: vi.fn().mockRejectedValue(unauthorized()), login });
    render(<AuthGate client={client}>{child}</AuthGate>);
    expect(await screen.findByRole('heading', { name: 'Sign in to Pulse' })).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Email'), 'a@b.co');
    await userEvent.type(screen.getByLabelText('Password'), 'pw');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Dashboard for secret-area')).toBeInTheDocument();
    expect(window.location.hash).toBe('#/channels');
    window.location.hash = '';
  });

  it('shows an alert with Retry for non-401 errors', async () => {
    const getSession = vi
      .fn()
      .mockRejectedValueOnce(new ApiClientError(0, 'NETWORK_ERROR', 'Network error'))
      .mockResolvedValueOnce(makeSession());
    render(<AuthGate client={fakeClient({ getSession })}>{child}</AuthGate>);
    expect(await screen.findByRole('alert')).toHaveTextContent('Network error');
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Dashboard for secret-area')).toBeInTheDocument();
  });

  it('returns to the login page when the client reports an unauthorized response', async () => {
    window.location.hash = '#/incidents';
    const setUnauthorizedHandler = vi.fn();
    render(<AuthGate client={fakeClient({ setUnauthorizedHandler })}>{child}</AuthGate>);
    await screen.findByText('Dashboard for secret-area');
    const handler = setUnauthorizedHandler.mock.calls[0]?.[0] as () => void;
    act(() => handler());
    expect(await screen.findByRole('heading', { name: 'Sign in to Pulse' })).toBeInTheDocument();
    expect(window.location.hash).toBe('#/incidents');
    window.location.hash = '';
  });
});
