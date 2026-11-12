import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ClaudeStructuredSessionManager } from './manager.js';

// Owner, 2026-11-12: "Claude Design tools are not available in Pretty mode; I have to switch to CLI".
// Claude Code turns its Artifact tools off in print mode (`claude -p`, reason "sdk_default_off"), and
// Pretty threads run in print mode. CLAUDE_CODE_ARTIFACT=1 turns them on again (checked against CLI
// 2.1.322: 24 tools without it, 27 with Artifact, ArtifactComments and ArtifactData). A value the owner
// set in the daemon's environment, or a thread's own env, still wins.

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-env-'));
const seen = (out: string) => new Promise<string>((resolve, reject) => {
  const end = Date.now() + 5000;
  const tick = () => {
    if (fs.existsSync(out)) return resolve(fs.readFileSync(out, 'utf8'));
    if (Date.now() > end) return reject(new Error('the child wrote nothing'));
    setTimeout(tick, 25);
  };
  tick();
});
const probe = (out: string) => ['-e', `require('fs').writeFileSync(${JSON.stringify(out)}, process.env.CLAUDE_CODE_ARTIFACT ?? 'unset')`];

describe('Pretty Claude threads get the Artifact tools', () => {
  const saved = process.env.CLAUDE_CODE_ARTIFACT;
  afterEach(() => { if (saved === undefined) delete process.env.CLAUDE_CODE_ARTIFACT; else process.env.CLAUDE_CODE_ARTIFACT = saved; });

  it('sets CLAUDE_CODE_ARTIFACT=1 for the claude child', async () => {
    delete process.env.CLAUDE_CODE_ARTIFACT;
    const m = new ClaudeStructuredSessionManager();
    const out = path.join(tmp, 'a');
    m.spawn('t-a', { command: process.execPath, args: probe(out), workDir: tmp } as never);
    expect(await seen(out)).toBe('1');
    m.kill('t-a');
  });

  it('keeps a value set in the daemon environment', async () => {
    process.env.CLAUDE_CODE_ARTIFACT = '0';
    const m = new ClaudeStructuredSessionManager();
    const out = path.join(tmp, 'b');
    m.spawn('t-b', { command: process.execPath, args: probe(out), workDir: tmp } as never);
    expect(await seen(out)).toBe('0');
    m.kill('t-b');
  });

  it('keeps a value from the thread env', async () => {
    delete process.env.CLAUDE_CODE_ARTIFACT;
    const m = new ClaudeStructuredSessionManager();
    const out = path.join(tmp, 'c');
    m.spawn('t-c', { command: process.execPath, args: probe(out), workDir: tmp, env: { CLAUDE_CODE_ARTIFACT: 'false' } } as never);
    expect(await seen(out)).toBe('false');
    m.kill('t-c');
  });
});
