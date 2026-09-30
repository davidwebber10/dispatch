// packages/core/tests/tools/installer.test.ts
import { it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { installTool, uninstallTool, readInstalled } from '../../src/tools/installer.js';
import { toolPaths, hostPlatformKey } from '../../src/tools/paths.js';
import type { ToolEntry } from '../../src/tools/types.js';

let base: string;
beforeEach(() => { base = fs.mkdtempSync(path.join(os.tmpdir(), 'tools-i-')); });
afterEach(() => { fs.rmSync(base, { recursive: true, force: true }); });

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
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'stg-'));
  fs.mkdirSync(path.join(stage, 'pkg'));
  fs.writeFileSync(path.join(stage, 'pkg', 'rg'), '#!/bin/sh\necho rg\n');
  const tgz = path.join(stage, 'a.tar.gz');
  execFileSync('tar', ['-czf', tgz, '-C', stage, 'pkg']);
  const buf = fs.readFileSync(tgz);
  const entry: ToolEntry = { name: 'ripgrep', description: 'd', kind: 'binary', bins: ['rg'], binary: { [plat]: { url: 'https://x/rg.tgz', archive: 'tar.gz', binPath: 'pkg/rg' } } };
  await installTool(entry, { base, download: async () => buf });
  expect(fs.existsSync(path.join(toolPaths(base).bin, 'rg'))).toBe(true);
  fs.rmSync(stage, { recursive: true, force: true });
});

it('script kind: runs the install script with TOOLS_BIN set', async () => {
  const entry: ToolEntry = { name: 'demo', description: 'd', kind: 'script', bins: ['demo'], script: { install: 'printf "#!/bin/sh\\n" > "$TOOLS_BIN/demo"; chmod +x "$TOOLS_BIN/demo"' } };
  await installTool(entry, { base });
  expect(fs.existsSync(path.join(toolPaths(base).bin, 'demo'))).toBe(true);
});

it('uninstallTool: removes the correct bin when tool name differs from binary name (e.g. ripgrep→rg)', () => {
  // Use the plain temp base — loadManifest will read the default bundle which has ripgrep with bins:['rg']
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

it('uninstallTool: a name that is not a plain tool name never removes anything outside opt/', () => {
  // Nest the tools dir two levels down so a regression that follows `../..` out of opt/ still
  // lands inside this test's own temp dir, never the shared $TMPDIR.
  const tools = path.join(base, 'home', 'tools');
  const p = toolPaths(tools);
  fs.mkdirSync(p.bin, { recursive: true });
  fs.writeFileSync(path.join(base, 'home', 'canary'), 'x');
  fs.writeFileSync(path.join(p.bin, 'jq'), 'x');
  fs.symlinkSync(path.join(p.pkgs, 'node_modules', '.bin', 'shopify'), path.join(p.bin, 'shopify')); // an npm link into the tools dir
  for (const name of ['..', '../..', '.', '']) uninstallTool(name, tools);
  expect(fs.existsSync(path.join(base, 'home', 'canary'))).toBe(true);
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

it('script kind: a changed recipe reinstalls even though the bins are still present', async () => {
  const counter = path.join(base, 'runs');
  const recipe = (tag: string): ToolEntry => ({
    name: 'demo', description: 'd', kind: 'script', bins: ['demo'],
    script: { install: [`echo ${tag} >> "${counter}"`, `printf '#!/bin/sh\\n' > "$TOOLS_BIN/demo"`, `chmod +x "$TOOLS_BIN/demo"`].join('; ') },
  });
  await installTool(recipe('v1'), { base });
  await installTool(recipe('v2'), { base });
  expect(fs.readFileSync(counter, 'utf8').trim().split('\n')).toEqual(['v1', 'v2']);
});

it('script kind: a legacy installed.json entry with no recipe fingerprint reinstalls', async () => {
  // Installs before the fingerprint recorded `{}` — e.g. the aws that linked into a purged $TMPDIR.
  const p = toolPaths(base);
  fs.mkdirSync(p.bin, { recursive: true });
  fs.writeFileSync(path.join(p.bin, 'demo'), '#!/bin/sh\n', { mode: 0o755 });
  fs.writeFileSync(p.installed, JSON.stringify({ demo: {} }));
  const counter = path.join(base, 'runs');
  const entry: ToolEntry = { name: 'demo', description: 'd', kind: 'script', bins: ['demo'], script: { install: `echo x >> "${counter}"` } };
  await installTool(entry, { base });
  expect(fs.readFileSync(counter, 'utf8').trim().split('\n')).toHaveLength(1);
  expect(readInstalled(base).demo).toEqual({ script: crypto.createHash('sha256').update(entry.script!.install).digest('hex') });
  await installTool(entry, { base }); // now fingerprinted: skipped
  expect(fs.readFileSync(counter, 'utf8').trim().split('\n')).toHaveLength(1);
});
