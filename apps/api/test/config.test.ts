import { describe, expect, it } from 'vitest';
import { readConfig } from '../src/config.js';

describe('configuration', () => {
  it('defaults scheduler configuration safely', () => {
    expect(readConfig({ DATABASE_PATH: ':memory:' })).toMatchObject({
      maxConcurrency: 8,
      allowPrivate: false,
    });
  });
  it('defaults metrics private and parses its explicit public opt-in', () => {
    expect(readConfig({ DATABASE_PATH: ':memory:' }).metricsPublic).toBe(false);
    expect(
      readConfig({ DATABASE_PATH: ':memory:', PULSE_METRICS_PUBLIC: 'true' }).metricsPublic,
    ).toBe(true);
    expect(() => readConfig({ DATABASE_PATH: ':memory:', PULSE_METRICS_PUBLIC: '1' })).toThrow();
  });
  it.each([
    { PULSE_MAX_CONCURRENCY: '0' },
    { PULSE_MAX_CONCURRENCY: '65' },
    { PULSE_ALLOW_PRIVATE: 'yes' },
  ])('rejects invalid scheduler configuration %#', (env) =>
    expect(() => readConfig({ DATABASE_PATH: ':memory:', ...env })).toThrow(),
  );

  it('requires first-start credentials as a pair without leaking the password', () => {
    const password = 'do-not-echo-this';
    expect(() => readConfig({ PULSE_ADMIN_EMAIL: 'admin@example.test' })).toThrow('set together');
    expect(() => readConfig({ PULSE_ADMIN_PASSWORD: password })).toThrow('set together');
    try {
      readConfig({ PULSE_ADMIN_PASSWORD: password });
    } catch (error) {
      expect(String(error)).not.toContain(password);
    }
  });

  it('maps authentication and proxy configuration', () => {
    expect(
      readConfig({
        PULSE_ADMIN_EMAIL: 'ADMIN@example.test',
        PULSE_ADMIN_PASSWORD: 'x'.repeat(12),
        PULSE_COOKIE_SECURE: 'true',
        PULSE_TRUST_PROXY: '2',
      }),
    ).toMatchObject({
      auth: { admin: { email: 'admin@example.test' }, cookieSecure: true },
      trustProxy: 2,
    });
  });
});
