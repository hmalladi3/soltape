import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const src = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@soltape/shared': src('./packages/shared/src/index.ts'),
      '@soltape/decoder': src('./packages/decoder/src/index.ts'),
    },
  },
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['packages/*/test/**/*.test.ts', 'apps/*/test/unit/**/*.test.ts'],
          environment: 'node',
        },
      },
    ],
  },
});
