import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiClientError, type ApiClient } from '../api/client';
import type { SessionInfo } from '../api/types';

const inputClass =
  'block w-full rounded-md border border-slate-400 bg-white px-3 py-2 text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600 focus-visible:ring-offset-1 disabled:bg-slate-100 disabled:text-slate-600';

export function loginErrorMessage(err: unknown): string {
  if (err instanceof ApiClientError) {
    if (err.status === 401) return 'Invalid email or password';
    if (err.status === 429) {
      const minutes =
        err.retryAfterSeconds === undefined ? null : Math.ceil(err.retryAfterSeconds / 60);
      return `Too many attempts. Try again ${
        minutes === null ? 'later' : `in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`
      }.`;
    }
  }
  return 'Could not sign in. Check your connection and try again.';
}

export function LoginPage({
  client,
  onLoggedIn,
}: {
  client: ApiClient;
  onLoggedIn: (session: SessionInfo) => void;
}) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alertRef = useRef<HTMLDivElement>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (error) alertRef.current?.focus();
  }, [error]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const session = await client.login({ email: email.trim(), password });
      onLoggedIn(session);
    } catch (err) {
      if (!mounted.current) return;
      setPassword('');
      setError(loginErrorMessage(err));
      setSubmitting(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-4 py-8">
      <h1 className="mb-1 text-2xl font-bold">Pulse</h1>
      <h2 className="mb-6 text-xl font-semibold">Sign in to Pulse</h2>
      <form onSubmit={(e) => void onSubmit(e)} className="space-y-4" noValidate={false}>
        {error && (
          <div
            ref={alertRef}
            role="alert"
            tabIndex={-1}
            className="rounded-md border border-red-300 bg-red-50 p-3 text-red-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-700"
          >
            {error}
          </div>
        )}
        <div>
          <label htmlFor="login-email" className="mb-1 block text-sm font-medium">
            Email
          </label>
          <input
            id="login-email"
            type="email"
            autoComplete="username"
            required
            disabled={submitting}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className={inputClass}
          />
        </div>
        <div>
          <label htmlFor="login-password" className="mb-1 block text-sm font-medium">
            Password
          </label>
          <input
            id="login-password"
            type="password"
            autoComplete="current-password"
            required
            disabled={submitting}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className={inputClass}
          />
        </div>
        <button
          type="submit"
          disabled={submitting}
          className="w-full rounded-md bg-indigo-700 px-4 py-2 font-medium text-white hover:bg-indigo-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:bg-slate-500"
        >
          {submitting ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </main>
  );
}
