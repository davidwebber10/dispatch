import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadManifest, validateEntry } from '../../src/tools/manifest.js';
import { installTool, readInstalled } from '../../src/tools/installer.js';
import { toolPaths } from '../../src/tools/paths.js';

// Recipes run inside root/sandbox/tools: a `..` that escapes the tools dir still lands in this
// test's own temp dir, and the user manifest (sandbox/tools.json) is private to it.
let root: string;
let sandbox: string;
let base: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tools-'));
  sandbox = path.join(root, 'sandbox');
  base = path.join(sandbox, 'tools');
  fs.mkdirSync(sandbox);
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

// Runs the real aws recipe offline, on any OS, and only inside the sandbox. Stubs go first on PATH:
// curl writes an empty pkg (or, when asked, fails the way `curl -f` does); pkgutil lays out the
// aws-cli payload the way AWSCLIV2.pkg expands and records where; mktemp makes dirs only inside the
// sandbox (macOS mktemp ignores TMPDIR, so a bare `mktemp -d` goes to sandbox/tmp); mv, when asked,
// refuses to move the new payload (…/aws-cli) or the old copy back (…/old), or sends the recipe
// SIGTERM right after it moves the old copy aside (…/opt/aws), i.e. between the two renames.
async function installAwsWithStubs(opts: {
  curlFails?: boolean; payloadWorks?: boolean; payloadMoveFails?: boolean; restoreFails?: boolean; termAfterBackup?: boolean;
} = {}): Promise<void> {
  const stubs = path.join(root, 'stubs');
  fs.mkdirSync(stubs, { recursive: true });
  fs.mkdirSync(path.join(sandbox, 'tmp'), { recursive: true });
  const stub = (name: string, ...lines: string[]) => fs.writeFileSync(path.join(stubs, name), ['#!/bin/sh', ...lines, ''].join('\n'), { mode: 0o755 });
  stub('curl', opts.curlFails ? 'exit 22' : 'while [ $# -gt 0 ]; do if [ "$1" = -o ]; then : > "$2"; fi; shift; done');
  stub('pkgutil',
    `echo "$3" > "${root}/pkgutil-dest"`,
    'd="$3/aws-cli.pkg/Payload/aws-cli"; mkdir -p "$d"',
    `printf '#!/bin/sh\\necho aws-cli/2 stub\\nexit ${opts.payloadWorks === false ? 1 : 0}\\n' > "$d/aws"`,
    `printf '#!/bin/sh\\n' > "$d/aws_completer"`,
    'chmod +x "$d/aws" "$d/aws_completer"');
  stub('mktemp', `t="\${2:-${sandbox}/tmp/tmp.XXXXXX}"; case "$t" in "${sandbox}"/*XXXXXX) ;; *) exit 1 ;; esac`, 'd="${t%XXXXXX}$$"; mkdir "$d"; echo "$d"');
  stub('mv',
    ...(opts.payloadMoveFails ? ['case "$1" in */aws-cli) exit 1 ;; esac'] : []),
    ...(opts.restoreFails ? ['case "$1" in */old) exit 1 ;; esac'] : []),
    ...(opts.termAfterBackup ? ['case "$1" in */opt/aws) /bin/mv "$@"; kill -TERM "$PPID"; exit 0 ;; esac'] : []),
    'exec /bin/mv "$@"');
  vi.stubEnv('PATH', `${stubs}${path.delimiter}${process.env.PATH}`);
  try {
    expect(execFileSync('/bin/sh', ['-c', 'command -v curl'], { encoding: 'utf8' }).trim()).toBe(path.join(stubs, 'curl')); // never the network
    const aws = loadManifest(base).find((e) => e.name === 'aws')!;
    await installTool({ ...aws, platforms: undefined }, { base }); // the stubs stand in for macOS pkgutil on any host
  } finally { vi.unstubAllEnvs(); }
}

// A working aws from an earlier install: opt/aws with a marker only the old copy has, linked from bin.
function seedWorkingAws(): void {
  const p = toolPaths(base);
  fs.mkdirSync(path.join(p.opt, 'aws'), { recursive: true });
  fs.writeFileSync(path.join(p.opt, 'aws', 'aws'), '#!/bin/sh\necho aws-cli/1 old\n', { mode: 0o755 });
  fs.writeFileSync(path.join(p.opt, 'aws', 'old-only'), 'x');
  fs.mkdirSync(p.bin, { recursive: true });
  fs.symlinkSync(path.join(p.opt, 'aws', 'aws'), path.join(p.bin, 'aws'));
}

