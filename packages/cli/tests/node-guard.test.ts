import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { assertNodeVersion } from '../src/index.js';

// No child_process mock here: these run the real version probe against real binaries.
describe('assertNodeVersion with the real probe', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-nodeguard-')); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const fake = (version: string) => {
    const f = path.join(dir, `node-${version}`);
    fs.writeFileSync(f, `#!/bin/sh\necho ${version}\n`, { mode: 0o755 });
    return f;
  };

  test('passes for the node running the tests (recorded)', () => {
    expect(() => assertNodeVersion({ daemon: { installedNode: () => process.execPath } } as any)).not.toThrow();
  });

  test('passes with nothing recorded (fresh install) using the CLI node', () => {
    expect(() => assertNodeVersion({ daemon: {}, nodePath: process.execPath } as any)).not.toThrow();
  });

  test('a recorded node that does not exist fails closed and names the path', () => {
    const missing = path.join(dir, 'gone', 'node');
    const run = () => assertNodeVersion({ daemon: { installedNode: () => missing }, nodePath: process.execPath } as any);
    expect(run).toThrow(missing);
    expect(run).toThrow(/missing or cannot run/);
  });

  test('a recorded node below the minimum fails, and the advice includes the rebuild', () => {
    const old = fake('20.20.2');
    const run = () => assertNodeVersion({ daemon: { installedNode: () => old } } as any);
    expect(run).toThrow(/daemon's node .* is Node 20\.20\.2/);
    expect(run).toThrow(/dispatch build/);
  });

  test('nothing recorded and an old node: no "daemon\'s node", no "dispatch install"', () => {
    const old = fake('20.20.2');
    let msg = '';
    try { assertNodeVersion({ daemon: {}, nodePath: old } as any); } catch (e) { msg = (e as Error).message; }
    expect(msg).toMatch(/This shell runs Node 20\.20\.2/);
    expect(msg).not.toMatch(/daemon's node/);
    expect(msg).not.toMatch(/dispatch install/);
  });

  test('a recorded node that prints rubbish fails closed', () => {
    const bad = path.join(dir, 'bad');
    fs.writeFileSync(bad, '#!/bin/sh\necho hello\n', { mode: 0o755 });
    expect(() => assertNodeVersion({ daemon: { installedNode: () => bad } } as any)).toThrow(/missing or cannot run/);
  });
});
