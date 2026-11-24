import { expect, test, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildPlist, createDarwinDaemon } from '../../src/platform/daemon-darwin.js';

test('installedNode reads the node from the plist install wrote, null when there is no plist', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-plist-'));
  const plist = path.join(dir, 'x.plist');
  const d = createDarwinDaemon(vi.fn(() => ''), undefined, plist);
  expect(d.installedNode!()).toBeNull();
  fs.writeFileSync(plist, buildPlist({ port: 3456, nodePath: '/fnm/v24.14.0/bin/node', entry: '/r/server.js', repoRoot: '/r', logDir: dir, env: {} }));
  expect(d.installedNode!()).toBe('/fnm/v24.14.0/bin/node');
  fs.rmSync(dir, { recursive: true, force: true });
});
