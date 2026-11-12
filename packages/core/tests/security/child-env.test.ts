// No process the daemon starts gets a box secret (platform/box-secrets.ts, platform/inherited-env.ts).
// Each harness's manager and the PTY manager start a real child here; the child writes down its own
// environment, and the test reads it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { ClaudeStructuredSessionManager, type IStructuredManager } from '../../src/structured/manager.js';
import { CodexStructuredSessionManager } from '../../src/structured/codex-manager.js';
import { AcpStructuredSessionManager } from '../../src/structured/acp-manager.js';
import { PTYManager } from '../../src/pty/manager.js';
import { BOX_SECRET_NAMES, childEnv, inheritedEnv } from '../../src/platform/inherited-env.js';
import { osBoxToken, inboundBoxToken, resetBoxSecretsForTests, takeBoxSecrets } from '../../src/platform/box-secrets.js';

const DUMP = path.join(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/dump-env.mjs');
const INBOUND = 'inbound-box-token-SENTINEL-1';
const OUTBOUND = 'outbound-os-token-SENTINEL-2';

let dir: string;
let saved: NodeJS.ProcessEnv;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'child-env-'));
  saved = { ...process.env };
  // A daemon whose own environment holds both secrets (a build that did not take them out yet).
  Object.assign(process.env, { OS_BASE_URL: 'http://os.invalid', OS_BOX_TOKEN: OUTBOUND, DISPATCH_BOX_TOKEN: INBOUND });
});
afterEach(() => {
  resetBoxSecretsForTests();
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
  fs.rmSync(dir, { recursive: true, force: true });
});

async function dumped(file: string): Promise<Record<string, string>> {
  const end = Date.now() + 10_000;
  for (;;) {
    try { const text = fs.readFileSync(file, 'utf8'); if (text.trim().endsWith('}') || text.includes('\n')) return file.endsWith('.json') ? JSON.parse(text) : Object.fromEntries(text.split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)])); } catch { /* not written yet */ }
    if (Date.now() > end) throw new Error(`the child wrote no environment to ${file}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

function expectNoBoxSecret(env: Record<string, string>, who: string): void {
  for (const name of BOX_SECRET_NAMES) expect(env[name], `${who}: ${name}`).toBeUndefined();
  const all = JSON.stringify(env);
  expect(all, who).not.toContain(INBOUND);
  expect(all, who).not.toContain(OUTBOUND);
  // It is still a usable environment: PATH is there, and what the thread was given is there.
  expect(env.PATH, who).toBeTruthy();
}

describe('a child of the daemon never holds a box secret', () => {
  const harnesses: Array<[string, () => IStructuredManager]> = [
    ['claude-code', () => new ClaudeStructuredSessionManager()],
    ['codex', () => new CodexStructuredSessionManager() as unknown as IStructuredManager],
    ['grok', () => new AcpStructuredSessionManager('grok') as unknown as IStructuredManager],
    ['opencode', () => new AcpStructuredSessionManager('opencode') as unknown as IStructuredManager],
  ];

  test.each(harnesses)('%s: the harness process', async (name, make) => {
    const out = path.join(dir, `${name}.env.json`);
    const m = make();
    (m as unknown as { on(e: string, f: () => void): void }).on('error', () => {});
    // Every layer a spawn can carry tries to bring a secret back: the build's spawn env and the thread's own.
    m.setDefaultEnv({ FROM_SPAWN_ENV: 'yes', OS_BOX_TOKEN: OUTBOUND });
    try {
      m.spawn('t1', { command: process.execPath, args: [DUMP, out], workDir: dir, env: { FROM_THREAD: 'yes', DISPATCH_BOX_TOKEN: INBOUND } } as never);
    } catch { /* a manager may reject the scripted child's protocol later; the child has started */ }
    const env = await dumped(out);
    expectNoBoxSecret(env, name);
    expect(env.FROM_SPAWN_ENV).toBe('yes');
    expect(env.FROM_THREAD).toBe('yes');
    try { m.kill('t1'); (m as unknown as { killAll?: () => void }).killAll?.(); } catch { /* already gone */ }
  });

  test('a PTY shell', async () => {
    const out = path.join(dir, 'shell.env');
    const pty = new PTYManager({ FROM_SPAWN_ENV: 'yes', OS_BOX_TOKEN: OUTBOUND });
    pty.spawn('s1', '/bin/sh', ['-c', `env > "${out}"; sleep 0.2`], dir, { FROM_THREAD: 'yes', DISPATCH_BOX_TOKEN: INBOUND });
    const env = await dumped(out);
    expectNoBoxSecret(env, 'shell');
    expect(env.FROM_SPAWN_ENV).toBe('yes');
    expect(env.FROM_THREAD).toBe('yes');
    pty.killAll();
  });

  test('the one builder of a child environment removes the secrets from every layer', () => {
    const env = childEnv({ A: '1', OS_BOX_TOKEN: OUTBOUND }, undefined, { B: '2', DISPATCH_BOX_TOKEN: INBOUND, C: undefined });
    expect(env).toMatchObject({ A: '1', B: '2' });
    expectNoBoxSecret(env, 'childEnv');
    expectNoBoxSecret(inheritedEnv(), 'inheritedEnv');
    expect('PORT' in env).toBe(false); // the daemon's own port never rides into a child either
  });

  test('after the daemon took its secrets, even a child started with the daemon\'s whole environment has none', () => {
    takeBoxSecrets();
    expect(inboundBoxToken()).toBe(INBOUND);
    expect(osBoxToken()).toBe(OUTBOUND);
    // The careless ways to start a process: no env given (the child inherits), and a copy of process.env.
    for (const options of [{}, { env: { ...process.env } }, { env: process.env }]) {
      const r = spawnSync(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(process.env))'], { ...options, encoding: 'utf8' });
      expectNoBoxSecret(JSON.parse(r.stdout), 'a plain child');
    }
    const sh = spawnSync('/bin/sh', ['-c', 'env'], { encoding: 'utf8' });
    expect(sh.stdout).not.toContain('SENTINEL');
  });
});

describe('every spawn site of the daemon', () => {
  // A new spawn site that builds its own env from `process.env` would still be safe in the daemon (the
  // secrets are gone from it), but the rule is one builder: this keeps the count of exceptions visible.
  test('the thread managers, the PTY manager and the plugin runners build their env with childEnv', () => {
    const src = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../src');
    for (const f of ['structured/manager.ts', 'structured/codex-manager.ts', 'structured/acp-manager.ts', 'pty/manager.ts', 'plugins/workers.ts', 'plugins/hooks.ts']) {
      const text = fs.readFileSync(path.join(src, f), 'utf8');
      expect(text, f).toMatch(/[cC]hildEnv\(/);
      expect(text, f).not.toMatch(/\.\.\.process\.env/);
      expect(text, f).not.toMatch(/\.\.\.inheritedEnv\(\)/);
    }
  });
});
