import type {
  ApiError,
  ApiIssue,
  ErrorCode,
  HealthResponse,
  MonitorCreateInput,
} from '@pulse/shared';
import { CSRF_HEADER } from './auth-types';
import type {
  ApiKey,
  ApiKeyCreateInput,
  ApiKeyCreated,
  LoginRequest,
  SessionInfo,
} from './auth-types';
import type {
  Channel,
  ChannelCreateInput,
  ChannelUpdate,
  CheckResult,
  DeliveryAttempt,
  Incident,
  IncidentsQuery,
  Monitor,
  MonitorUpdate,
  UptimeSummary,
  UptimeWindow,
} from './types';

/** Codes added by the auth iteration; fold into ErrorCode once @pulse/shared exports them. */
export type AuthErrorCode = 'UNAUTHORIZED' | 'FORBIDDEN' | 'CSRF_FAILED' | 'RATE_LIMITED';

export class ApiClientError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode | AuthErrorCode | 'NETWORK_ERROR',
    message: string,
    readonly issues: ApiIssue[] = [],
    readonly retryAfterSeconds?: number,
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
  listIncidents(q?: Partial<IncidentsQuery>, signal?: AbortSignal): Promise<Incident[]>;
  listChannels(signal?: AbortSignal): Promise<Channel[]>;
  createChannel(input: ChannelCreateInput): Promise<Channel>;
  updateChannel(id: string, patch: ChannelUpdate): Promise<Channel>;
  deleteChannel(id: string): Promise<void>;
  testChannel(id: string): Promise<DeliveryAttempt>;
  getSession(signal?: AbortSignal): Promise<SessionInfo>;
  login(input: LoginRequest): Promise<SessionInfo>;
  logout(): Promise<void>;
  listApiKeys(signal?: AbortSignal): Promise<ApiKey[]>;
  createApiKey(input: ApiKeyCreateInput): Promise<ApiKeyCreated>;
  renameApiKey(id: string, name: string): Promise<ApiKey>;
  revokeApiKey(id: string): Promise<void>;
  /** Registers the callback invoked when a (non-login) request gets 401. Returns an unsubscribe. */
  setUnauthorizedHandler(handler: (() => void) | null): void;
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

export function createApiClient(
  opts: { baseUrl?: string; fetch?: typeof fetch; onUnauthorized?: () => void } = {},
): ApiClient {
  const baseUrl = opts.baseUrl ?? '';
  let csrfToken: string | null = null;
  let onUnauthorized: (() => void) | null = opts.onUnauthorized ?? null;

  async function request(
    path: string,
    init: { method?: string; body?: unknown; signal?: AbortSignal; isLogin?: boolean } = {},
  ): Promise<unknown> {
    const doFetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
    const hasBody = init.body !== undefined;
    const method = init.method ?? 'GET';
    const mutating = method !== 'GET' && method !== 'HEAD';
    let res: Response;
    try {
      res = await doFetch(`${baseUrl}${path}`, {
        method,
        signal: init.signal,
        credentials: 'same-origin',
        headers: {
          accept: 'application/json',
          ...(mutating && csrfToken ? { [CSRF_HEADER]: csrfToken } : {}),
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
      if (res.status === 401) {
        csrfToken = null;
        if (!init.isLogin) onUnauthorized?.();
      }
      const retryHeader = Number(res.headers.get('retry-after'));
      const retryAfter = Number.isFinite(retryHeader) && retryHeader > 0 ? retryHeader : undefined;
      if (isApiError(body)) {
        const { code, message, issues } = body.error;
        throw new ApiClientError(res.status, code, message, issues ?? [], retryAfter);
      }
      throw new ApiClientError(
        res.status,
        'INTERNAL_ERROR',
        `Request failed (${res.status})`,
        [],
        retryAfter,
      );
    }
    return body;
  }

  const unwrap = <T>(body: unknown): T => (body as { data: T }).data;

  const remember = (session: SessionInfo) => {
    csrfToken = session.csrfToken;
    return session;
  };

  return {
    setUnauthorizedHandler(handler) {
      onUnauthorized = handler;
    },
    async getSession(signal) {
      return remember(unwrap<SessionInfo>(await request('/api/v1/auth/session', { signal })));
    },
    async login(input) {
      return remember(
        unwrap<SessionInfo>(
          await request('/api/v1/auth/login', { method: 'POST', body: input, isLogin: true }),
        ),
      );
    },
    async logout() {
      await request('/api/v1/auth/logout', { method: 'POST' });
      csrfToken = null;
    },
    async listApiKeys(signal) {
      return unwrap<ApiKey[]>(await request('/api/v1/api-keys', { signal }));
    },
    async createApiKey(input) {
      return unwrap<ApiKeyCreated>(
        await request('/api/v1/api-keys', { method: 'POST', body: input }),
      );
    },
    async renameApiKey(id, name) {
      return unwrap<ApiKey>(
        await request(`/api/v1/api-keys/${encodeURIComponent(id)}`, {
          method: 'PATCH',
          body: { name },
        }),
      );
    },
    async revokeApiKey(id) {
      await request(`/api/v1/api-keys/${encodeURIComponent(id)}`, { method: 'DELETE' });
    },
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
    async listIncidents(q = {}, signal) {
      const params = new URLSearchParams();
      if (q.status !== undefined) params.set('status', q.status);
      if (q.monitorId !== undefined) params.set('monitorId', q.monitorId);
      if (q.limit !== undefined) params.set('limit', String(q.limit));
      const qs = params.toString();
      return unwrap<Incident[]>(
        await request(`/api/v1/incidents${qs ? `?${qs}` : ''}`, { signal }),
      );
    },
    async listChannels(signal) {
      return unwrap<Channel[]>(await request('/api/v1/channels', { signal }));
    },
    async createChannel(input) {
      return unwrap<Channel>(await request('/api/v1/channels', { method: 'POST', body: input }));
    },
    async updateChannel(id, patch) {
      return unwrap<Channel>(
        await request(`/api/v1/channels/${encodeURIComponent(id)}`, {
          method: 'PATCH',
          body: patch,
        }),
      );
    },
    async deleteChannel(id) {
      await request(`/api/v1/channels/${encodeURIComponent(id)}`, { method: 'DELETE' });
    },
    async testChannel(id) {
      return unwrap<DeliveryAttempt>(
        await request(`/api/v1/channels/${encodeURIComponent(id)}/test`, { method: 'POST' }),
      );
    },
  };
}

export const api: ApiClient = createApiClient({ baseUrl: '' });
