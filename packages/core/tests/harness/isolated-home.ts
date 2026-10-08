/**
 * Vitest setupFile for packages/core (wired in vitest.config.ts). It runs in every test
 * worker before the test file's own imports, and keeps the suite away from the real home
 * folder of whoever runs it:
 *
 * - HOME and USERPROFILE point at a fresh folder inside the run folder that
 *   tests/harness/isolated-home.global.ts made under os.tmpdir(). Several src/ defaults
 *   resolve under os.homedir() — createApp's SessionService writes
 *   ~/.dispatch/thread-<id>.mcp.json, its PushService writes ~/.dispatch/push.json — and
 *   os.homedir() reads HOME on every call, so module-level path constants see it too.
 * - The run folder's stub `claude` and `codex` go first on PATH, so no test starts the
 *   real agent CLIs.
 *
 * tests/harness/isolated-home.test.ts fails if this file stops doing its job.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, inject } from 'vitest';

const { root, bin } = inject('dispatchTestEnv');
const home = fs.mkdtempSync(path.join(root, 'home-'));

process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.PATH = `${bin}${path.delimiter}${process.env.PATH ?? ''}`;

// Tidy up per file; the globalSetup teardown removes anything left (e.g. all-skipped files).
afterAll(() => fs.rmSync(home, { recursive: true, force: true }));
