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
