import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { sweepThreadMcpConfigs, sweepThreadKeyFiles } from '../../src/sessions/mcp-config-sweep.js';
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

describe('sweepThreadKeyFiles', () => {
  const OLD = 3_600_000;
  let data: string;
  let canary: string;
  beforeEach(() => {
    // nested sandbox: everything the sweep may touch is below `data`; the canary sits beside it
    data = path.join(dir, 'data');
    canary = path.join(dir, 'canary');
    fs.mkdirSync(data);
    fs.mkdirSync(canary);
    fs.writeFileSync(path.join(canary, 'victim'), 'keep');
  });
  afterEach(() => {
    expect(fs.readFileSync(path.join(canary, 'victim'), 'utf8')).toBe('keep');
  });
  function put(rel: string, ageMs = OLD): string {
    const f = path.join(data, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, '{}');
    const t = new Date(Date.now() - ageMs);
    fs.utimesSync(f, t, t);
    return f;
  }

  it('removes the named files of a thread that is not alive, and only those', () => {
    const mcp = put('hooks/grok-homes/dead1/plugins/dispatch/.mcp.json');
    const hooks = put('hooks/grok-homes/dead1/plugins/dispatch/hooks/hooks.json');
    const oc = put('hooks/opencode-homes/dead1/opencode.json');
    const rules = put('hooks/opencode-homes/dead1/rules.md');
    const key = put('keys/dead1.abcdef012345');
    const other = put('hooks/grok-homes/dead1/plugins/dispatch/other.txt');
    expect(sweepThreadKeyFiles(data, () => false)).toBe(4);
    for (const f of [mcp, hooks, oc, key]) expect(fs.existsSync(f)).toBe(false);
    for (const f of [rules, other]) expect(fs.existsSync(f)).toBe(true);
    // folders stay
    expect(fs.existsSync(path.join(data, 'hooks/grok-homes/dead1/plugins/dispatch'))).toBe(true);
  });

  it('keeps live threads, files younger than a minute, and other names in the key folder', () => {
    const live = put('keys/live1.aaaaaaaaaaaa');
    const young = put('keys/young1.bbbbbbbbbbbb', 1_000);
    const odd = put('keys/readme.txt.bak.x/inner');
    const liveOc = put('hooks/opencode-homes/live1/opencode.json');
    expect(sweepThreadKeyFiles(data, (id) => id === 'live1')).toBe(0);
    for (const f of [live, young, odd, liveOc]) expect(fs.existsSync(f)).toBe(true);
  });

  it('does not follow a symlinked file', () => {
    const target = path.join(canary, 'victim');
    fs.mkdirSync(path.join(data, 'keys'));
    fs.symlinkSync(target, path.join(data, 'keys', 'link1.cccccccccccc'));
    fs.mkdirSync(path.join(data, 'hooks/opencode-homes/link1'), { recursive: true });
    fs.symlinkSync(target, path.join(data, 'hooks/opencode-homes/link1/opencode.json'));
    expect(sweepThreadKeyFiles(data, () => false)).toBe(0);
  });

  it('does not follow a symlinked folder: the hooks entry of a Grok home, the plugins entry, or a whole thread folder', () => {
    // a Grok home whose top-level hooks entry is a symlink into the real home (canary stands in for it)
    fs.writeFileSync(path.join(canary, 'hooks.json'), 'keep-too');
    fs.writeFileSync(path.join(canary, '.mcp.json'), 'keep-three');
    const home = path.join(data, 'hooks/grok-homes/dead1');
    fs.mkdirSync(home, { recursive: true });
    fs.symlinkSync(canary, path.join(home, 'hooks'));
    // a plugins entry that is a symlink: plugins/dispatch/.mcp.json and plugins/dispatch/hooks/hooks.json resolve into the canary
    fs.symlinkSync(canary, path.join(home, 'plugins'));
    fs.mkdirSync(path.join(canary, 'dispatch/hooks'), { recursive: true });
    fs.writeFileSync(path.join(canary, 'dispatch/.mcp.json'), 'keep-four');
    fs.writeFileSync(path.join(canary, 'dispatch/hooks/hooks.json'), 'keep-five');
    old(path.join(canary, 'dispatch/.mcp.json'));
    old(path.join(canary, 'dispatch/hooks/hooks.json'));
    // a whole opencode folder that is a symlink
    fs.mkdirSync(path.join(data, 'hooks/opencode-homes'), { recursive: true });
    fs.writeFileSync(path.join(canary, 'opencode.json'), 'keep-six');
    old(path.join(canary, 'opencode.json'));
    fs.symlinkSync(canary, path.join(data, 'hooks/opencode-homes/dead2'));
    // the keys folder itself is a symlink
    fs.writeFileSync(path.join(canary, 'dead3.dddddddddddd'), 'keep-seven');
    old(path.join(canary, 'dead3.dddddddddddd'));
    fs.symlinkSync(canary, path.join(data, 'keys'));
    expect(sweepThreadKeyFiles(data, () => false)).toBe(0);
    for (const f of ['hooks.json', '.mcp.json', 'dispatch/.mcp.json', 'dispatch/hooks/hooks.json', 'opencode.json', 'dead3.dddddddddddd']) {
      expect(fs.existsSync(path.join(canary, f))).toBe(true);
    }
  });

  it('a missing data folder is fine', () => {
    expect(sweepThreadKeyFiles(path.join(data, 'nope'), () => false)).toBe(0);
  });

  function old(f: string): void {
    const t = new Date(Date.now() - OLD);
    fs.utimesSync(f, t, t);
  }
});
