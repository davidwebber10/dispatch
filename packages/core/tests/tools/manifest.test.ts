import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadManifest, validateEntry } from '../../src/tools/manifest.js';
import { installTool } from '../../src/tools/installer.js';

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

  it('aws is darwin-gated (its script recipe shells out to macOS-only pkgutil, no Linux variant yet)', () => {
    const m = loadManifest(base);
    const aws = m.find((e) => e.name === 'aws');
    expect(aws).toBeTruthy();
    expect(aws!.platforms).toEqual(['darwin']);
  });

  it('aws recipe unpacks into $TOOLS_PREFIX/opt/aws, so no link points into its mktemp dir (macOS purges $TMPDIR)', async () => {
    // Run the real recipe offline and on any OS: stub curl (writes an empty pkg), pkgutil (lays out
    // the aws-cli payload dir the way AWSCLIV2.pkg expands) and mktemp (macOS mktemp ignores TMPDIR,
    // so this is how the recipe's temp dir lands in ours) first on PATH.
    const stubs = path.join(root, 'stubs');
    const tmp = path.join(root, 'tmp');
    fs.mkdirSync(stubs); fs.mkdirSync(tmp);
    fs.writeFileSync(path.join(stubs, 'curl'), '#!/bin/sh\nwhile [ $# -gt 0 ]; do if [ "$1" = -o ]; then : > "$2"; fi; shift; done\n', { mode: 0o755 });
    fs.writeFileSync(path.join(stubs, 'mktemp'), `#!/bin/sh\nd="${tmp}/tmp.$$"; mkdir "$d"; echo "$d"\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(stubs, 'pkgutil'), [
      '#!/bin/sh',
      'd="$3/aws-cli.pkg/Payload/aws-cli"; mkdir -p "$d"',
      `printf '#!/bin/sh\\necho stub-aws\\n' > "$d/aws"; printf '#!/bin/sh\\n' > "$d/aws_completer"; chmod +x "$d/aws" "$d/aws_completer"`,
    ].join('\n'), { mode: 0o755 });
    const stale = path.join(base, 'opt', 'aws', 'stale');
    fs.mkdirSync(path.dirname(stale), { recursive: true });
    fs.writeFileSync(stale, 'x');
    vi.stubEnv('PATH', `${stubs}${path.delimiter}${process.env.PATH}`);
    try {
      expect(execFileSync('/bin/sh', ['-c', 'command -v curl'], { encoding: 'utf8' }).trim()).toBe(path.join(stubs, 'curl')); // never the network
      const aws = loadManifest(base).find((e) => e.name === 'aws')!;
      await installTool({ ...aws, platforms: undefined }, { base });
    } finally { vi.unstubAllEnvs(); }
    for (const b of ['aws', 'aws_completer']) {
      expect(fs.readlinkSync(path.join(base, 'bin', b))).toBe(path.join(base, 'opt', 'aws', b));
    }
    expect(execFileSync(path.join(base, 'bin', 'aws'), { encoding: 'utf8' })).toContain('stub-aws');
    expect(fs.existsSync(stale)).toBe(false); // an old copy is replaced, not merged into
    expect(fs.readdirSync(tmp)).toEqual([]); // the trap removed the mktemp dir
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
