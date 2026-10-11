import { vi } from 'vitest';
import type { Monitor } from '@pulse/shared';
import type { ApiClient } from '../api/client';

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
    ...overrides,
  };
}

export function fakeClient(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    health: vi.fn(),
    listMonitors: vi.fn().mockResolvedValue([]),
    getMonitor: vi.fn(),
    createMonitor: vi.fn(),
    updateMonitor: vi.fn(),
    deleteMonitor: vi.fn(),
    ...overrides,
  };
}
