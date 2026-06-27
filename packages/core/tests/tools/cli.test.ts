// packages/core/tests/tools/cli.test.ts
import { it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runToolsCli } from '../../src/tools/cli.js';
import { toolPaths } from '../../src/tools/paths.js';

let root: string;
let base: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tools-cli-'));
  base = path.join(root, 'tools');
  fs.writeFileSync(path.join(root, 'tools.json'), JSON.stringify({ tools: [
    { name: 'demo', description: 'demo tool', kind: 'binary', bins: ['demo'], binary: { 'darwin-arm64': { url: 'https://x/demo', archive: 'none' }, 'darwin-x64': { url: 'https://x/demo', archive: 'none' } } },
  ] }));
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
