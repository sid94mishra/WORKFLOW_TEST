import { LOGIN_MAX_FAILURES, LOGIN_WINDOW_SECONDS } from '@pulse/shared';
type Entry = { failures: number[]; order: number };
export class LoginRateLimiter {
  private readonly entries = new Map<string, Entry>();
  private serial = 0;
  check(key: string): { allowed: true } | { allowed: false; retryAfterSeconds: number } {
    const now = Date.now();
    const entry = this.entries.get(key);
    if (!entry) return { allowed: true };
    entry.failures = entry.failures.filter((at) => at > now - LOGIN_WINDOW_SECONDS * 1000);
    if (!entry.failures.length) {
      this.entries.delete(key);
      return { allowed: true };
    }
    if (entry.failures.length < LOGIN_MAX_FAILURES) return { allowed: true };
    return {
      allowed: false,
      retryAfterSeconds: Math.max(
        1,
        Math.ceil((entry.failures[0]! + LOGIN_WINDOW_SECONDS * 1000 - now) / 1000),
      ),
    };
  }
  recordFailure(key: string): void {
    this.check(key);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { failures: [], order: ++this.serial };
      this.entries.set(key, entry);
    }
    entry.failures.push(Date.now());
    while (this.entries.size > 10_000) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (!oldest) break;
      this.entries.delete(oldest);
    }
  }
  reset(key: string): void {
    this.entries.delete(key);
  }
  get size(): number {
    return this.entries.size;
  }
}
