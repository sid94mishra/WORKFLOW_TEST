import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const root = new URL('../../../', import.meta.url);
const text = (name: string) => readFileSync(new URL(name, root), 'utf8');
describe('container deployment files', () => {
  it('keeps the image small and safe by construction', () => {
    const dockerfile = text('Dockerfile');
    const from = dockerfile.match(/^FROM\s+([^\s]+)/gm) ?? [];
    expect(from.length).toBeGreaterThanOrEqual(2);
    expect(from.every((line) => /node:22[^\s]*-alpine/i.test(line))).toBe(true);
    const runtime = dockerfile.slice(dockerfile.lastIndexOf('FROM '));
    expect(runtime).toMatch(/USER\s+node\s*$/m);
    expect(runtime).toMatch(/HEALTHCHECK[\s\S]*\/health/);
    expect(dockerfile).toMatch(/VOLUME\s+\["\/data"\]/);
    expect(runtime).toContain('DATABASE_PATH=/data/pulse.db');
    expect(runtime).toMatch(/EXPOSE\s+3000/);
    expect(runtime).not.toMatch(/^(?:ARG|ENV).*?(?:PASSWORD|SECRET)/m);
    expect(text('.dockerignore').startsWith('*\n')).toBe(true);
    const compose = text('docker-compose.yml');
    expect(compose).toContain('pulse-data:/data');
    expect(compose).toMatch(/PULSE_ADMIN_EMAIL:\s*\$\{PULSE_ADMIN_EMAIL:\?set in \.env\}/);
    expect(compose).toMatch(/PULSE_ADMIN_PASSWORD:\s*\$\{PULSE_ADMIN_PASSWORD:\?set in \.env\}/);
    expect(text('.env.example')).toContain('PULSE_ADMIN_EMAIL=admin@example.com');
    expect(text('.env.example')).toMatch(/^PULSE_ADMIN_PASSWORD=change-me/m);
    expect(text('.env.example')).not.toMatch(/^PULSE_SESSION_SECRET=/m);
  });
});
