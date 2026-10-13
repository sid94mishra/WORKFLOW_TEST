import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { API_KEY_PREFIX, type ApiKey, type ApiKeyScope } from '@pulse/shared';
import type { SqliteDatabase } from '../db.js';

type Row = {
  id: string;
  name: string;
  scope: ApiKeyScope;
  prefix: string;
  created_at: string;
  last_used_at: string | null;
};
type AuthRow = Row & { key_hash: string };
const sha256 = (input: string) => createHash('sha256').update(input).digest('hex');
const map = (row: Row): ApiKey => ({
  id: row.id,
  name: row.name,
  scope: row.scope,
  prefix: row.prefix,
  createdAt: row.created_at,
  lastUsedAt: row.last_used_at,
});

export class ApiKeyRepository {
  constructor(private readonly db: SqliteDatabase) {}
  create(input: { name: string; scope: ApiKeyScope; userId: string }) {
    const key = API_KEY_PREFIX + randomBytes(32).toString('base64url');
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    const prefix = key.slice(0, 12);
    this.db
      .prepare(
        `INSERT INTO api_keys (id, name, scope, prefix, key_hash, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.name, input.scope, prefix, sha256(key), input.userId, createdAt);
    return { ...this.get(id)!, key };
  }
  list(): ApiKey[] {
    return (
      this.db
        .prepare(
          'SELECT id,name,scope,prefix,created_at,last_used_at FROM api_keys WHERE revoked_at IS NULL ORDER BY created_at DESC, rowid DESC',
        )
        .all() as Row[]
    ).map(map);
  }
  get(id: string): ApiKey | undefined {
    const row = this.db
      .prepare(
        'SELECT id,name,scope,prefix,created_at,last_used_at FROM api_keys WHERE id = ? AND revoked_at IS NULL',
      )
      .get(id) as Row | undefined;
    return row && map(row);
  }
  rename(id: string, name: string): ApiKey | undefined {
    if (
      !this.db
        .prepare('UPDATE api_keys SET name = ? WHERE id = ? AND revoked_at IS NULL')
        .run(name, id).changes
    )
      return undefined;
    return this.get(id);
  }
  revoke(id: string): boolean {
    return (
      this.db
        .prepare('UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
        .run(new Date().toISOString(), id).changes === 1
    );
  }
  authenticate(key: string): { id: string; scope: ApiKeyScope } | undefined {
    const row = this.db
      .prepare(
        'SELECT id,name,scope,prefix,created_at,last_used_at,key_hash FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL',
      )
      .get(sha256(key)) as AuthRow | undefined;
    if (!row) return undefined;
    const now = new Date();
    if (!row.last_used_at || now.getTime() - new Date(row.last_used_at).getTime() >= 60_000) {
      this.db
        .prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?')
        .run(now.toISOString(), row.id);
    }
    return { id: row.id, scope: row.scope };
  }
}
