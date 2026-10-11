import { describe, expect, it, vi } from 'vitest';
import { classifyAddress, isAddressAllowed, runHttpCheck } from '../src/index.js';

describe('address policy', () => {
  it.each([
    ['127.0.0.1', 'loopback'],
    ['127.255.255.255', 'loopback'],
    ['10.0.0.1', 'private'],
    ['172.16.0.1', 'private'],
    ['172.31.255.255', 'private'],
    ['192.168.1.1', 'private'],
    ['169.254.1.1', 'link-local'],
    ['169.254.169.254', 'metadata'],
    ['0.0.0.0', 'unspecified'],
    ['100.64.0.0', 'carrier-grade-nat'],
    ['100.127.255.255', 'carrier-grade-nat'],
    ['224.0.0.0', 'multicast'],
    ['239.255.255.255', 'multicast'],
    ['255.255.255.255', 'reserved'],
    ['::1', 'loopback'],
    ['::', 'unspecified'],
    ['fc00::1', 'unique-local'],
    ['fdff::1', 'unique-local'],
    ['fe80::1', 'link-local'],
    ['febf::1', 'link-local'],
    ['ff00::', 'multicast'],
    ['fd00:ec2::254', 'metadata'],
    ['::ffff:127.0.0.1', 'loopback'],
    ['::ffff:7f00:1', 'loopback'],
    ['64:ff9b::a00:1', 'private'],
    ['64:ff9b::127.0.0.1', 'loopback'],
    ['64:ff9b::a9fe:a9fe', 'metadata'],
    ['2002:7f00:1::', 'loopback'],
    ['2002:c0a8:101::1', 'private'],
    ['::127.0.0.1', 'loopback'],
    ['::a00:1', 'private'],
    ['fec0::1', 'reserved'],
    ['192.0.0.8', 'reserved'],
    ['198.18.0.1', 'reserved'],
    ['198.19.255.255', 'reserved'],
  ])('classifies %s as %s', (address, reason) => expect(classifyAddress(address)).toBe(reason));

  it('allows documentation/public addresses and only relaxes non-metadata rules', () => {
    for (const address of ['8.8.8.8', '203.0.113.5', '2001:db8::1'])
      expect(classifyAddress(address)).toBeNull();
    expect(classifyAddress('not-an-ip')).toBe('reserved');
    expect(isAddressAllowed('127.0.0.1', true)).toBe(true);
    expect(isAddressAllowed('169.254.169.254', true)).toBe(false);
    expect(isAddressAllowed('64:ff9b::a9fe:a9fe', true)).toBe(false);
  });

  it('allows public addresses embedded in IPv6', () => {
    for (const address of ['64:ff9b::808:808', '2002:808:808::1', '::8.8.8.8'])
      expect(classifyAddress(address)).toBeNull();
    expect(classifyAddress('198.20.0.1')).toBeNull();
  });

  it.each([
    ['127.0.0.0', 'loopback'],
    ['127.0.0.1', 'loopback'],
    ['127.255.255.255', 'loopback'],
    ['10.0.0.0', 'private'],
    ['10.1.2.3', 'private'],
    ['10.255.255.255', 'private'],
    ['172.16.0.0', 'private'],
    ['172.20.1.1', 'private'],
    ['172.31.255.255', 'private'],
    ['192.168.0.0', 'private'],
    ['192.168.1.1', 'private'],
    ['192.168.255.255', 'private'],
    ['169.254.0.0', 'link-local'],
    ['169.254.1.1', 'link-local'],
    ['169.254.255.255', 'link-local'],
    ['169.254.169.254', 'metadata'],
    ['0.0.0.0', 'unspecified'],
    ['0.1.2.3', 'unspecified'],
    ['0.255.255.255', 'unspecified'],
    ['100.64.0.0', 'carrier-grade-nat'],
    ['100.80.1.1', 'carrier-grade-nat'],
    ['100.127.255.255', 'carrier-grade-nat'],
    ['224.0.0.0', 'multicast'],
    ['224.1.2.3', 'multicast'],
    ['239.255.255.255', 'multicast'],
    ['240.0.0.0', 'reserved'],
    ['240.1.2.3', 'reserved'],
    ['255.255.255.255', 'reserved'],
    ['::', 'unspecified'],
    ['::1', 'loopback'],
    ['fc00::', 'unique-local'],
    ['fc00::1', 'unique-local'],
    ['fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', 'unique-local'],
    ['fe80::', 'link-local'],
    ['fe80::1', 'link-local'],
    ['febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff', 'link-local'],
    ['ff00::', 'multicast'],
    ['ff00::1', 'multicast'],
    ['ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', 'multicast'],
    ['fd00:ec2::254', 'metadata'],
  ] as const)('classifies range edge/inner address %s as %s', (address, reason) => {
    expect(classifyAddress(address)).toBe(reason);
  });

  it('classifies a bracketed IPv6 URL host before making a request', async () => {
    const fetch = vi.fn();
    const result = await runHttpCheck(
      {
        url: 'http://[::1]/',
        method: 'GET',
        timeoutMs: 1_000,
        expectedStatus: 200,
        keyword: null,
      },
      { fetch: fetch as never },
    );
    expect(result.error).toBe('blocked address: ::1 (loopback)');
    expect(fetch).not.toHaveBeenCalled();
  });
});
