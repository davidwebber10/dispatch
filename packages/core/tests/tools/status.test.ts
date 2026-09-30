import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { toolStatuses, getToolsSpawnEnv, awarenessNote } from '../../src/tools/status.js';
import { toolPaths, hostOsFamily } from '../../src/tools/paths.js';

let root: string;
let base: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tools-s-'));
  base = path.join(root, 'tools');
  fs.writeFileSync(path.join(root, 'tools.json'), JSON.stringify({ tools: [
    { name: 'gh', description: 'GitHub CLI', kind: 'binary', bins: ['gh'], authEnv: ['GH_TOKEN'], envAlias: { GH_TOKEN: 'GITHUB_TOKEN' }, binary: { 'darwin-arm64': { url: 'https://x/gh', archive: 'none' }, 'darwin-x64': { url: 'https://x/gh', archive: 'none' } } },
  ] }));
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

it('reports installed + authed status', () => {
  // not installed yet
  let st = toolStatuses({ base, env: {} }).find((s) => s.name === 'gh')!;
  expect(st.installed).toBe(false);
  expect(st.authed).toBe(false);
  // install a fake bin + provide auth env
  fs.mkdirSync(toolPaths(base).bin, { recursive: true });
  fs.writeFileSync(path.join(toolPaths(base).bin, 'gh'), '#!/bin/sh\n'); fs.chmodSync(path.join(toolPaths(base).bin, 'gh'), 0o755);
  st = toolStatuses({ base, env: { GH_TOKEN: 't' } }).find((s) => s.name === 'gh')!;
  expect(st.installed).toBe(true);
  expect(st.authed).toBe(true);
});

it('getToolsSpawnEnv prepends bin to PATH and resolves envAlias', () => {
  const env = getToolsSpawnEnv({ base, env: { PATH: '/usr/bin', GITHUB_TOKEN: 'ght' } });
  expect(env.PATH.startsWith(toolPaths(base).bin + path.delimiter)).toBe(true);
  expect(env.GH_TOKEN).toBe('ght'); // aliased from GITHUB_TOKEN
});

it('awarenessNote lists installed tools and flags unauthed', () => {
  const note = awarenessNote([
    { name: 'jq', description: 'JSON', kind: 'binary', installed: true, authed: true },
    { name: 'gh', description: 'GitHub CLI', kind: 'binary', installed: true, authed: false },
    { name: 'aws', description: 'AWS', kind: 'script', installed: false, authed: false },
  ]);
  expect(note).toContain('jq');
  expect(note).toContain('gh');
  expect(note).not.toContain('aws'); // not installed
  expect(note.toLowerCase()).toContain('not authenticated'); // gh flagged
});

it('awarenessNote is empty when nothing installed', () => {
  expect(awarenessNote([{ name: 'x', description: 'd', kind: 'binary', installed: false, authed: false }])).toBe('');
});

describe('authed merges the env rule with the cached auth check', () => {
  const statusOf = (name: string, env: Record<string, string>, checks?: Record<string, boolean>) =>
    toolStatuses({ base, env, checks }).find((s) => s.name === name)!.authed;
  beforeEach(() => {
    fs.writeFileSync(path.join(root, 'tools.json'), JSON.stringify({ tools: [
      { name: 'gh', description: 'GitHub CLI', kind: 'binary', bins: ['gh'], authEnv: ['GH_TOKEN'], envAlias: { GH_TOKEN: 'GITHUB_TOKEN' }, authCheck: { args: ['auth', 'status'] } },
      { name: 'dbx', description: 'check only', kind: 'binary', bins: ['dbx'], authCheck: { args: ['me'] } },
      { name: 'jq', description: 'no auth', kind: 'binary', bins: ['jq'] },
    ] }));
  });

  it('a passed check marks the tool authed even with no auth env (keyring / config-file logins)', () => {
    expect(statusOf('gh', {}, { gh: true })).toBe(true);
  });
  it('the auth env still counts when the check fails', () => {
    expect(statusOf('gh', { GH_TOKEN: 'fake' }, { gh: false })).toBe(true);
    expect(statusOf('gh', { GITHUB_TOKEN: 'fake' }, { gh: false })).toBe(true); // via envAlias
  });
  it('a failed check with no auth env is not authed', () => {
    expect(statusOf('gh', {}, { gh: false })).toBe(false);
  });
  it('with no check result yet, the env rule decides', () => {
    expect(statusOf('gh', {})).toBe(false);
    expect(statusOf('gh', { GH_TOKEN: 'fake' }, {})).toBe(true);
    expect(statusOf('dbx', {}, {})).toBe(true); // no authEnv: the env rule has nothing to require
  });
  it('a check-only entry follows its check result', () => {
    expect(statusOf('dbx', {}, { dbx: false })).toBe(false);
    expect(statusOf('dbx', {}, { dbx: true })).toBe(true);
  });
  it('an entry with neither authEnv nor authCheck stays authed, whatever the cache holds', () => {
    expect(statusOf('jq', {}, { jq: false })).toBe(true);
  });

  it('the awareness note follows the check, not the daemon env', () => {
    fs.mkdirSync(toolPaths(base).bin, { recursive: true });
    fs.writeFileSync(path.join(toolPaths(base).bin, 'gh'), '#!/bin/sh\n'); fs.chmodSync(path.join(toolPaths(base).bin, 'gh'), 0o755);
    const signedIn = awarenessNote(toolStatuses({ base, env: {}, checks: { gh: true } }));
    expect(signedIn).toContain('`gh` — GitHub CLI');
    expect(signedIn.toLowerCase()).not.toContain('not authenticated');
    const signedOut = awarenessNote(toolStatuses({ base, env: {}, checks: { gh: false } }));
    expect(signedOut).toContain('`gh` — GitHub CLI (not authenticated');
  });
});

it('toolStatuses excludes entries gated to another platform family and includes entries gated to this one', () => {
  const family = hostOsFamily();
  const otherFamily = family === 'darwin' ? 'linux' : 'darwin';
  fs.writeFileSync(path.join(root, 'tools.json'), JSON.stringify({ tools: [
    { name: 'gh', description: 'GitHub CLI', kind: 'binary', bins: ['gh'], binary: { 'darwin-arm64': { url: 'https://x/gh', archive: 'none' }, 'darwin-x64': { url: 'https://x/gh', archive: 'none' } } },
    { name: 'other-only', description: 'gated to the other family', kind: 'binary', bins: ['x'], platforms: [otherFamily], binary: { 'darwin-arm64': { url: 'https://x/x', archive: 'none' }, 'darwin-x64': { url: 'https://x/x', archive: 'none' } } },
    { name: 'this-only', description: 'gated to this family', kind: 'binary', bins: ['y'], platforms: [family], binary: { 'darwin-arm64': { url: 'https://x/y', archive: 'none' }, 'darwin-x64': { url: 'https://x/y', archive: 'none' } } },
  ] }));
  const names = toolStatuses({ base, env: {} }).map((s) => s.name);
  expect(names).not.toContain('other-only');
  expect(names).toContain('this-only');
  expect(names).toContain('gh'); // ungated entries are unaffected
});
