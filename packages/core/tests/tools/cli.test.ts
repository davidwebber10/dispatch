// packages/core/tests/tools/cli.test.ts
import { it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { toolPaths, hostOsFamily } from '../../src/tools/paths.js';

// loadManifest() always merges in the real default bundle (jq/gh/aws/shopify/...), so a bulk
// `install` with no name would otherwise reach out over the network for real. Mock installTool
// so the bulk-install test never performs real downloads/installs; each test resets it back to
// delegate to the real implementation so the single-name gating test still exercises the real
// throw from installer.ts.
const mockInstallTool = vi.fn();
vi.mock('../../src/tools/installer.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/tools/installer.js')>();
  return { ...actual, installTool: (...args: Parameters<typeof actual.installTool>) => mockInstallTool(...args) };
});

import { runToolsCli } from '../../src/tools/cli.js';

let root: string;
let base: string;
beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tools-cli-'));
  base = path.join(root, 'tools');
  fs.writeFileSync(path.join(root, 'tools.json'), JSON.stringify({ tools: [
    { name: 'demo', description: 'demo tool', kind: 'binary', bins: ['demo'], binary: { 'darwin-arm64': { url: 'https://x/demo', archive: 'none' }, 'darwin-x64': { url: 'https://x/demo', archive: 'none' } } },
  ] }));
  const actual = await vi.importActual<typeof import('../../src/tools/installer.js')>('../../src/tools/installer.js');
  mockInstallTool.mockReset();
  mockInstallTool.mockImplementation((...args: Parameters<typeof actual.installTool>) => actual.installTool(...args));
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

it('list returns 0 and reports the manifest', async () => {
  const code = await runToolsCli(['list'], { base });
  expect(code).toBe(0);
});

it('uninstall removes a placed bin', async () => {
  fs.mkdirSync(toolPaths(base).bin, { recursive: true });
  fs.writeFileSync(path.join(toolPaths(base).bin, 'demo'), 'x');
  const code = await runToolsCli(['uninstall', 'demo'], { base });
  expect(code).toBe(0);
  expect(fs.existsSync(path.join(toolPaths(base).bin, 'demo'))).toBe(false);
});

it('install (bulk): skips a platform-gated entry without attempting install or failing the batch', async () => {
  const family = hostOsFamily();
  const otherFamily = family === 'darwin' ? 'linux' : 'darwin';
  fs.writeFileSync(path.join(root, 'tools.json'), JSON.stringify({ tools: [
    { name: 'demo', description: 'demo tool', kind: 'binary', bins: ['demo'], binary: { 'darwin-arm64': { url: 'https://x/demo', archive: 'none' }, 'darwin-x64': { url: 'https://x/demo', archive: 'none' } } },
    { name: 'gated', description: 'gated tool', kind: 'script', bins: ['gated'], platforms: [otherFamily], script: { install: `printf '#!/bin/sh\\n' > "$TOOLS_BIN/gated"; chmod +x "$TOOLS_BIN/gated"` } },
  ] }));
  mockInstallTool.mockImplementation(async () => {}); // stub out every real install for this test (bulk touches the full default bundle too)
  const logs: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation((msg?: unknown) => { logs.push(String(msg)); });
  const code = await runToolsCli(['install'], { base });
  log.mockRestore();
  expect(code).toBe(0); // skip must not flip the batch to failed
  expect(logs.some((l) => l.includes('skipping gated'))).toBe(true);
  expect(mockInstallTool).not.toHaveBeenCalledWith(expect.objectContaining({ name: 'gated' }), expect.anything());
  expect(mockInstallTool).toHaveBeenCalledWith(expect.objectContaining({ name: 'demo' }), expect.anything());
});

it('install (single, named): a platform-gated tool still fails with the installer\'s throw, not a silent skip', async () => {
  const family = hostOsFamily();
  const otherFamily = family === 'darwin' ? 'linux' : 'darwin';
  fs.writeFileSync(path.join(root, 'tools.json'), JSON.stringify({ tools: [
    { name: 'gated', description: 'gated tool', kind: 'script', bins: ['gated'], platforms: [otherFamily], script: { install: `printf '#!/bin/sh\\n' > "$TOOLS_BIN/gated"; chmod +x "$TOOLS_BIN/gated"` } },
  ] }));
  const err = vi.spyOn(console, 'error').mockImplementation(() => {});
  const code = await runToolsCli(['install', 'gated'], { base });
  err.mockRestore();
  expect(code).toBe(1); // real installTool() gating throw, not a skip
  expect(fs.existsSync(path.join(toolPaths(base).bin, 'gated'))).toBe(false);
});
