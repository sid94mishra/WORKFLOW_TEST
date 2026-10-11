import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Agent, fetch as undiciFetch } from 'undici';
import { classifyAddress, isAddressAllowed } from './address-policy.js';
import { createPinnedLookup } from './pinned-lookup.js';
import type { ResolveHost, ResolvedAddress } from './http-check.js';

export type ResolveOutcome =
  | { ok: true; addresses: ResolvedAddress[] }
  | {
      ok: false;
      reason: 'blocked';
      address: string;
      blockReason: ReturnType<typeof classifyAddress> extends infer T ? Exclude<T, null> : never;
    }
  | { ok: false; reason: 'dns'; message: string }
  | { ok: false; reason: 'timeout' };

const message = (error: unknown) => {
  const value = error as {
    code?: unknown;
    cause?: { message?: unknown };
    message?: unknown;
  } | null;
  return typeof value?.code === 'string'
    ? value.code
    : typeof value?.cause?.message === 'string'
      ? value.cause.message
      : typeof value?.message === 'string'
        ? value.message
        : String(error);
};
export const defaultResolveHost: ResolveHost = async (host) =>
  (await lookup(host, { all: true, verbatim: true })).map(({ address, family }) => ({
    address,
    family: family as 4 | 6,
  }));
async function race<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) throw new Error('timeout');
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new Error('timeout'));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort!);
  }
}
export async function resolveAndValidate(
  url: URL,
  opts: { allowPrivate: boolean; resolveHost: ResolveHost; signal?: AbortSignal },
): Promise<ResolveOutcome> {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  try {
    const family = isIP(host);
    const addresses = family
      ? [{ address: host, family: family as 4 | 6 }]
      : await race(opts.resolveHost(host), opts.signal);
    if (!addresses.length) return { ok: false, reason: 'dns', message: 'no addresses' };
    for (const address of addresses) {
      const blockReason = classifyAddress(address.address);
      if (!isAddressAllowed(address.address, opts.allowPrivate))
        return {
          ok: false,
          reason: 'blocked',
          address: address.address,
          blockReason: blockReason!,
        };
    }
    return { ok: true, addresses };
  } catch (error) {
    return opts.signal?.aborted
      ? { ok: false, reason: 'timeout' }
      : { ok: false, reason: 'dns', message: message(error) };
  }
}
function blockedText(url: URL, result: Extract<ResolveOutcome, { ok: false; reason: 'blocked' }>) {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  return isIP(host)
    ? `blocked address: ${result.address} (${result.blockReason})`
    : `blocked address: ${host} resolves to ${result.address} (${result.blockReason})`;
}
export async function validateOutboundUrl(
  url: string,
  opts: { allowPrivate: boolean; resolveHost?: ResolveHost; timeoutMs?: number },
): Promise<string | null> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'invalid URL';
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) return 'invalid URL';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 5000);
  try {
    const result = await resolveAndValidate(parsed, {
      allowPrivate: opts.allowPrivate,
      resolveHost: opts.resolveHost ?? defaultResolveHost,
      signal: controller.signal,
    });
    if (result.ok) return null;
    if (result.reason === 'blocked') return blockedText(parsed, result);
    if (result.reason === 'timeout') return 'timeout';
    return `dns lookup failed: ${result.message}`;
  } finally {
    clearTimeout(timer);
  }
}
export interface PostJsonOptions {
  allowPrivate: boolean;
  timeoutMs?: number;
  headers?: Record<string, string>;
  fetch?: typeof undiciFetch;
  resolveHost?: ResolveHost;
}
export interface PostOutcome {
  ok: boolean;
  statusCode: number | null;
  latencyMs: number;
  error: string | null;
}
export async function postJson(
  url: string,
  body: unknown,
  opts: PostJsonOptions,
): Promise<PostOutcome> {
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, statusCode: null, latencyMs: elapsed(), error: 'invalid URL' };
  }
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, opts.timeoutMs ?? 10000);
  let agent: Agent | undefined;
  try {
    const resolved = await resolveAndValidate(parsed, {
      allowPrivate: opts.allowPrivate,
      resolveHost: opts.resolveHost ?? defaultResolveHost,
      signal: controller.signal,
    });
    if (!resolved.ok) {
      const error =
        resolved.reason === 'blocked'
          ? blockedText(parsed, resolved)
          : resolved.reason === 'timeout'
            ? 'timeout'
            : `dns lookup failed: ${resolved.message}`;
      return { ok: false, statusCode: null, latencyMs: elapsed(), error };
    }
    const addresses = new Map([
      [parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase(), resolved.addresses],
    ]);
    agent = new Agent({ connect: { lookup: createPinnedLookup(addresses) as never } });
    const response = await race(
      (opts.fetch ?? undiciFetch)(parsed, {
        method: 'POST',
        redirect: 'manual',
        body: JSON.stringify(body),
        signal: controller.signal,
        dispatcher: agent,
        headers: { 'content-type': 'application/json', ...opts.headers },
      }),
      controller.signal,
    );
    void response.body?.cancel().catch(() => undefined);
    const statusCode = response.status;
    if (statusCode >= 200 && statusCode < 300)
      return { ok: true, statusCode, latencyMs: elapsed(), error: null };
    return {
      ok: false,
      statusCode,
      latencyMs: elapsed(),
      error:
        statusCode >= 300 && statusCode < 400
          ? `unexpected redirect (HTTP ${statusCode})`
          : `HTTP ${statusCode}`,
    };
  } catch (error) {
    const value = error as { cause?: { message?: unknown }; message?: unknown };
    return {
      ok: false,
      statusCode: null,
      latencyMs: elapsed(),
      error: timedOut
        ? 'timeout'
        : typeof value?.cause?.message === 'string'
          ? value.cause.message
          : typeof value?.message === 'string'
            ? value.message
            : String(error),
    };
  } finally {
    clearTimeout(timer);
    if (agent) void agent.destroy();
  }
}
