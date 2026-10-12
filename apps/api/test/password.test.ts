import { describe, expect, it } from 'vitest';
import { createPasswordVerifier, hashPassword, verifyPassword } from '../src/auth/password.js';
describe('scrypt password storage', () => {
  it('round trips a password without storing it', async () => {
    const hash = await hashPassword('correct horse', { N: 1024, r: 8, p: 1 });
    expect(hash).toMatch(/^scrypt\$1024\$8\$1\$/);
    expect(hash).not.toContain('correct horse');
    expect(await verifyPassword('correct horse', hash)).toBe(true);
    expect(await verifyPassword('incorrect', hash)).toBe(false);
  });
  it('fails closed on malformed hashes and supplies a dummy verifier', async () => {
    expect(await verifyPassword('anything', 'nope')).toBe(false);
    expect((await createPasswordVerifier({ N: 1024, r: 8, p: 1 })).dummyHash).toMatch(/^scrypt\$/);
  });
});
