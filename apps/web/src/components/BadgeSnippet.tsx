import { useEffect, useRef, useState } from 'react';

export interface BadgeSnippetProps {
  monitorId: string;
  origin?: string;
}

type CopyState = 'idle' | 'copied' | 'manual';

function SnippetField({ id, label, text }: { id: string; label: string; text: string }) {
  const [state, setState] = useState<CopyState>('idle');
  const area = useRef<HTMLTextAreaElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  async function copy() {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('no clipboard');
      await navigator.clipboard.writeText(text);
      setState('copied');
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setState('idle'), 2000);
    } catch {
      area.current?.focus();
      area.current?.select();
      setState('manual');
    }
  }

  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-sm font-medium text-slate-900">
        {label}
      </label>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
        <textarea
          id={id}
          ref={area}
          readOnly
          rows={2}
          value={text}
          className="block w-full rounded-md border border-slate-400 bg-slate-50 px-3 py-2 font-mono text-sm text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600"
        />
        <button
          type="button"
          onClick={() => void copy()}
          className="shrink-0 rounded-md border border-slate-400 bg-white px-3 py-1.5 text-sm font-medium text-slate-900 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600 focus-visible:ring-offset-2"
        >
          {state === 'copied' ? 'Copied' : state === 'manual' ? 'Press Ctrl+C to copy' : 'Copy'}
        </button>
      </div>
    </div>
  );
}

export function BadgeSnippet({ monitorId, origin = window.location.origin }: BadgeSnippetProps) {
  const base = `${origin}/badge/${encodeURIComponent(monitorId)}.svg`;
  const uptimeUrl = base;
  const statusUrl = `${base}?type=status`;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <img src={uptimeUrl} alt="uptime badge" height={20} />
        <img src={statusUrl} alt="status badge" height={20} />
      </div>
      <SnippetField
        id="badge-uptime"
        label="Uptime badge (Markdown)"
        text={`![uptime](${uptimeUrl})`}
      />
      <SnippetField
        id="badge-status"
        label="Status badge (Markdown)"
        text={`![status](${statusUrl})`}
      />
    </div>
  );
}
