import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    root: '.',
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    // Fake HOME + stub agent CLIs for every test file, so the suite never writes into the
    // real home folder (~/.dispatch, ~/.claude.json). Guarded by tests/harness/isolated-home.test.ts.
    globalSetup: ['./tests/harness/isolated-home.global.ts'],
    setupFiles: ['./tests/harness/isolated-home.ts'],
    // Vitest defaults to 5s. These suites do real work — sqlite files, spawned processes,
    // supertest servers — and with 130 files across every core the slowest occasionally
    // crossed that line, failing a DIFFERENT test on each run at ~5003ms. The tests were
    // never wrong; the budget was too tight for a contended machine.
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
