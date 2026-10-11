import type { ResolvedAddress } from './http-check.js';

export type LookupCallback = (
  error: Error | null,
  address?: string | ResolvedAddress[],
  family?: number,
) => void;
export type LookupFunction = (
  hostname: string,
  options: { all?: boolean } | number,
  callback?: LookupCallback,
) => void;

/** A DNS lookup which can only return addresses resolved and validated for this check. */
export function createPinnedLookup(
  validated: ReadonlyMap<string, ResolvedAddress[]>,
): LookupFunction {
  return (hostname, options, optionalCallback) => {
    if (!optionalCallback) throw new TypeError('lookup callback is required');
    const addresses = validated.get(hostname.toLowerCase());
    if (!addresses || addresses.length === 0) {
      optionalCallback(new Error(`unrecognized hostname: ${hostname}`));
      return;
    }
    if (typeof options !== 'number' && options.all) {
      optionalCallback(
        null,
        addresses.map(({ address, family }) => ({ address, family })),
      );
      return;
    }
    const first = addresses[0]!;
    optionalCallback(null, first.address, first.family);
  };
}
