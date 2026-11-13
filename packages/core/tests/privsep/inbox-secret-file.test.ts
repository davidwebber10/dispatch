// An inbox secret written into a project file on a box with privilege separation: the daemon (root there)
// makes no change below the home with its own rights. The read of the old file, the folder, the new file
// and the rename go through the agent user (privsep/agent-fs.ts). Here the "agent" is this test's own user;
// the test shows that the privsep path is taken and gives the same result as the plain one.
import { describe, test, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setPrivsepForTest } from '../../src/privsep/config.js';
import { writeSecretFile } from '../../src/inbox/write-file.js';
import { defaultSecretRoots } from '../../src/files/secret-paths.js';

describe('writeSecretFile with privilege separation', () => {
  afterEach(() => setPrivsepForTest(undefined));

  test('writes a new file and upserts a dotenv line through the agent-side operations', async () => {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-privsep-')));
    const project = path.join(home, 'projects', 'p');
    fs.mkdirSync(project, { recursive: true });
    const dataDir = path.join(home, 'state');
    setPrivsepForTest({
      agentUid: process.getuid?.() ?? 1000, agentGid: process.getgid?.() ?? 1000,
      stateDir: dataDir, agentRunDir: path.join(home, 'run'), agentDataDir: path.join(home, '.dispatch'), agentHome: home,
    });
    const roots = defaultSecretRoots(dataDir);

    const whole = await writeSecretFile({ root: project, requested: 'conf/token.txt', value: 'v1', roots });
    expect(whole.rel).toBe('conf/token.txt');
    expect(fs.readFileSync(path.join(project, 'conf/token.txt'), 'utf8')).toBe('v1');
    expect(fs.statSync(path.join(project, 'conf/token.txt')).mode & 0o777).toBe(0o600);

    fs.writeFileSync(path.join(project, '.env.local'), 'OTHER=1\n');
    await writeSecretFile({ root: project, requested: '.env.local', name: 'API_KEY', value: 'v2', roots });
    const env = fs.readFileSync(path.join(project, '.env.local'), 'utf8');
    expect(env).toContain('OTHER=1');
    expect(env).toContain('API_KEY=');
    expect(fs.readdirSync(project).filter((n) => n.endsWith('.tmp'))).toEqual([]);

    await expect(writeSecretFile({ root: project, requested: '../outside.txt', value: 'x', roots })).rejects.toThrow(/outside the project/);
    fs.rmSync(home, { recursive: true, force: true });
  });
});
