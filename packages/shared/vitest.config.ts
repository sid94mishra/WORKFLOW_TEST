import { defineConfig } from 'vitest/config';
import { defaultClientConditions, defaultServerConditions } from 'vite';
export default defineConfig({
  resolve: { conditions: ['source', ...defaultClientConditions] },
  ssr: { resolve: { conditions: ['source', ...defaultServerConditions] } },
  test: { environment: 'node' },
});
