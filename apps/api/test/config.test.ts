import { describe, expect, it } from 'vitest';
import { readConfig } from '../src/config.js';

describe('configuration', () => {
  it('defaults scheduler configuration safely', () => {
    expect(readConfig({ DATABASE_PATH: ':memory:' })).toMatchObject({
      maxConcurrency: 8,
      allowPrivate: false,
    });
  });
  it.each([
    { PULSE_MAX_CONCURRENCY: '0' },
    { PULSE_MAX_CONCURRENCY: '65' },
    { PULSE_ALLOW_PRIVATE: 'yes' },
  ])('rejects invalid scheduler configuration %#', (env) =>
    expect(() => readConfig({ DATABASE_PATH: ':memory:', ...env })).toThrow(),
  );
});
