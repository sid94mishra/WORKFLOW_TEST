import { describe, expect, it } from 'vitest';
import {
  CheckOutcomeSchema,
  CheckResultSchema,
  MonitorCreateSchema,
  MonitorSchema,
  MonitorUpdateSchema,
} from '../src/index.js';

const valid = { name: 'Example', url: 'https://example.test' };
const invalid = (input: object) => expect(MonitorCreateSchema.safeParse(input).success).toBe(false);

describe('MonitorCreateSchema', () => {
  it('applies defaults', () => {
    expect(MonitorCreateSchema.parse(valid)).toMatchObject({
      method: 'GET',
      intervalSeconds: 60,
      timeoutMs: 10_000,
      expectedStatus: 200,
      keyword: null,
      enabled: true,
    });
  });
  it.each([30, 86_400])('accepts interval boundary %i', (intervalSeconds) =>
    expect(MonitorCreateSchema.safeParse({ ...valid, intervalSeconds }).success).toBe(true),
  );
  it.each([29, 86_401])('rejects interval outside boundary %i', (intervalSeconds) =>
    invalid({ ...valid, intervalSeconds }),
  );
  it.each([1_000, 60_000])('accepts timeout boundary %i', (timeoutMs) =>
    expect(MonitorCreateSchema.safeParse({ ...valid, timeoutMs }).success).toBe(true),
  );
  it.each([999, 60_001])('rejects timeout outside boundary %i', (timeoutMs) =>
    invalid({ ...valid, timeoutMs }),
  );
  it.each([100, 599])('accepts status boundary %i', (expectedStatus) =>
    expect(MonitorCreateSchema.safeParse({ ...valid, expectedStatus }).success).toBe(true),
  );
  it.each([99, 600])('rejects status outside boundary %i', (expectedStatus) =>
    invalid({ ...valid, expectedStatus }),
  );
  it('accepts name length boundaries', () => {
    expect(MonitorCreateSchema.safeParse({ ...valid, name: 'a' }).success).toBe(true);
    expect(MonitorCreateSchema.safeParse({ ...valid, name: 'a'.repeat(100) }).success).toBe(true);
  });
  it('rejects name lengths outside boundaries', () => {
    invalid({ ...valid, name: '' });
    invalid({ ...valid, name: 'a'.repeat(101) });
  });
  it('rejects ftp URLs', () => invalid({ ...valid, url: 'ftp://example.test' }));
  it('rejects unknown keys', () => invalid({ ...valid, extra: true }));
  it('rejects a keyword with HEAD at path ["keyword"] with the spec message', () => {
    const result = MonitorCreateSchema.safeParse({ ...valid, method: 'HEAD', keyword: 'ok' });
    expect(result.success).toBe(false);
    expect(result.error?.issues).toContainEqual(
      expect.objectContaining({ path: ['keyword'], message: 'keyword is not supported with HEAD' }),
    );
  });
  it.each(['javascript:alert(1)', 'file:///etc/passwd', 'example.test'])(
    'rejects non-http(s) URL %s',
    (url) => invalid({ ...valid, url }),
  );
  it('enforces the URL length limit', () => {
    const url = (length: number) =>
      `https://e.test/${'a'.repeat(length - 'https://e.test/'.length)}`;
    expect(MonitorCreateSchema.safeParse({ ...valid, url: url(2048) }).success).toBe(true);
    invalid({ ...valid, url: url(2049) });
  });
  it('enforces keyword length 1–200', () => {
    expect(MonitorCreateSchema.safeParse({ ...valid, keyword: 'a'.repeat(200) }).success).toBe(
      true,
    );
    invalid({ ...valid, keyword: '' });
    invalid({ ...valid, keyword: 'a'.repeat(201) });
  });
  it('rejects lowercase methods and non-integer numbers', () => {
    invalid({ ...valid, method: 'get' });
    invalid({ ...valid, intervalSeconds: 60.5 });
  });
  it('trims the name before checking its length', () => {
    expect(MonitorCreateSchema.parse({ ...valid, name: '  A  ' }).name).toBe('A');
    invalid({ ...valid, name: '   ' });
  });
  it('rejects read-only fields', () => {
    invalid({ ...valid, id: '11111111-1111-4111-8111-111111111111' });
    invalid({ ...valid, createdAt: new Date().toISOString() });
  });
});

describe('MonitorSchema', () => {
  it('applies the HEAD/keyword rule to a full monitor', () => {
    const monitor = {
      id: '11111111-1111-4111-8111-111111111111',
      ...MonitorCreateSchema.parse(valid),
      status: 'pending',
      lastCheckedAt: null,
      createdAt: '2026-10-11T09:30:00.000Z',
    };
    expect(MonitorSchema.safeParse(monitor).success).toBe(true);
    expect(MonitorSchema.safeParse({ ...monitor, method: 'HEAD', keyword: 'x' }).success).toBe(
      false,
    );
  });
});

describe('MonitorUpdateSchema', () => {
  it('rejects an empty patch', () => expect(MonitorUpdateSchema.safeParse({}).success).toBe(false));
  it('accepts null to clear a keyword', () =>
    expect(MonitorUpdateSchema.parse({ keyword: null })).toEqual({ keyword: null }));
  it('applies no defaults', () =>
    expect(MonitorUpdateSchema.parse({ name: 'x' })).toEqual({ name: 'x' }));
  it('rejects unknown keys', () =>
    expect(MonitorUpdateSchema.safeParse({ name: 'x', id: 'y' }).success).toBe(false));
});

describe('CheckResultSchema', () => {
  it('parses a persisted check result', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    expect(
      CheckResultSchema.parse({
        id,
        monitorId: id,
        checkedAt: new Date().toISOString(),
        ok: true,
        statusCode: 200,
        latencyMs: 3,
        error: null,
        keywordMatched: null,
        status: 'up',
      }).id,
    ).toBe(id);
  });
});

describe('CheckOutcomeSchema', () => {
  const outcome = {
    checkedAt: '2026-10-11T09:30:00.000Z',
    ok: false,
    statusCode: null,
    latencyMs: 0,
    error: 'timeout',
    keywordMatched: null,
  };
  it('requires error to be null iff ok', () => {
    expect(CheckOutcomeSchema.safeParse(outcome).success).toBe(true);
    expect(CheckOutcomeSchema.safeParse({ ...outcome, ok: true }).success).toBe(false);
    expect(CheckOutcomeSchema.safeParse({ ...outcome, error: null }).success).toBe(false);
  });
});
