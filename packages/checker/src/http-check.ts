import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Agent, fetch as undiciFetch, type Response } from 'undici';
import type { CheckOutcome, Monitor } from '@pulse/shared';
import { classifyAddress, isAddressAllowed } from './address-policy.js';
import { createPinnedLookup } from './pinned-lookup.js';

export type HttpCheckTarget = Pick<
  Monitor,
  'url' | 'method' | 'timeoutMs' | 'expectedStatus' | 'keyword'
>;
export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}
export type ResolveHost = (hostname: string) => Promise<ResolvedAddress[]>;
export interface HttpCheckOptions {
  fetch?: typeof undiciFetch;
  userAgent?: string;
  resolveHost?: ResolveHost;
  allowPrivate?: boolean;
}

export const MAX_REDIRECTS = 3;
const DEFAULT_USER_AGENT = 'Pulse/0.1 (+uptime-check)';
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

function errorMessage(error: unknown): string {
  const value = error as { cause?: { message?: unknown }; message?: unknown } | null;
  if (typeof value?.cause?.message === 'string') return value.cause.message;
  if (typeof value?.message === 'string') return value.message;
  return String(error);
}

function dnsErrorMessage(error: unknown): string {
  const value = error as { code?: unknown } | null;
  return typeof value?.code === 'string' ? value.code : errorMessage(error);
}

/** Runs an HTTP check without ever connecting to an unvalidated address. */
export async function runHttpCheck(
  target: HttpCheckTarget,
  opts: HttpCheckOptions = {},
): Promise<CheckOutcome> {
  const checkedAt = new Date().toISOString();
  const startedAt = performance.now();
  const elapsed = () => Math.round(performance.now() - startedAt);
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, target.timeoutMs);
  let statusCode: number | null = null;
  let latencyMs = 0;
  const fail = (error: string): CheckOutcome => ({
    checkedAt,
    ok: false,
    statusCode,
    latencyMs: (latencyMs = elapsed()),
    error,
    keywordMatched: null,
  });
  const validated = new Map<string, ResolvedAddress[]>();
  const agent = new Agent({ connect: { lookup: createPinnedLookup(validated) as never } });
  const fetcher = opts.fetch ?? undiciFetch;
  const resolveHost: ResolveHost =
    opts.resolveHost ??
    (async (host) => {
      const addresses = await lookup(host, { all: true, verbatim: true });
      return addresses.map(({ address, family }) => ({ address, family: family as 4 | 6 }));
    });
  const resolveWithinTimeout = async (host: string): Promise<ResolvedAddress[]> => {
    // The timer may already have fired between hops; an `abort` listener would then never run.
    if (controller.signal.aborted) throw new Error('timeout');
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(new Error('timeout'));
      controller.signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      return await Promise.race([resolveHost(host), aborted]);
    } finally {
      controller.signal.removeEventListener('abort', onAbort!);
    }
  };

  try {
    let current = new URL(target.url);
    let method = target.method;
    let redirects = 0;
    for (;;) {
      if (current.protocol !== 'http:' && current.protocol !== 'https:') {
        return fail(`unsupported redirect protocol: ${current.protocol}`);
      }
      const host = current.hostname.replace(/^\[|\]$/g, '');
      const hostKey = host.toLowerCase();
      let addresses = validated.get(hostKey);
      if (!addresses) {
        try {
          const family = isIP(host);
          addresses = family
            ? [{ address: host, family: family as 4 | 6 }]
            : await resolveWithinTimeout(host);
        } catch (error) {
          return fail(timedOut ? 'timeout' : `dns lookup failed: ${dnsErrorMessage(error)}`);
        }
        if (addresses.length === 0) return fail('dns lookup failed: no addresses');
        for (const address of addresses) {
          if (!isAddressAllowed(address.address, opts.allowPrivate ?? false)) {
            const reason = classifyAddress(address.address)!;
            if (redirects > 0) {
              return fail(
                `blocked redirect to ${current.toString()}: ${address.address} (${reason})`,
              );
            }
            return fail(
              isIP(host)
                ? `blocked address: ${address.address} (${reason})`
                : `blocked address: ${host} resolves to ${address.address} (${reason})`,
            );
          }
        }
        validated.set(hostKey, addresses);
      }

      let response: Response;
      try {
        response = await fetcher(current, {
          method,
          redirect: 'manual',
          cache: 'no-store',
          signal: controller.signal,
          dispatcher: agent,
          headers: { 'user-agent': opts.userAgent ?? DEFAULT_USER_AGENT },
        });
      } catch (error) {
        return fail(timedOut ? 'timeout' : errorMessage(error));
      }
      statusCode = response.status;
      latencyMs = elapsed();
      const location = response.headers.get('location');
      if (REDIRECT_STATUS.has(response.status) && location) {
        void response.body?.cancel().catch(() => undefined);
        // A redirect is not the final response, so failures on the next hop (or on the limit)
        // deliberately expose no HTTP status.
        statusCode = null;
        if (redirects >= MAX_REDIRECTS) return fail(`too many redirects (max ${MAX_REDIRECTS})`);
        const priorMethod = method;
        current = new URL(location, current);
        redirects += 1;
        if (
          response.status === 303 ||
          ((response.status === 301 || response.status === 302) &&
            !['GET', 'HEAD'].includes(priorMethod))
        ) {
          method = 'GET';
        }
        continue;
      }

      let keywordMatched: boolean | null = null;
      if (target.keyword === null) {
        void response.body?.cancel().catch(() => undefined);
      } else {
        try {
          keywordMatched = (await response.text()).includes(target.keyword);
        } catch (error) {
          return fail(timedOut ? 'timeout' : errorMessage(error));
        }
      }
      if (timedOut) return fail('timeout');
      if (statusCode !== target.expectedStatus) {
        return {
          checkedAt,
          ok: false,
          statusCode,
          latencyMs,
          error: `expected status ${target.expectedStatus}, got ${statusCode}`,
          keywordMatched,
        };
      }
      if (keywordMatched === false) {
        return {
          checkedAt,
          ok: false,
          statusCode,
          latencyMs,
          error: 'keyword not found',
          keywordMatched,
        };
      }
      return { checkedAt, ok: true, statusCode, latencyMs, error: null, keywordMatched };
    }
  } catch (error) {
    return fail(timedOut ? 'timeout' : errorMessage(error));
  } finally {
    clearTimeout(timer);
    agent.destroy().catch(() => undefined);
  }
}
