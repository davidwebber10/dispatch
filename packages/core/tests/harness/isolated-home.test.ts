import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

// The core suite must never touch the real home folder of whoever runs it. Several src/
// defaults resolve under os.homedir() (SessionService writes ~/.dispatch/thread-*.mcp.json,
// PushService writes ~/.dispatch/push.json), and a spawned `claude` writes ~/.claude.json.
// tests/harness/isolated-home.ts (a vitest setupFile, fed by isolated-home.global.ts) points
// HOME at a throwaway folder and puts stub agent CLIs first on PATH before any test module
// loads. This file fails if that guard is missing or broken.
const realHome = os.userInfo().homedir;
const tmpRoot = fs.realpathSync(os.tmpdir());
const insideTmp = (p: string) => {
  const real = fs.realpathSync(p);
  return real.startsWith(tmpRoot + path.sep);
};

describe('test environment: isolated home folder', () => {
  test('HOME and os.homedir() are not the real home folder', () => {
    expect(process.env.HOME).toBeTruthy();
    expect(process.env.HOME).not.toBe(realHome);
    expect(os.homedir()).not.toBe(realHome);
  });

  test('HOME and os.homedir() sit inside the OS temp folder', () => {
    expect(insideTmp(process.env.HOME!)).toBe(true);
    expect(insideTmp(os.homedir())).toBe(true);
  });

  test('USERPROFILE (the Windows home) points at the same folder', () => {
    expect(process.env.USERPROFILE).toBe(process.env.HOME);
  });

  // Resolved by hand rather than by running anything: if the stubs were missing, running
  // `claude` here would start the real CLI — the very thing this guards against.
  test('the first claude and codex on PATH are test stubs inside the OS temp folder', () => {
    for (const cli of ['claude', 'codex']) {
      const first = (process.env.PATH ?? '')
        .split(path.delimiter)
        .filter(Boolean)
        .map((dir) => path.join(dir, cli))
        .find((p) => fs.existsSync(p));
      expect(first, cli).toBeTruthy();
      expect(insideTmp(first!), cli).toBe(true);
    }
  });
});
