import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
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
// refuses to move the new payload (…/aws-cli) or the old copy back (…/old), or acts right after the
// recipe moves the old copy aside (…/opt/aws): sends it SIGTERM, or moves the copy straight back the
// way a second installer's recovery would; or creates opt/aws just before the new payload's rename.
// rm, when given a pid, kills that process (and waits until it is gone) as the prune pass removes
// the .aws-stage.0first dir, which sorts first: so that owner is alive for recovery, dead for prune.
async function installAwsWithStubs(opts: {
  curlFails?: boolean; payloadWorks?: boolean; payloadMoveFails?: boolean; restoreFails?: boolean;
  termAfterBackup?: boolean; backupStolen?: boolean; optCreatedAtRename?: boolean; killAtPrune?: number;
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
    ...(opts.backupStolen ? ['case "$1" in */opt/aws) /bin/mv "$@"; /bin/mv "$2" "$1"; exit 0 ;; esac'] : []),
    ...(opts.optCreatedAtRename ? ['case "$1" in */aws-cli) mkdir -p "$2" ;; esac'] : []),
    'exec /bin/mv "$@"');
  if (opts.killAtPrune) stub('rm',
    `case "$*" in *.aws-stage.0first*) kill ${opts.killAtPrune}; i=0; while kill -0 ${opts.killAtPrune} 2>/dev/null && [ $i -lt 100 ]; do sleep 0.05; i=$((i+1)); done ;; esac`,
    'exec /bin/rm "$@"');
  vi.stubEnv('PATH', `${stubs}${path.delimiter}${process.env.PATH}`);
  try {
    expect(execFileSync('/bin/sh', ['-c', 'command -v curl'], { encoding: 'utf8' }).trim()).toBe(path.join(stubs, 'curl')); // never the network
    const aws = loadManifest(base).find((e) => e.name === 'aws')!;
    await installTool({ ...aws, platforms: undefined }, { base }); // the stubs stand in for macOS pkgutil on any host
  } finally { vi.unstubAllEnvs(); }
}

