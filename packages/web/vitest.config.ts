import { defineConfig } from 'vitest/config';
import os from 'node:os';
import react from '@vitejs/plugin-react';

// Cap the pool at half the cores, and each worker at 1.5 GB of heap: a runaway test then fails with an
// out-of-memory error in its own process instead of freezing the machine (2026-10-16: overlapping
// full runs used ~49 GB). Vitest 2.x names the cap per pool; the default pool is forks.
const maxForks = Math.max(1, Math.floor(os.availableParallelism() / 2));

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    pool: 'forks',
    poolOptions: { forks: { minForks: 1, maxForks, execArgv: ['--max-old-space-size=1536'] } },
  },
});
