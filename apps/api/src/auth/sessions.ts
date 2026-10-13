import { createHash, randomBytes } from 'node:crypto';
import { SESSION_TTL_SECONDS } from '@pulse/shared';
import type { SqliteDatabase } from '../db.js';

export type Session = { id: string; csrfToken: string; expiresAt: string };
export type StoredSession = Session & { userId: string; email: string };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

export class SessionStore {
  private readonly timer: NodeJS.Timeout;
  constructor(private readonly db: SqliteDatabase) {
    this.pruneExpired();
    this.timer = setInterval(() => this.pruneExpired(), 60 * 60 * 1000);
    this.timer.unref();
  }
  create(userId: string): Session {
    const id = randomBytes(32).toString('base64url');
    const csrfToken = randomBytes(32).toString('base64url');
    const now = new Date();
    const expiresAt = new Date(now.getTime() + SESSION_TTL_SECONDS * 1000).toISOString();
    this.db
      .prepare(
        'INSERT INTO sessions (id_hash, user_id, csrf_token, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(hash(id), userId, csrfToken, now.toISOString(), expiresAt);
    return { id, csrfToken, expiresAt };
  }
  lookup(id: string): StoredSession | undefined {
    const row = this.db
      .prepare(
        `SELECT s.csrf_token, s.expires_at, s.user_id, u.email
      FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id_hash = ?`,
      )
      .get(hash(id)) as
      { csrf_token: string; expires_at: string; user_id: string; email: string } | undefined;
    if (!row) return undefined;
    if (new Date(row.expires_at).getTime() <= Date.now()) {
      this.revoke(id);
      return undefined;
    }
    return {
      id,
      csrfToken: row.csrf_token,
      expiresAt: row.expires_at,
      userId: row.user_id,
      email: row.email,
    };
  }
  revoke(id: string): void {
    this.db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(hash(id));
  }
  pruneExpired(): number {
    return this.db
      .prepare('DELETE FROM sessions WHERE expires_at <= ?')
      .run(new Date().toISOString()).changes;
  }
  close(): void {
    clearInterval(this.timer);
  }
}
