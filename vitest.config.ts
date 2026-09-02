import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    reporters: ['default'],
    // Hidden-check and workspace tests shell out to git/pnpm.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
