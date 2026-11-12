// The snapshot of a file a thread posted, on a box with privilege separation (plugins/snapshots.ts):
// the project file is read as the agent user, and the copy lands in the daemon's own data folder.
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { snapshotPath, takeSnapshot } from '../../src/plugins/snapshots.js';
import type { PrivsepConfig } from '../../src/privsep/config.js';

const ID = '11111111-2222-3333-4444-555555555555';
let root: string;
let cfg: PrivsepConfig;
let project: string;
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'privsep-snap-')));
  const me = { uid: process.getuid!(), gid: process.getgid!() };
  // The test is not root: "the agent" is the test's own user, so the path rules are what is under test.
  cfg = { agentUid: me.uid, agentGid: me.gid, stateDir: path.join(root, 'gate', 'state'), agentRunDir: path.join(root, 'run'), agentHome: path.join(root, 'home'), agentDataDir: path.join(root, 'home', '.dispatch') };
  project = path.join(cfg.agentHome, 'projects', 'p1');
  fs.mkdirSync(cfg.stateDir, { recursive: true });
  fs.mkdirSync(project, { recursive: true });
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const take = (src: string, extra: Partial<Parameters<typeof takeSnapshot>[0]> = {}) => takeSnapshot({
  dataDir: cfg.stateDir, pluginId: 'previews', fileId: ID, src, root: project,
  roots: { home: cfg.agentHome, dataDir: cfg.stateDir }, privsep: cfg, ...extra,
});

describe('a snapshot on a box with privilege separation', () => {
  test('the copy holds the bytes, in the state folder, private to the daemon', async () => {
    const src = path.join(project, 'report.csv');
    fs.writeFileSync(src, 'a,b\n1,2\n');
    const name = await take(src);
    expect(name).toBe(`${ID}.csv`);
    const out = snapshotPath(cfg.stateDir, 'previews', name)!;
    expect(out.startsWith(cfg.stateDir + path.sep)).toBe(true);
    expect(fs.readFileSync(out, 'utf8')).toBe('a,b\n1,2\n');
    expect(fs.statSync(out).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(out)).mode & 0o777).toBe(0o700);
    // The copy does not follow the project file afterwards.
    fs.writeFileSync(src, 'changed');
    expect(fs.readFileSync(out, 'utf8')).toBe('a,b\n1,2\n');
  });

  test('a link in the project that leads to the daemon\'s state gives no copy', async () => {
    fs.writeFileSync(path.join(cfg.stateDir, 'settings.json'), '{"private":true}');
    const link = path.join(project, 'innocent.json');
    fs.symlinkSync(path.join(cfg.stateDir, 'settings.json'), link);
    expect(await take(link)).toBeNull();
    // A linked FOLDER that leads there: the same.
    fs.symlinkSync(cfg.stateDir, path.join(project, 'dir'));
    expect(await take(path.join(project, 'dir', 'settings.json'))).toBeNull();
    expect(fs.existsSync(path.join(cfg.stateDir, 'plugin-files'))).toBe(false);
  });

  test('a file over the limit, a folder and a credential give no copy', async () => {
    const big = path.join(project, 'big.txt');
    fs.writeFileSync(big, 'x'.repeat(2000));
    expect(await take(big, { maxBytes: 1000 })).toBeNull();
    fs.mkdirSync(path.join(project, 'folder.json'));
    expect(await take(path.join(project, 'folder.json'))).toBeNull();
    // A project that IS the home folder: a credential file in it is never copied.
    fs.mkdirSync(path.join(cfg.agentHome, '.docker'));
    const cred = path.join(cfg.agentHome, '.docker', 'config.json');
    fs.writeFileSync(cred, '{"auths":{}}');
    expect(await take(cred, { root: cfg.agentHome })).toBeNull();
    expect(fs.existsSync(path.join(cfg.stateDir, 'plugin-files', 'previews', `${ID}.json`))).toBe(false);
  });

  test('without privilege separation the copy is made as before', async () => {
    const src = path.join(project, 'note.md');
    fs.writeFileSync(src, '# hi\n');
    const name = await take(src, { privsep: null });
    expect(fs.readFileSync(snapshotPath(cfg.stateDir, 'previews', name)!, 'utf8')).toBe('# hi\n');
  });
});
