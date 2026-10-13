import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    // Files needing a DOM opt in with a `@vitest-environment jsdom` docblock.
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    globals: false,
  },
});