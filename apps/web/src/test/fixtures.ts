import { vi } from 'vitest';
import type { ApiClient } from '../api/client';
import type { Channel, CheckResult, Incident, Monitor, UptimeSummary } from '../api/types';

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
    ...overrides,
  };
}
