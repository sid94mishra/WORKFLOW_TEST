import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { ApiClientError, type ApiClient } from '../api/client';
import type { SessionInfo } from '../api/types';
import { LoginPage } from './LoginPage';

type State =
  | { status: 'loading' }
  | { status: 'anonymous' }
  | { status: 'error'; message: string }
  | { status: 'authenticated'; session: SessionInfo };

export interface AuthControls {
  session: SessionInfo;
  /** Sends the user to the login page (after logout). */
  signedOut: () => void;
}

export function AuthGate({
  client,
  children,
}: {
  client: ApiClient;
  children: (auth: AuthControls) => ReactNode;
}) {
  const [state, setState] = useState<State>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    client.setUnauthorizedHandler(() => setState({ status: 'anonymous' }));
    return () => client.setUnauthorizedHandler(null);
  }, [client]);

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: 'loading' });
    client
      .getSession(controller.signal)
      .then((session) => setState({ status: 'authenticated', session }))
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        if (err instanceof ApiClientError && err.status === 401) setState({ status: 'anonymous' });
        else
          setState({
            status: 'error',
            message: err instanceof ApiClientError ? err.message : 'Unexpected error',
          });
      });
    return () => controller.abort();
  }, [client, attempt]);

  const signedOut = useCallback(() => setState({ status: 'anonymous' }), []);

  if (state.status === 'loading') {
    return (
      <p role="status" className="p-8 text-slate-700">
        Loading…
      </p>
    );
  }
  if (state.status === 'error') {
    return (
      <div className="mx-auto max-w-md p-8">
        <div role="alert" className="rounded-md border border-red-300 bg-red-50 p-4 text-red-900">
          <p>Couldn't check your session: {state.message}</p>
          <button
            type="button"
            onClick={() => setAttempt((n) => n + 1)}
            className="mt-3 rounded-md bg-red-700 px-2.5 py-1 text-sm font-medium text-white hover:bg-red-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-700 focus-visible:ring-offset-2"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }
  if (state.status === 'anonymous') {
    return (
      <LoginPage
        client={client}
        onLoggedIn={(session) => setState({ status: 'authenticated', session })}
      />
    );
  }
  return <>{children({ session: state.session, signedOut })}</>;
}
