import { defineConfig } from 'vitest/config';
import os from 'node:os';
import react from '@vitejs/plugin-react';

// Cap the pool at half the cores, and each worker at 1.5 GB of heap: a runaway test then fails with an
// out-of-memory error in its own process instead of freezing the machine (2026-10-16: overlapping
// full runs used ~49 GB). The forks pool reads the top-level maxWorkers when maxForks is not set.
// os.availableParallelism() needs Node 18.14; engines says >=18, so fall back to the core count.
const maxWorkers = Math.max(1, Math.floor((os.availableParallelism?.() ?? os.cpus().length) / 2));

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    pool: 'forks',
    // Top level, so `--maxWorkers` on the CLI still overrides it (poolOptions.forks.maxForks would win over the CLI).
    // minWorkers is needed too: vitest 2.1.9 defaults the minimum to the core count, which then exceeds this cap.
    maxWorkers,
    minWorkers: 1,
    poolOptions: { forks: { execArgv: ['--max-old-space-size=1536'] } },
  },
});
