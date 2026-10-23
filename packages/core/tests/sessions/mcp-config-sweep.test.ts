import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { sweepThreadMcpConfigs } from '../../src/sessions/mcp-config-sweep.js';
import { composeInjection } from '../../src/mcp/injection.js';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-sweep-')); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function touch(name: string, ageMs: number): string {
  const f = path.join(dir, name);
  fs.writeFileSync(f, '{}');
  const t = new Date(Date.now() - ageMs);
  fs.utimesSync(f, t, t);
  return f;
}

describe('sweepThreadMcpConfigs', () => {
  it('removes old files of threads that are not alive and keeps live and young ones', () => {
    const dead = touch('thread-dead1.mcp.json', 3_600_000);
    const live = touch('thread-live1.mcp.json', 3_600_000);
    const young = touch('thread-young1.mcp.json', 1_000);
    const other = touch('doppler.mcp.json', 3_600_000);
    const mcp = touch('mcp.json', 3_600_000);
    expect(sweepThreadMcpConfigs(dir, (id) => id === 'live1')).toBe(1);
    expect(fs.existsSync(dead)).toBe(false);
    for (const f of [live, young, other, mcp]) expect(fs.existsSync(f)).toBe(true);
  });

  it('ignores names that only look similar, and a missing folder', () => {
    const odd = touch('thread-a.b.mcp.json', 3_600_000);
    const sub = touch('thread-x.mcp.json.bak', 3_600_000);
    expect(sweepThreadMcpConfigs(dir, () => false)).toBe(0);
    expect(fs.existsSync(odd)).toBe(true);
    expect(fs.existsSync(sub)).toBe(true);
    expect(sweepThreadMcpConfigs(path.join(dir, 'nope'), () => false)).toBe(0);
  });

  it('does not follow a symlink', () => {
    const target = touch('keep.txt', 3_600_000);
    fs.symlinkSync(target, path.join(dir, 'thread-link1.mcp.json'));
    expect(sweepThreadMcpConfigs(dir, () => false)).toBe(0);
    expect(fs.existsSync(target)).toBe(true);
  });
});

describe('composeInjection file mode', () => {
  it('writes the config readable by the owner only, also over an older 0644 file', () => {
    const configPath = path.join(dir, 'thread-m1.mcp.json');
    fs.writeFileSync(configPath, 'old', { mode: 0o644 });
    composeInjection([{ name: 'x', command: 'node', args: [] }], { configPath, prompts: [] });
    expect(fs.statSync(configPath).mode & 0o777).toBe(0o600);
  });
});
