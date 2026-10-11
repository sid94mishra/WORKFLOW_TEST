import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { SqliteDatabase } from './db.js';

// Resolves to apps/api/migrations from both src/ (dev, tests) and dist/ (production).
const MIGRATIONS_URL = new URL('../migrations/', import.meta.url);
const MIGRATION_FILE = /^(\d{3})_.+\.sql$/;

type Migration = { version: number; name: string };

function listMigrations(): Migration[] {
  const migrations: Migration[] = [];
  for (const name of readdirSync(fileURLToPath(MIGRATIONS_URL))) {
    const match = MIGRATION_FILE.exec(name);
    if (match) migrations.push({ version: Number(match[1]), name });
  }
  return migrations.sort((a, b) => a.version - b.version);
}

/** Applies every pending migration, one transaction per file. Re-running is a no-op. */
export function migrate(db: SqliteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT    NOT NULL,
      applied_at TEXT    NOT NULL
    )
  `);

  const rows = db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[];
  const applied = new Set(rows.map((row) => row.version));
  const record = db.prepare(
    'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
  );

  for (const migration of listMigrations()) {
    if (applied.has(migration.version)) continue;
    const sql = readFileSync(new URL(migration.name, MIGRATIONS_URL), 'utf8');
    db.transaction(() => {
      db.exec(sql);
      record.run(migration.version, migration.name, new Date().toISOString());
    })();
  }
}
