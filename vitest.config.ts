import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Resolve `@agenti-fy/shared` to its src entry instead of dist. Without this
// alias, vitest follows the package.json `main` field into dist/index.js, so
// running tests against an unbuilt or stale shared/ silently uses old code.
// In production, the dist build is still used (tsconfig + node resolution).
const sharedSrc = fileURLToPath(new URL('./packages/shared/src/index.ts', import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@agenti-fy/shared': sharedSrc,
    },
  },
  test: {
    globals: false,
    include: ['packages/*/src/**/*.test.ts', 'packages/*/test/**/*.test.ts'],
    environment: 'node',
    pool: 'forks',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['packages/*/src/**/*.ts'],
      exclude: ['packages/*/src/**/*.test.ts', '**/dist/**', '**/__smoke__/**'],
    },
  },
});
