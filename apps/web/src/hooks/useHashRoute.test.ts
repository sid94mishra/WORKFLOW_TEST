import { describe, expect, it } from 'vitest';
import { parseHash } from './useHashRoute';

describe('parseHash', () => {
  it.each([
    ['', { name: 'dashboard' }],
    ['#/', { name: 'dashboard' }],
    ['#/incidents', { name: 'incidents' }],
    ['#/channels/', { name: 'channels' }],
    ['#/maintenance', { name: 'maintenance' }],
    ['#/maintenance/', { name: 'maintenance' }],
    ['#/settings/api-keys', { name: 'apiKeys' }],
    ['#/monitors/abc', { name: 'monitor', id: 'abc' }],
    ['#/monitors/%E0', { name: 'dashboard' }],
    ['#/nope', { name: 'dashboard' }],
  ])('%s', (hash, route) => {
    expect(parseHash(hash)).toEqual(route);
  });
});
