import type {
  ApiError,
  ApiIssue,
  ErrorCode,
  HealthResponse,
  MonitorCreateInput,
  MonitorUpdate,
} from '@pulse/shared';
import type { CheckResult, Monitor, UptimeSummary, UptimeWindow } from './types';

export class ApiClientError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode | 'NETWORK_ERROR',
    message: string,
    readonly issues: ApiIssue[] = [],
  ) {
    super(message);
    this.name = 'ApiClientError';
  }
}

export interface ApiClient {
  health(): Promise<HealthResponse>;
  listMonitors(signal?: AbortSignal): Promise<Monitor[]>;
  getMonitor(id: string, signal?: AbortSignal): Promise<Monitor>;
  listResults(id: string, opts?: { limit?: number }, signal?: AbortSignal): Promise<CheckResult[]>;
  getUptime(id: string, window: UptimeWindow, signal?: AbortSignal): Promise<UptimeSummary>;
  createMonitor(input: MonitorCreateInput): Promise<Monitor>;
  updateMonitor(id: string, patch: MonitorUpdate): Promise<Monitor>;
  deleteMonitor(id: string): Promise<void>;
}

function isApiError(body: unknown): body is ApiError {
  if (typeof body !== 'object' || body === null || !('error' in body)) return false;
  const err = (body as { error: unknown }).error;
  return (
    typeof err === 'object' &&
    err !== null &&
    typeof (err as { code?: unknown }).code === 'string' &&
    typeof (err as { message?: unknown }).message === 'string'
  );
}

export function createApiClient(opts: { baseUrl?: string; fetch?: typeof fetch } = {}): ApiClient {
  const baseUrl = opts.baseUrl ?? '';

  async function request(
    path: string,
    init: { method?: string; body?: unknown; signal?: AbortSignal } = {},
  ): Promise<unknown> {
    const doFetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
    const hasBody = init.body !== undefined;
    let res: Response;
    try {
      res = await doFetch(`${baseUrl}${path}`, {
        method: init.method ?? 'GET',
        signal: init.signal,
        headers: {
          accept: 'application/json',
          ...(hasBody ? { 'content-type': 'application/json' } : {}),
        },
        body: hasBody ? JSON.stringify(init.body) : undefined,
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') throw err;
      throw new ApiClientError(0, 'NETWORK_ERROR', 'Network error');
    }

    let body: unknown;
    if (res.status !== 204) {
      try {
        body = await res.json();
      } catch {
        body = undefined;
      }
    }

    if (!res.ok) {
      if (isApiError(body)) {
        const { code, message, issues } = body.error;
        throw new ApiClientError(res.status, code, message, issues ?? []);
      }
      throw new ApiClientError(res.status, 'INTERNAL_ERROR', `Request failed (${res.status})`);
    }
    return body;
  }

  const unwrap = <T>(body: unknown): T => (body as { data: T }).data;

  return {
    async health() {
      return (await request('/health')) as HealthResponse;
    },
    async listMonitors(signal) {
      return unwrap<Monitor[]>(await request('/api/v1/monitors', { signal }));
    },
    async getMonitor(id, signal) {
      return unwrap<Monitor>(
        await request(`/api/v1/monitors/${encodeURIComponent(id)}`, { signal }),
      );
    },
    async listResults(id, opts = {}, signal) {
      const query = opts.limit === undefined ? '' : `?limit=${encodeURIComponent(opts.limit)}`;
      return unwrap<CheckResult[]>(
        await request(`/api/v1/monitors/${encodeURIComponent(id)}/results${query}`, { signal }),
      );
    },
    async getUptime(id, window, signal) {
      return unwrap<UptimeSummary>(
        await request(
          `/api/v1/monitors/${encodeURIComponent(id)}/uptime?window=${encodeURIComponent(window)}`,
          { signal },
        ),
      );
    },
    async createMonitor(input) {
      return unwrap<Monitor>(await request('/api/v1/monitors', { method: 'POST', body: input }));
    },
    async updateMonitor(id, patch) {
      return unwrap<Monitor>(
        await request(`/api/v1/monitors/${encodeURIComponent(id)}`, {
          method: 'PATCH',
          body: patch,
        }),
      );
    },
    async deleteMonitor(id) {
      await request(`/api/v1/monitors/${encodeURIComponent(id)}`, { method: 'DELETE' });
    },
  };
}

export const api: ApiClient = createApiClient({ baseUrl: '' });
