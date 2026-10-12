import { describe, expect, it } from 'vitest';
import {
  API_KEY_PATTERN,
  ApiKeyCreateSchema,
  ApiKeyCreatedSchema,
  ApiKeySchema,
  LoginRequestSchema,
} from '../src/index.js';

describe('authentication schemas', () => {
  it('normalizes login email and bounds password input', () => {
    expect(LoginRequestSchema.parse({ email: ' USER@Example.test ', password: 'x' })).toEqual({
      email: 'user@example.test',
      password: 'x',
    });
    expect(
      LoginRequestSchema.safeParse({ email: 'a@b.test', password: 'x'.repeat(1025) }).success,
    ).toBe(false);
  });

  it('defaults a created key to read and rejects extra fields', () => {
    expect(ApiKeyCreateSchema.parse({ name: ' CI ' })).toEqual({ name: 'CI', scope: 'read' });
    expect(ApiKeyCreateSchema.safeParse({ name: 'CI', nope: true }).success).toBe(false);
  });

  it('validates only correctly shaped generated keys', () => {
    const key = `pulse_${'A'.repeat(43)}`;
    expect(API_KEY_PATTERN.test(key)).toBe(true);
    expect(API_KEY_PATTERN.test('pulse_short')).toBe(false);
  });

  it('only permits key material in the one-time response schema', () => {
    const base = {
      id: '00000000-0000-4000-8000-800000000000',
      name: 'CI',
      scope: 'read' as const,
      prefix: 'pulse_ABCDEF',
      createdAt: '2026-01-01T00:00:00.000Z',
      lastUsedAt: null,
    };
    expect(ApiKeySchema.safeParse({ ...base, key: `pulse_${'A'.repeat(43)}` }).success).toBe(false);
    expect(ApiKeyCreatedSchema.parse({ ...base, key: `pulse_${'A'.repeat(43)}` }).key).toMatch(
      API_KEY_PATTERN,
    );
  });
});