// The recipe's lock, as another installer (pid) would hold it.
function lockAws(pid: number): void {
  const lock = path.join(toolPaths(base).opt, '.aws.lock');
  fs.mkdirSync(lock, { recursive: true });
  fs.writeFileSync(path.join(lock, 'pid'), String(pid));
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

  it('aws recipe stages under $TOOLS_PREFIX/opt and swaps the payload into opt/aws (macOS purges $TMPDIR)', async () => {
    const p = toolPaths(base);
    seedWorkingAws();
    await installAwsWithStubs();
    const dest = fs.readFileSync(path.join(root, 'pkgutil-dest'), 'utf8').trim();
    expect(path.dirname(path.dirname(dest))).toBe(p.opt); // expanded on the destination filesystem
    expect(path.basename(path.dirname(dest))).toMatch(/^\.aws-stage\.[1-9]\d*\.[^.]+$/); // .aws-stage.<owner pid>.<random>
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

  it('aws recipe prunes stage dirs whose owner is gone or unnamed (older format), never a live owner\'s', async () => {
    const p = toolPaths(base);
    const dead = spawnSync('true').pid!; // that process has exited
    const owner = spawn('sleep', ['30'], { cwd: sandbox, stdio: 'ignore' });
    const live = `.aws-stage.${owner.pid}.def456`;
    try {
      for (const d of ['.aws-stage.fresh/x', `.aws-stage.${dead}.abc123/x`, `${live}/x`, '.other-stage.keep']) fs.mkdirSync(path.join(p.opt, d), { recursive: true });
      await installAwsWithStubs();
      expect(fs.readdirSync(p.opt).sort()).toEqual([live, '.other-stage.keep', 'aws'].sort()); // and the lock is released
    } finally { owner.kill(); }
  });

  it('aws recipe, after taking over a stale lock, leaves a live installer\'s stage and backup alone and recovers a dead one\'s', async () => {
    // A double takeover: install A still runs (a live pid in its stage name) with opt/aws moved into
    // its stage. This install must not take A's old/ (even though it is the newest) nor prune A's stage.
    const p = toolPaths(base);
    const dead = spawnSync('true').pid!;
    const owner = spawn('sleep', ['30'], { cwd: sandbox, stdio: 'ignore' });
    const live = `.aws-stage.${owner.pid}.bbbbbb`;
    try {
      lockAws(dead);
      for (const [d, copy] of [[`.aws-stage.${dead}.aaaaaa`, 'dead-copy'], [live, 'live-copy']]) {
        fs.mkdirSync(path.join(p.opt, d, 'old'), { recursive: true });
        fs.writeFileSync(path.join(p.opt, d, 'old', 'which'), copy);
      }
      const hourAgo = new Date(Date.now() - 3600_000);
      fs.utimesSync(path.join(p.opt, `.aws-stage.${dead}.aaaaaa`, 'old'), hourAgo, hourAgo);
      await expect(installAwsWithStubs({ curlFails: true })).rejects.toThrow(); // recovery and prune run before the download
      expect(fs.readFileSync(path.join(p.opt, 'aws', 'which'), 'utf8')).toBe('dead-copy');
      expect(fs.readFileSync(path.join(p.opt, live, 'old', 'which'), 'utf8')).toBe('live-copy');
      expect(fs.readdirSync(p.opt).sort()).toEqual([live, 'aws'].sort()); // the dead stage is pruned, the lock released
    } finally { owner.kill(); }
  });

  it('aws recipe exits non-zero without touching opt/aws while another installer holds the lock', async () => {
    const p = toolPaths(base);
    seedWorkingAws();
    const owner = spawn('sleep', ['30'], { cwd: sandbox, stdio: 'ignore' });
    try {
      lockAws(owner.pid!);
      await expect(installAwsWithStubs()).rejects.toThrow();
      expect(fs.readFileSync(path.join(p.opt, '.aws.lock', 'pid'), 'utf8')).toBe(String(owner.pid)); // not taken, not released
    } finally { owner.kill(); }
    expect(execFileSync(path.join(p.bin, 'aws'), { encoding: 'utf8' })).toContain('aws-cli/1 old');
    expect(fs.existsSync(path.join(p.opt, 'aws', 'old-only'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'pkgutil-dest'))).toBe(false); // never got as far as the download
    expect(fs.readdirSync(p.opt).sort()).toEqual(['.aws.lock', 'aws']);
  });

  it('aws recipe takes over a lock whose owner is gone', async () => {
    const p = toolPaths(base);
    seedWorkingAws();
    lockAws(spawnSync('true').pid!); // that process has exited
    await installAwsWithStubs();
    expect(execFileSync(path.join(p.bin, 'aws'), { encoding: 'utf8' })).toContain('aws-cli/2 stub');
    expect(fs.readdirSync(p.opt)).toEqual(['aws']); // and released it
  });

  it('aws recipe fails, and does not nest the payload, when opt/aws comes back after it moved the old copy aside', async () => {
    // A second installer that ignores the lock moves our backup straight back (the round-3 race):
    // `mv "$PFX" "$OPT"` would put the new payload at opt/aws/aws-cli and still exit 0.
    const p = toolPaths(base);
    seedWorkingAws();
    await expect(installAwsWithStubs({ backupStolen: true })).rejects.toThrow();
    expect(fs.existsSync(path.join(p.opt, 'aws', 'aws-cli'))).toBe(false);
    expect(execFileSync(path.join(p.bin, 'aws'), { encoding: 'utf8' })).toContain('aws-cli/1 old');
    expect(readInstalled(base).aws).toBeUndefined(); // no fingerprint, so the next update retries
    expect(fs.readdirSync(p.opt)).toEqual(['aws']);
  });

  it('aws recipe fails, and keeps the old copy, when the new payload does not land at opt/aws', async () => {
    // opt/aws appears between the check and the rename, so mv nests the payload inside it.
    const p = toolPaths(base);
    seedWorkingAws();
    await expect(installAwsWithStubs({ optCreatedAtRename: true })).rejects.toThrow();
    expect(readInstalled(base).aws).toBeUndefined();
    const stages = fs.readdirSync(p.opt).filter((f) => f.startsWith('.aws-stage.'));
    expect(stages).toHaveLength(1);
    expect(fs.existsSync(path.join(p.opt, stages[0], 'old', 'old-only'))).toBe(true); // kept for recovery
    expect(fs.existsSync(path.join(p.opt, '.aws.lock'))).toBe(false);
  });

  it('aws recipe recovers, rather than prunes, the only copy when its owner dies between the recovery and prune passes', async () => {
    // Install A holds opt/aws in its stage's old/ and is alive while this install's recovery pass
    // looks (so it is skipped), then dies before the prune pass. The download then fails, so the
    // only copy left must be the one prune moved back.
    const p = toolPaths(base);
    // A double-forked sleep: launchd/init reaps it once killed, so `kill -0` sees it gone even while
    // this test process sits blocked in execSync.
    const owner = Number(execFileSync('/bin/sh', ['-c', 'sleep 30 </dev/null >/dev/null 2>&1 & echo $!'], { cwd: sandbox, encoding: 'utf8' }).trim());
    expect(owner).toBeGreaterThan(1); // the rm stub runs `kill <owner>`: never 0 (our group) or 1
    const stageA = `.aws-stage.${owner}.aaaaaa`;
    try {
      seedWorkingAws();
      fs.mkdirSync(path.join(p.opt, stageA));
      fs.renameSync(path.join(p.opt, 'aws'), path.join(p.opt, stageA, 'old'));
      fs.mkdirSync(path.join(p.opt, '.aws-stage.0first'));
      lockAws(spawnSync('true').pid!); // the stale lock this install takes over
      await expect(installAwsWithStubs({ curlFails: true, killAtPrune: owner })).rejects.toThrow();
    } finally { try { process.kill(owner); } catch { /* already gone */ } }
    expect(execFileSync(path.join(p.bin, 'aws'), { encoding: 'utf8' })).toContain('aws-cli/1 old');
    expect(fs.existsSync(path.join(p.opt, 'aws', 'old-only'))).toBe(true);
    expect(fs.readdirSync(p.opt)).toEqual(['aws']);
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
