import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup, configure } from '@testing-library/react';

// The default 1s findBy*/waitFor ceiling is too tight when the whole workspace runs in parallel.
configure({ asyncUtilTimeout: 5_000 });

afterEach(() => {
  cleanup();
});
