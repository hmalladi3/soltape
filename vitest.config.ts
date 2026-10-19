import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const src = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@soltape/shared': src('./packages/shared/src/index.ts'),
      '@soltape/decoder': src('./packages/decoder/src/index.ts'),
      '@soltape/service': src('./apps/service/src'),
      '@soltape/replay': src('./apps/replay/src'),

    },
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['apps/*/test/integration/**/*.test.ts'],
          environment: 'node',
          testTimeout: 30_000,
          hookTimeout: 180_000,
          fileParallelism: false,
        },
      },
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['packages/*/test/**/*.test.ts', 'apps/*/test/unit/**/*.test.ts', 'bench/test/**/*.test.ts'],
          environment: 'node',
        },
      },
    ],
  },
});
