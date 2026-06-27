// packages/core/tests/tools/installer.test.ts
import { it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { installTool, readInstalled } from '../../src/tools/installer.js';
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
