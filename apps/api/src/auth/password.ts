import { randomBytes, scrypt as nodeScrypt, timingSafeEqual } from 'node:crypto';

export type ScryptParams = { N: number; r: number; p: number };
export const DEFAULT_SCRYPT_PARAMS: ScryptParams = { N: 2 ** 15, r: 8, p: 3 };

function maxmem({ N, r, p }: ScryptParams): number {
  return Math.max(128 * N * r + 1024 * 1024, 128 * N * r * p + 1024 * 1024);
}

function derive(
  plain: string,
  salt: Buffer,
  length: number,
  params: ScryptParams,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    nodeScrypt(plain, salt, length, { ...params, maxmem: maxmem(params) }, (error, value) =>
      error ? reject(error) : resolve(Buffer.from(value)),
    );
  });
}

export async function hashPassword(
  plain: string,
  params: ScryptParams = DEFAULT_SCRYPT_PARAMS,
): Promise<string> {
  const salt = randomBytes(16);
  const derived = await derive(plain, salt, 32, params);
  return `scrypt$${params.N}$${params.r}$${params.p}$${salt.toString('base64url')}$${derived.toString('base64url')}`;
}

export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  try {
    const parts = stored.split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const N = Number(parts[1]);
    const r = Number(parts[2]);
    const p = Number(parts[3]);
    if (
      !Number.isInteger(N) ||
      !Number.isInteger(r) ||
      !Number.isInteger(p) ||
      N < 2 ||
      r < 1 ||
      p < 1
    )
      return false;
    const salt = Buffer.from(parts[4]!, 'base64url');
    const expected = Buffer.from(parts[5]!, 'base64url');
    if (salt.length !== 16 || expected.length !== 32) return false;
    const params = { N, r, p };
    const derived = await derive(plain, salt, expected.length, params);
    return timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

export async function createPasswordVerifier(params: ScryptParams = DEFAULT_SCRYPT_PARAMS) {
  const dummyHash = await hashPassword(randomBytes(32).toString('base64url'), params);
  return { dummyHash, verify: verifyPassword };
}
