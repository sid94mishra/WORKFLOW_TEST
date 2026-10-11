import { vi } from 'vitest';
import type { ApiClient } from '../api/client';
import type { CheckResult, Monitor, UptimeSummary } from '../api/types';

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
    ...overrides,
  };
}
