import { afterEach, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyUpdate } from '../src/update/apply.js';
import { platform } from '../src/platform/index.js';
const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true }); });

test.each(['build failure', 'missing executable'])('detached updater reports %s and preserves diagnostics', async kind => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-update-runtime-')); dirs.push(dir);
  const logs = path.join(dir, 'logs');
  vi.spyOn(platform, 'logDir').mockReturnValue(logs);
  fs.mkdirSync(path.join(dir, 'bin'));
  if (kind === 'build failure') fs.writeFileSync(path.join(dir, 'bin', 'dispatch'), '#!/bin/sh\necho build-output\necho compiler-failed >&2\nexit 7\n', { mode: 0o755 });
  const reason = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('No failure notification')), 5000);
    applyUpdate(dir, message => { clearTimeout(timeout); resolve(message); });
  });
  expect(reason).toContain('update.log');
  const log = fs.readFileSync(path.join(logs, 'update.log'), 'utf8');
  if (kind === 'build failure') {
    expect(reason).toContain('exit 7'); expect(log).toContain('build-output'); expect(log).toContain('compiler-failed');
  } else expect(reason).toContain('Could not start updater');
});
