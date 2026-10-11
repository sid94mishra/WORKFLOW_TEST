import type { CheckOutcome, Monitor } from '@pulse/shared';

export type HttpCheckTarget = Pick<
  Monitor,
  'url' | 'method' | 'timeoutMs' | 'expectedStatus' | 'keyword'
>;

export interface HttpCheckOptions {
  fetch?: typeof globalThis.fetch;
  userAgent?: string;
}

const DEFAULT_USER_AGENT = 'Pulse/0.1 (+uptime-check)';

/** Prefers `err.cause.message` (undici puts e.g. "connect ECONNREFUSED …" there). */
function errorMessage(error: unknown): string {
  const value = error as { cause?: { message?: unknown }; message?: unknown } | null;
  if (typeof value?.cause?.message === 'string') return value.cause.message;
  if (typeof value?.message === 'string') return value.message;
  return String(error);
}

/**
 * Runs one HTTP check. Never rejects: every failure is reported in the outcome (spec §5.2).
 * The timeout covers both the response headers and, when a keyword is set, the body read.
 */
export async function runHttpCheck(
  target: HttpCheckTarget,
  opts: HttpCheckOptions = {},
): Promise<CheckOutcome> {
  const fetcher = opts.fetch ?? globalThis.fetch;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, target.timeoutMs);

  const checkedAt = new Date().toISOString();
  const startedAt = performance.now();
  const elapsed = () => Math.round(performance.now() - startedAt);
  let statusCode: number | null = null;
  let latencyMs = 0;

  const fail = (error: string): CheckOutcome => ({
    checkedAt,
    ok: false,
    statusCode,
    latencyMs,
    error,
    keywordMatched: null,
  });

  // `cache` is honoured by undici but missing from @types/node's RequestInit.
  const init: RequestInit & { cache: 'no-store' } = {
    method: target.method,
    redirect: 'follow',
    cache: 'no-store',
    signal: controller.signal,
    headers: { 'user-agent': opts.userAgent ?? DEFAULT_USER_AGENT },
  };

  try {
    let response: Response;
    try {
      response = await fetcher(target.url, init);
    } catch (error) {
      latencyMs = elapsed();
      return fail(timedOut ? 'timeout' : errorMessage(error));
    }
    latencyMs = elapsed();
    statusCode = response.status;

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
  } finally {
    clearTimeout(timer);
  }
}
