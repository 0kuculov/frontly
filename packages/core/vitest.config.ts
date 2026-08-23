import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The DB suite shares one temp SQLite file across its cases and asserts on
    // ordering (book -> reject -> cancel -> rebook), so it must not interleave.
    fileParallelism: false,
    sequence: { concurrent: false },
    include: ['src/**/*.test.ts'],
  },
});
