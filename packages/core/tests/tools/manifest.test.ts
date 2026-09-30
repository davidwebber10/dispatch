import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadManifest, validateEntry } from '../../src/tools/manifest.js';

let root: string;
let base: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tools-'));
  base = path.join(root, 'tools');
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe('manifest', () => {
  it('returns the default bundle when no user file', () => {
    const m = loadManifest(base);
    const names = m.map((e) => e.name);
    expect(names).toContain('jq');
    expect(names).toContain('gh');
    expect(names).toContain('aws');
  });

  it('merges user entries and overrides by name', () => {
    fs.writeFileSync(path.join(root, 'tools.json'), JSON.stringify({
      tools: [
        { name: 'mytool', description: 'mine', kind: 'binary', bins: ['mytool'], binary: { 'darwin-arm64': { url: 'https://x/mytool', archive: 'none' } } },
        { name: 'jq', description: 'overridden jq', kind: 'binary', bins: ['jq'], binary: { 'darwin-arm64': { url: 'https://x/jq', archive: 'none' } } },
      ],
    }));
    const m = loadManifest(base);
    expect(m.find((e) => e.name === 'mytool')).toBeTruthy();
    expect(m.find((e) => e.name === 'jq')!.description).toBe('overridden jq');
  });

  it('drops invalid user entries', () => {
    fs.writeFileSync(path.join(root, 'tools.json'), JSON.stringify({
      tools: [{ name: 'bad' /* missing kind/bins */ }, 'nope'],
    }));
    const m = loadManifest(base);
    expect(m.find((e) => e.name === 'bad')).toBeFalsy();
  });

  it('validateEntry accepts a minimal binary entry and rejects junk', () => {
    expect(validateEntry({ name: 'x', description: 'd', kind: 'binary', bins: ['x'] })).toBe(true);
    expect(validateEntry({ name: 'x' })).toBe(false);
    expect(validateEntry(null)).toBe(false);
  });

  it('validateEntry accepts an authCheck with args or shell, and rejects a malformed one', () => {
    const base = { name: 'x', description: 'd', kind: 'binary', bins: ['x'] };
    expect(validateEntry({ ...base, authCheck: { args: ['auth', 'status'] } })).toBe(true);
    expect(validateEntry({ ...base, authCheck: { shell: 'x whoami', timeoutMs: 5000 } })).toBe(true);
    expect(validateEntry({ ...base, authCheck: 'x auth status' })).toBe(false);
    expect(validateEntry({ ...base, authCheck: null })).toBe(false);
    expect(validateEntry({ ...base, authCheck: {} })).toBe(false); // neither args nor shell
    expect(validateEntry({ ...base, authCheck: { args: ['a'], shell: 'b' } })).toBe(false); // both
    expect(validateEntry({ ...base, authCheck: { args: 'auth status' } })).toBe(false);
    expect(validateEntry({ ...base, authCheck: { args: ['auth', 1] } })).toBe(false);
    expect(validateEntry({ ...base, authCheck: { shell: 42 } })).toBe(false);
    expect(validateEntry({ ...base, authCheck: { args: ['a'], timeoutMs: 0 } })).toBe(false);
    expect(validateEntry({ ...base, authCheck: { args: ['a'], timeoutMs: '5000' } })).toBe(false);
  });

  it('validateEntry accepts unknownExitCodes as a list of exit codes 1–255', () => {
    const base = { name: 'x', description: 'd', kind: 'binary', bins: ['x'] };
    const withCodes = (unknownExitCodes: unknown) => validateEntry({ ...base, authCheck: { shell: 'x', unknownExitCodes } });
    expect(withCodes([124])).toBe(true);
    expect(withCodes([124, 125])).toBe(true);
    expect(withCodes(124)).toBe(false);
    expect(withCodes(['124'])).toBe(false);
    expect(withCodes([1.5])).toBe(false);
    expect(withCodes([0])).toBe(false); // exit 0 is always "ok"
    expect(withCodes([256])).toBe(false);
  });

  it('the default bundle carries real auth checks for gh, doppler, databricks and aws', () => {
    const m = loadManifest(base);
    const check = (n: string) => m.find((e) => e.name === n)!.authCheck;
    expect(check('gh')).toEqual({ args: ['auth', 'status'] });
    expect(check('doppler')).toEqual({ args: ['me', '--json'] });
    expect(check('databricks')).toEqual({ args: ['current-user', 'me', '-o', 'json'] });
    const aws = check('aws')!;
    expect(aws.args).toBeUndefined();
    expect(aws.shell).toContain('AWS_EC2_METADATA_DISABLED=true');
    expect(aws.shell).toContain('aws sts get-caller-identity');
    expect(aws.shell).toContain('aws configure list-profiles');
    expect(aws.unknownExitCodes).toEqual([124]); // the scan exits 124 when a call timed out and none succeeded
    expect(check('jq')).toBeUndefined();
  });

  it('aws is darwin-gated (its script recipe shells out to macOS-only pkgutil, no Linux variant yet)', () => {
    const m = loadManifest(base);
    const aws = m.find((e) => e.name === 'aws');
    expect(aws).toBeTruthy();
    expect(aws!.platforms).toEqual(['darwin']);
  });

  it('every binary tool has linux-x64 and linux-arm64 assets with a 64-char sha256', () => {
    const m = loadManifest(base);
    const binaryEntries = m.filter((e) => e.kind === 'binary');
    expect(binaryEntries.length).toBeGreaterThan(0);
    for (const e of binaryEntries) {
      for (const key of ['linux-x64', 'linux-arm64'] as const) {
        const asset = e.binary?.[key];
        expect(asset, `${e.name}: missing ${key} asset`).toBeTruthy();
        expect(asset!.sha256, `${e.name}: missing ${key} sha256`).toMatch(/^[0-9a-f]{64}$/);
      }
    }
  });
});
