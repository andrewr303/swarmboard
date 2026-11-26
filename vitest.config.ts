import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // HOST-0 closeout F5: CPU-bound tests (AT-01's 1000-seed fold, about 0.8 s alone) were measured at 7.4 s
    // under the full parallel suite with HOST-0's multi-process tests, past the 5 s default. Every test here
    // asserts its own result, so a longer timeout only stops load from failing a correct test.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
