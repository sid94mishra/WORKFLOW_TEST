import { vi } from 'vitest';
import type { ApiClient } from '../api/client';
import type {
  ApiKey,
  Channel,
  CheckResult,
  Incident,
  MaintenanceWindow,
  Monitor,
  SessionInfo,
  UptimeSummary,
} from '../api/types';

export function makeMonitor(overrides: Partial<Monitor> = {}): Monitor {
  return {
    id: '5f0c7a5e-2b0e-4d0a-9a8e-0c6f2f7a1b11',
    name: 'Example',
    url: 'https://example.com',
    method: 'GET',
    intervalSeconds: 60,
    timeoutMs: 10000,
    expectedStatus: 200,
    keyword: null,
    enabled: true,
    public: false,
    createdAt: '2026-10-11T09:30:00.000Z',
    status: 'pending',
    lastCheckedAt: null,
    ...overrides,
  };
}

let seq = 0;
export function makeResult(overrides: Partial<CheckResult> = {}): CheckResult {
  seq += 1;
  const n = String(seq).padStart(12, '0');
  return {
    id: `00000000-0000-4000-8000-${n}`,
    monitorId: '5f0c7a5e-2b0e-4d0a-9a8e-0c6f2f7a1b11',
    checkedAt: '2026-10-11T09:30:00.000Z',
    ok: true,
    statusCode: 200,
    latencyMs: 100,
    error: null,
    keywordMatched: null,
    status: 'up',
    ...overrides,
  };
}

export function makeUptime(overrides: Partial<UptimeSummary> = {}): UptimeSummary {
  return {
    monitorId: '5f0c7a5e-2b0e-4d0a-9a8e-0c6f2f7a1b11',
    window: '24h',
    from: '2026-10-10T12:00:00.000Z',
    to: '2026-10-11T12:00:00.000Z',
    totalChecks: 100,
    okChecks: 99,
    uptimePercent: 99,
    latencyP50Ms: 112,
    latencyP95Ms: 340,
    ...overrides,
  };
}

let iseq = 0;
export function makeIncident(overrides: Partial<Incident> = {}): Incident {
  iseq += 1;
  return {
    id: `10000000-0000-4000-8000-${String(iseq).padStart(12, '0')}`,
    monitorId: '5f0c7a5e-2b0e-4d0a-9a8e-0c6f2f7a1b11',
    monitorName: 'Example',
    status: 'open',
    cause: 'connect ECONNREFUSED',
    startedAt: '2026-10-11T09:00:00.000Z',
    resolvedAt: null,
    durationSeconds: null,
    ...overrides,
  };
}

export function makeChannel(overrides: Partial<Channel> = {}): Channel {
  return {
    id: '20000000-0000-4000-8000-000000000001',
    name: 'Ops Slack',
    kind: 'slack',
    url: 'https://hooks.slack.com/services/T/B/X',
    enabled: true,
    monitorIds: [],
    createdAt: '2026-10-11T09:30:00.000Z',
    ...overrides,
  };
}

let mseq = 0;
export function makeMaintenance(overrides: Partial<MaintenanceWindow> = {}): MaintenanceWindow {
  mseq += 1;
  return {
    id: `50000000-0000-4000-8000-${String(mseq).padStart(12, '0')}`,
    title: 'Database upgrade',
    monitorIds: 'all',
    startsAt: '2026-10-20T01:00:00.000Z',
    endsAt: '2026-10-20T03:00:00.000Z',
    repeat: null,
    createdBy: null,
    createdAt: '2026-10-11T09:30:00.000Z',
    updatedAt: '2026-10-11T09:30:00.000Z',
    active: false,
    nextOccurrence: { startsAt: '2026-10-20T01:00:00.000Z', endsAt: '2026-10-20T03:00:00.000Z' },
    ...overrides,
  };
}

export function makeSession(email = 'admin@example.com'): SessionInfo {
  return {
    user: { id: '30000000-0000-4000-8000-000000000001', email },
    csrfToken: 'csrf-token',
    expiresAt: '2026-10-18T09:30:00.000Z',
  };
}

let kseq = 0;
export function makeApiKey(overrides: Partial<ApiKey> = {}): ApiKey {
  kseq += 1;
  return {
    id: `40000000-0000-4000-8000-${String(kseq).padStart(12, '0')}`,
    name: 'CI',
    scope: 'read',
    prefix: 'pulse_abc123',
    createdAt: '2026-10-11T09:30:00.000Z',
    lastUsedAt: null,
    ...overrides,
  };
}

export function fakeClient(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    health: vi.fn(),
    listMonitors: vi.fn().mockResolvedValue([]),
    getMonitor: vi.fn(),
    listResults: vi.fn().mockResolvedValue([]),
    getUptime: vi.fn(),
    createMonitor: vi.fn(),
    updateMonitor: vi.fn(),
    deleteMonitor: vi.fn(),
    listIncidents: vi.fn().mockResolvedValue([]),
    listChannels: vi.fn().mockResolvedValue([]),
    createChannel: vi.fn(),
    updateChannel: vi.fn(),
    deleteChannel: vi.fn(),
    testChannel: vi.fn(),
    listMaintenance: vi.fn().mockResolvedValue([]),
    createMaintenance: vi.fn(),
    updateMaintenance: vi.fn(),
    deleteMaintenance: vi.fn(),
    getSession: vi.fn().mockResolvedValue(makeSession()),
    login: vi.fn(),
    logout: vi.fn().mockResolvedValue(undefined),
    listApiKeys: vi.fn().mockResolvedValue([]),
    createApiKey: vi.fn(),
    renameApiKey: vi.fn(),
    revokeApiKey: vi.fn(),
    setUnauthorizedHandler: vi.fn(),
    ...overrides,
  };
}
