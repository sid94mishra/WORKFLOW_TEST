import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ApiClientError } from '../api/client';
import { fakeClient, makeSession } from '../test/fixtures';
import { LoginPage } from './LoginPage';

async function fill(password = 'hunter2hunter2') {
  await userEvent.type(screen.getByLabelText('Email'), 'admin@example.com');
  await userEvent.type(screen.getByLabelText('Password'), password);
}

describe('LoginPage', () => {
  it('has labelled, autocomplete-friendly fields', () => {
    render(<LoginPage client={fakeClient()} onLoggedIn={vi.fn()} />);
    expect(screen.getByLabelText('Email')).toHaveAttribute('autocomplete', 'username');
    expect(screen.getByLabelText('Email')).toHaveAttribute('type', 'email');
    expect(screen.getByLabelText('Password')).toHaveAttribute('autocomplete', 'current-password');
    expect(screen.getByLabelText('Password')).toBeRequired();
  });

  it('disables controls while signing in, then calls onLoggedIn', async () => {
    let resolve!: (v: ReturnType<typeof makeSession>) => void;
    const login = vi.fn().mockReturnValue(new Promise((r) => (resolve = r)));
    const onLoggedIn = vi.fn();
    render(<LoginPage client={fakeClient({ login })} onLoggedIn={onLoggedIn} />);
    await fill();
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(screen.getByRole('button', { name: 'Signing in…' })).toBeDisabled();
    expect(screen.getByLabelText('Email')).toBeDisabled();
    expect(screen.getByLabelText('Password')).toBeDisabled();
    expect(login).toHaveBeenCalledWith({ email: 'admin@example.com', password: 'hunter2hunter2' });
    const session = makeSession();
    resolve(session);
    await vi.waitFor(() => expect(onLoggedIn).toHaveBeenCalledWith(session));
  });

  it('401: shows the generic error, clears the password and focuses the alert', async () => {
    const login = vi.fn().mockRejectedValue(new ApiClientError(401, 'UNAUTHORIZED', 'nope'));
    render(<LoginPage client={fakeClient({ login })} onLoggedIn={vi.fn()} />);
    await fill();
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Invalid email or password');
    expect(alert).toHaveFocus();
    expect(screen.getByLabelText('Password')).toHaveValue('');
    expect(screen.getByLabelText('Email')).toHaveValue('admin@example.com');
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled();
  });

  it('429: shows the wait time in minutes', async () => {
    const login = vi
      .fn()
      .mockRejectedValue(new ApiClientError(429, 'RATE_LIMITED', 'slow', [], 900));
    render(<LoginPage client={fakeClient({ login })} onLoggedIn={vi.fn()} />);
    await fill();
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Too many attempts. Try again in 15 minutes.',
    );
  });

  it('429 without Retry-After says later; network errors get a connection message', async () => {
    const login = vi
      .fn()
      .mockRejectedValueOnce(new ApiClientError(429, 'RATE_LIMITED', 'slow'))
      .mockRejectedValueOnce(new ApiClientError(0, 'NETWORK_ERROR', 'Network error'));
    render(<LoginPage client={fakeClient({ login })} onLoggedIn={vi.fn()} />);
    await fill();
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Try again later.');
    await userEvent.type(screen.getByLabelText('Password'), 'x');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText(/Could not sign in/)).toBeInTheDocument();
  });
});
