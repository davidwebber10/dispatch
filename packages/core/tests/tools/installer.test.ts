// packages/core/tests/tools/installer.test.ts
import { it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { installTool, uninstallTool, readInstalled } from '../../src/tools/installer.js';
import { toolPaths, hostPlatformKey } from '../../src/tools/paths.js';
import { loadManifest } from '../../src/tools/manifest.js';
import type { ToolEntry } from '../../src/tools/types.js';

// Recipes and uninstalls run inside root/sandbox/tools: a `..` that escapes the tools dir still
// lands in this test's own temp dir, and the user manifest (sandbox/tools.json) is private to it.
let root: string;
let sandbox: string;
let base: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tools-i-'));
  sandbox = path.join(root, 'sandbox');
  base = path.join(sandbox, 'tools');
  fs.mkdirSync(base, { recursive: true });
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

const plat = hostPlatformKey();

it('binary (archive:none): downloads, verifies sha256, places + chmods, idempotent', async () => {
  const payload = Buffer.from('#!/bin/sh\necho hi\n');
  const sha = crypto.createHash('sha256').update(payload).digest('hex');
  const entry: ToolEntry = { name: 'demo', description: 'd', kind: 'binary', bins: ['demo'], binary: { [plat]: { url: 'https://x/demo', sha256: sha, archive: 'none' } } };
  let calls = 0;
  const download = async () => { calls++; return payload; };
  await installTool(entry, { base, download });
  const binFile = path.join(toolPaths(base).bin, 'demo');
  expect(fs.existsSync(binFile)).toBe(true);
  expect(fs.statSync(binFile).mode & 0o111).toBeTruthy(); // executable
  expect(readInstalled(base).demo).toBeTruthy();
  await installTool(entry, { base, download }); // idempotent: no re-download
  expect(calls).toBe(1);
});

it('binary: sha256 mismatch aborts and installs nothing', async () => {
  const entry: ToolEntry = { name: 'demo', description: 'd', kind: 'binary', bins: ['demo'], binary: { [plat]: { url: 'https://x/demo', sha256: 'deadbeef', archive: 'none' } } };
  await expect(installTool(entry, { base, download: async () => Buffer.from('x') })).rejects.toThrow();
  expect(fs.existsSync(path.join(toolPaths(base).bin, 'demo'))).toBe(false);
});

it('binary (tar.gz): extracts binPath into bin/', async () => {
  // build a real tar.gz fixture with the system tar
  const stage = path.join(root, 'stg');
  fs.mkdirSync(path.join(stage, 'pkg'), { recursive: true });
  fs.writeFileSync(path.join(stage, 'pkg', 'rg'), '#!/bin/sh\necho rg\n');
  const tgz = path.join(stage, 'a.tar.gz');
  execFileSync('tar', ['-czf', tgz, '-C', stage, 'pkg']);
  const buf = fs.readFileSync(tgz);
  const entry: ToolEntry = { name: 'ripgrep', description: 'd', kind: 'binary', bins: ['rg'], binary: { [plat]: { url: 'https://x/rg.tgz', archive: 'tar.gz', binPath: 'pkg/rg' } } };
  await installTool(entry, { base, download: async () => buf });
  expect(fs.existsSync(path.join(toolPaths(base).bin, 'rg'))).toBe(true);
});

it('script kind: runs the install script with TOOLS_BIN set', async () => {
  const entry: ToolEntry = { name: 'demo', description: 'd', kind: 'script', bins: ['demo'], script: { install: 'printf "#!/bin/sh\\n" > "$TOOLS_BIN/demo"; chmod +x "$TOOLS_BIN/demo"' } };
  await installTool(entry, { base });
  expect(fs.existsSync(path.join(toolPaths(base).bin, 'demo'))).toBe(true);
});

it('uninstallTool: removes the correct bin when tool name differs from binary name (e.g. ripgrep→rg)', () => {
  // No user manifest in the sandbox — loadManifest will read the default bundle which has ripgrep with bins:['rg']
  const p = toolPaths(base);
  fs.mkdirSync(p.bin, { recursive: true });
  // Write a fake executable at bin/rg (as if ripgrep were installed)
  fs.writeFileSync(path.join(p.bin, 'rg'), '#!/bin/sh\necho rg\n', { mode: 0o755 });
  uninstallTool('ripgrep', base);
  expect(fs.existsSync(path.join(p.bin, 'rg'))).toBe(false);
});

it('uninstallTool: removes opt/<name> and every bin link into it, not only entry.bins (e.g. aws_completer)', async () => {
  const p = toolPaths(base);
  const install = [
    'mkdir -p "$TOOLS_PREFIX/opt/demo"',
    `printf '#!/bin/sh\\n' > "$TOOLS_PREFIX/opt/demo/demo"`,
    `printf '#!/bin/sh\\n' > "$TOOLS_PREFIX/opt/demo/demo_completer"`,
    'ln -sf "$TOOLS_PREFIX/opt/demo/demo" "$TOOLS_BIN/demo"',
    'ln -sf "$TOOLS_PREFIX/opt/demo/demo_completer" "$TOOLS_BIN/demo_completer"',
  ].join('; ');
  await installTool({ name: 'demo', description: 'd', kind: 'script', bins: ['demo'], script: { install } }, { base });
  // Bystanders: another tool's payload whose dir name shares the prefix, and a plain bin.
  fs.mkdirSync(path.join(p.opt, 'demo-other'), { recursive: true });
  fs.writeFileSync(path.join(p.opt, 'demo-other', 'other'), 'x');
  fs.symlinkSync(path.join(p.opt, 'demo-other', 'other'), path.join(p.bin, 'other'));
  fs.writeFileSync(path.join(p.bin, 'jq'), 'x');

  uninstallTool('demo', base);

  expect(fs.existsSync(path.join(p.opt, 'demo'))).toBe(false);
  expect(fs.readdirSync(p.bin).sort()).toEqual(['jq', 'other']); // no dangling demo_completer left behind
  expect(fs.existsSync(path.join(p.opt, 'demo-other', 'other'))).toBe(true);
  expect(readInstalled(base).demo).toBeUndefined();
});

it('uninstallTool: also removes opt/.<name>-stage.* dirs a dead or unnamed owner left, not a live owner\'s or another tool\'s', () => {
  const p = toolPaths(base);
  const dead = spawnSync('true').pid!; // that process has exited
  const owner = spawn('sleep', ['30'], { cwd: sandbox, stdio: 'ignore' });
  const live = `.demo-stage.${owner.pid}.d4`;
  try {
    for (const d of ['demo', '.demo-stage.a1/old', '.demo-stage.b2', `.demo-stage.${dead}.c3`, live, 'demo-other', '.demo-other-stage.c3']) {
      fs.mkdirSync(path.join(p.opt, d), { recursive: true });
    }
    uninstallTool('demo', base);
    expect(fs.readdirSync(p.opt).sort()).toEqual([live, '.demo-other-stage.c3', 'demo-other'].sort());
  } finally { owner.kill(); }
});

it('uninstallTool: refuses, and removes nothing, while an install holds opt/.<name>.lock', () => {
  const p = toolPaths(base);
  fs.mkdirSync(path.join(p.opt, 'demo'), { recursive: true });
  fs.mkdirSync(p.bin, { recursive: true });
  fs.symlinkSync(path.join(p.opt, 'demo', 'demo'), path.join(p.bin, 'demo'));
  fs.writeFileSync(p.installed, JSON.stringify({ demo: { script: 'x' } }));
  const owner = spawn('sleep', ['30'], { cwd: sandbox, stdio: 'ignore' });
  try {
    fs.mkdirSync(path.join(p.opt, '.demo.lock'));
    fs.writeFileSync(path.join(p.opt, '.demo.lock', 'pid'), String(owner.pid));
    expect(() => uninstallTool('demo', base)).toThrow(/install is running/);
    expect(fs.readFileSync(path.join(p.opt, '.demo.lock', 'pid'), 'utf8')).toBe(String(owner.pid));
  } finally { owner.kill(); }
  expect(fs.existsSync(path.join(p.opt, 'demo'))).toBe(true);
  expect(fs.lstatSync(path.join(p.bin, 'demo')).isSymbolicLink()).toBe(true);
  expect(readInstalled(base).demo).toEqual({ script: 'x' });
});

it('uninstallTool: takes over a lock whose owner is gone, and releases it', () => {
  const p = toolPaths(base);
  fs.mkdirSync(path.join(p.opt, 'demo'), { recursive: true });
  fs.mkdirSync(path.join(p.opt, '.demo.lock'));
  fs.writeFileSync(path.join(p.opt, '.demo.lock', 'pid'), String(spawnSync('true').pid)); // that process has exited
  uninstallTool('demo', base);
  expect(fs.readdirSync(p.opt)).toEqual([]);
});

it('uninstallTool: a name that is not a plain tool name never removes anything outside opt/', () => {
  // `../..` from opt/ is the sandbox dir, so a regression stays inside this test's temp dir.
  const p = toolPaths(base);
  fs.mkdirSync(p.bin, { recursive: true });
  fs.writeFileSync(path.join(sandbox, 'canary'), 'x');
  fs.writeFileSync(path.join(p.bin, 'jq'), 'x');
  fs.symlinkSync(path.join(p.pkgs, 'node_modules', '.bin', 'shopify'), path.join(p.bin, 'shopify')); // an npm link into the tools dir
  for (const name of ['..', '../..', '.', '']) uninstallTool(name, base);
  expect(fs.existsSync(path.join(sandbox, 'canary'))).toBe(true);
  expect(fs.readdirSync(p.bin).sort()).toEqual(['jq', 'shopify']);
});

it('platforms gating: installTool throws without running the script when the current OS is not listed', async () => {
  const otherFamily = plat.startsWith('darwin') ? 'linux' : 'darwin';
  const entry: ToolEntry = {
    name: 'demo', description: 'd', kind: 'script', bins: ['demo'], platforms: [otherFamily],
    script: { install: `printf '#!/bin/sh\\n' > "$TOOLS_BIN/demo"; chmod +x "$TOOLS_BIN/demo"` },
  };
  await expect(installTool(entry, { base })).rejects.toThrow(new RegExp(`not supported on.*supports: ${otherFamily}`));
  expect(fs.existsSync(path.join(toolPaths(base).bin, 'demo'))).toBe(false); // script never ran
});

it('platforms gating: installTool proceeds normally when the current OS is listed', async () => {
  const family = plat.split('-')[0];
  const entry: ToolEntry = {
    name: 'demo', description: 'd', kind: 'script', bins: ['demo'], platforms: [family],
    script: { install: `printf '#!/bin/sh\\n' > "$TOOLS_BIN/demo"; chmod +x "$TOOLS_BIN/demo"` },
  };
  await installTool(entry, { base });
  expect(fs.existsSync(path.join(toolPaths(base).bin, 'demo'))).toBe(true);
});

it('script kind: idempotent — second call is a no-op when binary already present', async () => {
  const counter = path.join(base, 'runs');
  const installScript = [
    `echo x >> "${counter}"`,
    `printf '#!/bin/sh\\n' > "$TOOLS_BIN/demo"`,
    `chmod +x "$TOOLS_BIN/demo"`,
  ].join('; ');
  const entry: ToolEntry = { name: 'demo', description: 'd', kind: 'script', bins: ['demo'], script: { install: installScript } };
  await installTool(entry, { base });
  await installTool(entry, { base }); // second call must short-circuit
  const lines = fs.readFileSync(counter, 'utf8').trim().split('\n');
  expect(lines).toHaveLength(1); // script ran exactly once
});

it('script kind: a changed user recipe reinstalls even though the bins are still present', async () => {
  const counter = path.join(base, 'runs');
  const recipe = (tag: string): ToolEntry => ({
    name: 'demo', description: 'd', kind: 'script', bins: ['demo'],
    script: { install: [`echo ${tag} >> "${counter}"`, `printf '#!/bin/sh\\n' > "$TOOLS_BIN/demo"`, `chmod +x "$TOOLS_BIN/demo"`].join('; ') },
  });
  await installTool(recipe('v1'), { base });
  await installTool(recipe('v2'), { base });
  expect(fs.readFileSync(counter, 'utf8').trim().split('\n')).toEqual(['v1', 'v2']);
});

it('script kind: a legacy record ({}) of a user tool whose bins exist is adopted without a run', async () => {
  // Installs before the fingerprint recorded `{}`. Rerunning a user recipe that is not idempotent
  // would fail every `dispatch update`, so its fingerprint is recorded instead. (The bundled aws
  // reruns; see manifest.test.ts.)
  const p = toolPaths(base);
  fs.mkdirSync(p.bin, { recursive: true });
  fs.writeFileSync(path.join(p.bin, 'demo'), '#!/bin/sh\n', { mode: 0o755 });
  fs.mkdirSync(path.join(base, 'demo')); // what the first run left
  fs.writeFileSync(p.installed, JSON.stringify({ demo: {} }));
  const counter = path.join(base, 'runs');
  const entry: ToolEntry = { name: 'demo', description: 'd', kind: 'script', bins: ['demo'], script: { install: `set -e; echo x >> "${counter}"; mkdir "$TOOLS_PREFIX/demo"` } };
  await installTool(entry, { base });
  expect(fs.existsSync(counter)).toBe(false); // never ran
  expect(readInstalled(base).demo).toEqual({ script: crypto.createHash('sha256').update(entry.script!.install).digest('hex') });
});

it('script kind: a user override of a bundled tool with its own recipe counts as a user tool', async () => {
  const p = toolPaths(base);
  const counter = path.join(base, 'runs');
  fs.writeFileSync(path.join(sandbox, 'tools.json'), JSON.stringify({ tools: [
    { name: 'aws', description: 'my aws', kind: 'script', bins: ['aws'], script: { install: `echo x >> "${counter}"` } },
  ] }));
  fs.mkdirSync(p.bin, { recursive: true });
  fs.writeFileSync(path.join(p.bin, 'aws'), '#!/bin/sh\n', { mode: 0o755 });
  fs.writeFileSync(p.installed, JSON.stringify({ aws: {} }));
  const entry = loadManifest(base).find((e) => e.name === 'aws')!;
  await installTool(entry, { base });
  expect(fs.existsSync(counter)).toBe(false);
  expect(readInstalled(base).aws.script).toMatch(/^[0-9a-f]{64}$/);
});
