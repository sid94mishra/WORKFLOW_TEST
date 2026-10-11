import { BlockList, isIP } from 'node:net';

export type BlockReason =
  | 'loopback'
  | 'private'
  | 'link-local'
  | 'metadata'
  | 'unspecified'
  | 'carrier-grade-nat'
  | 'multicast'
  | 'reserved'
  | 'unique-local';

type Range = { reason: BlockReason; list: BlockList };

function range(
  reason: BlockReason,
  address: string,
  type: 'ipv4' | 'ipv6',
  prefix?: number,
): Range {
  const list = new BlockList();
  if (prefix === undefined) list.addAddress(address, type);
  else list.addSubnet(address, prefix, type);
  return { reason, list };
}

// Keep this ordered from most specific to least specific: metadata is link-local.
const RANGES: Range[] = [
  range('metadata', '169.254.169.254', 'ipv4'),
  range('metadata', 'fd00:ec2::254', 'ipv6'),
  range('loopback', '127.0.0.0', 'ipv4', 8),
  range('loopback', '::1', 'ipv6'),
  range('private', '10.0.0.0', 'ipv4', 8),
  range('private', '172.16.0.0', 'ipv4', 12),
  range('private', '192.168.0.0', 'ipv4', 16),
  range('link-local', '169.254.0.0', 'ipv4', 16),
  range('link-local', 'fe80::', 'ipv6', 10),
  range('unique-local', 'fc00::', 'ipv6', 7),
  range('unspecified', '0.0.0.0', 'ipv4', 8),
  range('unspecified', '::', 'ipv6'),
  range('carrier-grade-nat', '100.64.0.0', 'ipv4', 10),
  range('multicast', '224.0.0.0', 'ipv4', 4),
  range('multicast', 'ff00::', 'ipv6', 8),
  range('reserved', '240.0.0.0', 'ipv4', 4),
];

function mappedIpv4(address: string): string | undefined {
  const normalized = new URL(`http://[${address}]/`).hostname.slice(1, -1);
  const halves = normalized.split('::');
  const left = halves[0] ? halves[0].split(':') : [];
  let right = halves[1] ? halves[1].split(':') : [];
  const dotted = right.at(-1);
  if (dotted?.includes('.')) {
    const octets = dotted.split('.').map(Number);
    if (
      octets.length !== 4 ||
      octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
    ) {
      return undefined;
    }
    right = [
      ...right.slice(0, -1),
      ((octets[0]! << 8) | octets[1]!).toString(16),
      ((octets[2]! << 8) | octets[3]!).toString(16),
    ];
  }
  const groups = [
    ...left,
    ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'),
    ...right,
  ];
  if (
    groups.length !== 8 ||
    groups.slice(0, 5).some((group) => Number.parseInt(group, 16) !== 0) ||
    groups[5]?.toLowerCase() !== 'ffff'
  )
    return undefined;
  const high = Number.parseInt(groups[6]!, 16);
  const low = Number.parseInt(groups[7]!, 16);
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}

function normalize(ip: string): string {
  const value = ip.startsWith('[') && ip.endsWith(']') ? ip.slice(1, -1) : ip;
  if (isIP(value) !== 6) return value;
  return mappedIpv4(value) ?? value;
}

/** Returns null for public input. Invalid input is deliberately treated as reserved. */
export function classifyAddress(ip: string): BlockReason | null {
  let address: string;
  try {
    address = normalize(ip);
  } catch {
    return 'reserved';
  }
  const family = isIP(address);
  if (family === 0) return 'reserved';
  const type = family === 4 ? 'ipv4' : 'ipv6';
  return RANGES.find(({ list }) => list.check(address, type))?.reason ?? null;
}

export function isAddressAllowed(ip: string, allowPrivate: boolean): boolean {
  const reason = classifyAddress(ip);
  return reason === null || (allowPrivate && reason !== 'metadata');
}
