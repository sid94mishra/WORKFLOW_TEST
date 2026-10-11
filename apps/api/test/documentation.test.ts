import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const readme = readFileSync(new URL('../../../README.md', import.meta.url), 'utf8');

describe('Iteration 2 README documentation', () => {
  it('documents scheduler configuration, read endpoints, statuses, and security notes', () => {
    expect(readme).toContain('PULSE_MAX_CONCURRENCY');
    expect(readme).toContain('PULSE_ALLOW_PRIVATE');
    expect(readme).toContain('/api/v1/monitors/:id/results');
    expect(readme).toContain('/api/v1/monitors/:id/uptime');
    for (const status of ['pending', 'up', 'degraded', 'down', 'Paused']) {
      expect(readme).toContain(status);
    }
    expect(readme).toContain('blocks loopback/private/link-local/metadata and reserved ranges');
    expect(readme).toContain('pins validated DNS answers');
  });
});
