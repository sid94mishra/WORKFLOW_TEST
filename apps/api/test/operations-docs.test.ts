import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const root = new URL('../../../', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), 'utf8');
describe('operator documentation', () => {
  it('documents every declared Pulse environment variable', () => {
    const docs = read('docs/operations.md');
    const source = [
      read('apps/api/src/config.ts'),
      read('apps/web/vite.config.ts'),
      read('Dockerfile'),
      read('docker-compose.yml'),
      read('.env.example'),
    ].join('\n');
    const names = [...new Set(source.match(/\bPULSE_[A-Z0-9_]+\b/g) ?? [])];
    for (const name of names) {
      expect(docs).toContain(`| \`${name}\` |`);
    }
    for (const name of ['HOST', 'PORT', 'DATABASE_PATH', 'LOG_LEVEL'])
      expect(docs).toContain(`\`${name}\``);
    for (const name of [...new Set(docs.match(/`PULSE_[A-Z0-9_]+`/g) ?? [])]) {
      expect(names).toContain(name.slice(1, -1));
    }
    for (const section of [
      'Configuration',
      'First start',
      'Backups',
      'Upgrading',
      'Reverse proxy',
      'Account recovery',
      'Security checklist',
    ])
      expect(docs).toContain(`## ${section}`);
  });
});
