import { defineConfig } from 'vitest/config';

const browser = process.env.BROWSER_CHECKS === '1';

export default defineConfig({
  test: {
    include: browser ? ['test/browser/**/*.test.ts'] : ['test/unit/**/*.test.ts', 'test/acceptance/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    // Each acceptance file boots its own workerd; run files one at a time for stable timing.
    fileParallelism: false,
    reporters: ['verbose'],
  },
});