describe('manifest', () => {
  it('returns the default bundle when no user file', () => {
    const m = loadManifest(base);
    const names = m.map((e) => e.name);
    expect(names).toContain('jq');
    expect(names).toContain('gh');
    expect(names).toContain('aws');
  });

  it('merges user entries and overrides by name', () => {
    fs.writeFileSync(path.join(sandbox, 'tools.json'), JSON.stringify({
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
    fs.writeFileSync(path.join(sandbox, 'tools.json'), JSON.stringify({
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

  it('aws recipe stages under $TOOLS_PREFIX/opt and swaps the payload into opt/aws (macOS purges $TMPDIR)', async () => {
    const p = toolPaths(base);
    seedWorkingAws();
    await installAwsWithStubs();
    const dest = fs.readFileSync(path.join(root, 'pkgutil-dest'), 'utf8').trim();
    expect(path.dirname(path.dirname(dest))).toBe(p.opt); // expanded on the destination filesystem
    expect(path.basename(path.dirname(dest))).toMatch(/^\.aws-stage\./);
    for (const b of ['aws', 'aws_completer']) {
      expect(fs.readlinkSync(path.join(p.bin, b))).toBe(path.join(p.opt, 'aws', b));
    }
    expect(execFileSync(path.join(p.bin, 'aws'), { encoding: 'utf8' })).toContain('aws-cli/2 stub');
    expect(fs.existsSync(path.join(p.opt, 'aws', 'old-only'))).toBe(false); // the old copy is replaced, not merged into
    expect(fs.readdirSync(p.opt)).toEqual(['aws']); // the trap removed the stage dir and the old copy in it
    expect(fs.readdirSync(path.join(sandbox, 'tmp'))).toEqual([]); // nothing staged in $TMPDIR
  });

  it('aws recipe replaces a dangling symlink at opt/aws instead of failing on it', async () => {
    const p = toolPaths(base);
    fs.mkdirSync(p.opt, { recursive: true });
    fs.symlinkSync(path.join(sandbox, 'gone'), path.join(p.opt, 'aws'));
    await installAwsWithStubs();
    expect(fs.lstatSync(path.join(p.opt, 'aws')).isDirectory()).toBe(true);
    expect(execFileSync(path.join(p.bin, 'aws'), { encoding: 'utf8' })).toContain('aws-cli/2 stub');
    expect(fs.readdirSync(p.opt)).toEqual(['aws']);
  });

  it('aws recipe removes aws stage dirs older than an hour, and keeps a fresh one (a concurrent install)', async () => {
    const p = toolPaths(base);
    for (const d of ['.aws-stage.stale/x', '.aws-stage.fresh/x', '.other-stage.keep']) fs.mkdirSync(path.join(p.opt, d), { recursive: true });
    const twoHoursAgo = new Date(Date.now() - 2 * 3600_000);
    for (const d of ['.aws-stage.stale', '.other-stage.keep']) fs.utimesSync(path.join(p.opt, d), twoHoursAgo, twoHoursAgo);
    await installAwsWithStubs();
    expect(fs.readdirSync(p.opt).sort()).toEqual(['.aws-stage.fresh', '.other-stage.keep', 'aws']);
  });

  it('aws recipe first moves back an old copy that a SIGKILL between the renames left in a stage dir', async () => {
    // opt/aws is gone and the old copy sits in .aws-stage.*/old. Recovery runs before the download,
    // so even a failed download leaves the working copy in place.
    const p = toolPaths(base);
    seedWorkingAws();
    fs.mkdirSync(path.join(p.opt, '.aws-stage.killed'));
    fs.renameSync(path.join(p.opt, 'aws'), path.join(p.opt, '.aws-stage.killed', 'old'));
    await expect(installAwsWithStubs({ curlFails: true })).rejects.toThrow();
    expect(execFileSync(path.join(p.bin, 'aws'), { encoding: 'utf8' })).toContain('aws-cli/1 old');
    expect(fs.existsSync(path.join(p.opt, 'aws', 'old-only'))).toBe(true);
    expect(fs.existsSync(path.join(p.opt, '.aws-stage.killed', 'old'))).toBe(false);
  });

  it('aws recipe puts the old copy back when SIGTERM lands between the two renames', async () => {
    const p = toolPaths(base);
    seedWorkingAws();
    await expect(installAwsWithStubs({ termAfterBackup: true })).rejects.toThrow();
    expect(execFileSync(path.join(p.bin, 'aws'), { encoding: 'utf8' })).toContain('aws-cli/1 old');
    expect(fs.existsSync(path.join(p.opt, 'aws', 'old-only'))).toBe(true);
    expect(fs.readdirSync(p.opt)).toEqual(['aws']);
  });

  it('aws recipe keeps the stage dir, with the old copy in it, when it cannot put the old copy back', async () => {
    const p = toolPaths(base);
    seedWorkingAws();
    await expect(installAwsWithStubs({ payloadMoveFails: true, restoreFails: true })).rejects.toThrow();
    expect(fs.existsSync(path.join(p.opt, 'aws'))).toBe(false);
    const stages = fs.readdirSync(p.opt).filter((f) => f.startsWith('.aws-stage.'));
    expect(stages).toHaveLength(1);
    expect(fs.existsSync(path.join(p.opt, stages[0], 'old', 'old-only'))).toBe(true); // left for recovery, not deleted
  });

  it('aws recipe fails on a failed download, removes its stage dir, and leaves the working copy alone', async () => {
    const p = toolPaths(base);
    seedWorkingAws();
    await expect(installAwsWithStubs({ curlFails: true })).rejects.toThrow();
    expect(execFileSync(path.join(p.bin, 'aws'), { encoding: 'utf8' })).toContain('aws-cli/1 old');
    expect(fs.existsSync(path.join(p.opt, 'aws', 'old-only'))).toBe(true);
    expect(fs.readdirSync(p.opt)).toEqual(['aws']);
  });

  it('aws recipe keeps the working copy when the new payload fails `aws --version`', async () => {
    const p = toolPaths(base);
    seedWorkingAws();
    await expect(installAwsWithStubs({ payloadWorks: false })).rejects.toThrow();
    expect(execFileSync(path.join(p.bin, 'aws'), { encoding: 'utf8' })).toContain('aws-cli/1 old');
    expect(fs.existsSync(path.join(p.opt, 'aws', 'old-only'))).toBe(true);
    expect(fs.readdirSync(p.opt)).toEqual(['aws']);
  });

  it('aws recipe puts the old copy back and fails when the new payload cannot be renamed into place', async () => {
    const p = toolPaths(base);
    seedWorkingAws();
    await expect(installAwsWithStubs({ payloadMoveFails: true })).rejects.toThrow();
    expect(execFileSync(path.join(p.bin, 'aws'), { encoding: 'utf8' })).toContain('aws-cli/1 old');
    expect(fs.existsSync(path.join(p.opt, 'aws', 'old-only'))).toBe(true);
    expect(fs.readdirSync(p.opt)).toEqual(['aws']);
  });

  it('a legacy aws record ({}) whose bins still exist reruns the bundled recipe (the purged-$TMPDIR install)', async () => {
    const p = toolPaths(base);
    const purged = path.join(sandbox, 'purged-tmp', 'aws-cli'); // stands in for the old mktemp payload
    fs.mkdirSync(purged, { recursive: true });
    fs.writeFileSync(path.join(purged, 'aws'), '#!/bin/sh\nexit 1\n', { mode: 0o755 }); // the file survived; its python did not
    fs.mkdirSync(p.bin, { recursive: true });
    fs.symlinkSync(path.join(purged, 'aws'), path.join(p.bin, 'aws'));
    fs.symlinkSync(path.join(purged, 'aws_completer'), path.join(p.bin, 'aws_completer')); // dangling
    fs.writeFileSync(p.installed, JSON.stringify({ aws: {} }));
    await installAwsWithStubs();
    for (const b of ['aws', 'aws_completer']) {
      expect(fs.readlinkSync(path.join(p.bin, b))).toBe(path.join(p.opt, 'aws', b));
    }
    expect(readInstalled(base).aws.script).toMatch(/^[0-9a-f]{64}$/);
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
