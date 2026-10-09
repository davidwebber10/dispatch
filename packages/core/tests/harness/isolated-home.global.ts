/**
 * Vitest globalSetup for packages/core (wired in vitest.config.ts). Creates one run folder
 * under os.tmpdir() holding stub `claude` and `codex` binaries, hands its location to the
 * per-file setupFile (tests/harness/isolated-home.ts), and removes the whole folder when
 * the run ends — including the fake homes of files whose tests were all skipped, where a
 * per-file afterAll never runs.
 *
 * The stubs exist so no test can start the real agent CLIs: a structured claude-code
 * terminal spawns `claude -p`, which writes ~/.claude.json and can reach the account's
 * credentials. They fail like a broken install — exit 127 with a note on stderr.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { GlobalSetupContext } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    dispatchTestEnv: { root: string; bin: string };
  }
}

export default function setup({ provide }: GlobalSetupContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-test-env-'));
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  for (const cli of ['claude', 'codex']) {
    fs.writeFileSync(
      path.join(bin, cli),
      `#!/bin/sh\necho "${cli}: the real CLI is blocked in the core test suite (tests/harness/isolated-home.global.ts)" >&2\nexit 127\n`,
      { mode: 0o755 },
    );
  }
  provide('dispatchTestEnv', { root, bin });
  return () => fs.rmSync(root, { recursive: true, force: true });
}
