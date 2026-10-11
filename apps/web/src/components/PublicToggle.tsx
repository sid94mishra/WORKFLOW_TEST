import { useState } from 'react';
import { api, ApiClientError, type ApiClient } from '../api/client';
import type { Monitor } from '../api/types';

export interface PublicToggleProps {
  monitor: Monitor;
  onChange: (m: Monitor) => void;
  client?: ApiClient;
}

export function PublicToggle({ monitor, onChange, client = api }: PublicToggleProps) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle() {
    setSaving(true);
    setError(null);
    try {
      onChange(await client.updateMonitor(monitor.id, { public: !monitor.public }));
    } catch (err) {
      setError(
        `Couldn't update visibility: ${err instanceof ApiClientError ? err.message : 'Unexpected error'}`,
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <input
          id="monitor-public"
          type="checkbox"
          checked={monitor.public}
          disabled={saving}
          onChange={() => void toggle()}
          className="size-4 rounded border-slate-400 text-indigo-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600 focus-visible:ring-offset-1"
        />
        <label htmlFor="monitor-public" className="text-sm font-medium text-slate-900">
          Show on public status page
        </label>
      </div>
      {error && (
        <p
          role="alert"
          className="rounded-md border border-red-300 bg-red-50 p-2 text-sm text-red-900"
        >
          {error}
        </p>
      )}
    </div>
  );
}
