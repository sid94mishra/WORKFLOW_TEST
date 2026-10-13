import { randomBytes, randomUUID } from 'node:crypto';
import type { SqliteDatabase } from '../db.js';
import { hashPassword, type ScryptParams } from './password.js';

export type AdminCredentials = { email: string; password: string };
export type AdminBootstrap = 'created' | 'exists' | 'missing';

export async function ensureAdmin(
  db: SqliteDatabase,
  admin?: AdminCredentials,
  params?: ScryptParams,
): Promise<AdminBootstrap> {
  if (db.prepare('SELECT 1 FROM users LIMIT 1').get()) return 'exists';
  if (!admin) return 'missing';
  const passwordHash = await hashPassword(admin.password, params);
  const createdAt = new Date().toISOString();
  const result = db.transaction(() =>
    db
      .prepare(
        `INSERT INTO users (id, email, password_hash, created_at)
         SELECT ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM users)`,
      )
      .run(randomUUID(), admin.email.toLowerCase(), passwordHash, createdAt),
  )();
  return result.changes === 1 ? 'created' : 'exists';
}

export function resolveSessionSecret(db: SqliteDatabase, supplied?: string): string {
  if (supplied) return supplied;
  const existing = db
    .prepare("SELECT value FROM app_secrets WHERE name = 'session_secret'")
    .get() as { value: string } | undefined;
  if (existing) return existing.value;
  const value = randomBytes(32).toString('base64url');
  db.prepare("INSERT OR IGNORE INTO app_secrets (name, value) VALUES ('session_secret', ?)").run(
    value,
  );
  return (
    db.prepare("SELECT value FROM app_secrets WHERE name = 'session_secret'").get() as {
      value: string;
    }
  ).value;
}
