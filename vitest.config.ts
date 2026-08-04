import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    // Gives each test file its own SQLite file — see vitest.setup.ts.
    setupFiles: ['./vitest.setup.ts'],
    reporters: ['default'],
  },
});
