import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { PathPolicy, type PathPolicyContext } from '../../src/files/path-policy.js';
import { readProjectCodeFile, CODE_FILE_MAX_BYTES, ProjectFileError } from '../../src/plugins/files.js';

// The Inbox `preview` tool's kind=code with one path (2026-11-26): the daemon reads the file with the path
// policy, the credential checks and one open descriptor (plugins/files.ts readProjectCodeFile).
let tmp: string; let proj: string; let outside: string; let home: string; let dataDir: string;
const ctx = (over: Partial<PathPolicyContext> = {}): PathPolicyContext => ({ hosted: false, profile: 'developer', home, dataDir, appDir: null, projectDirs: () => [proj], ...over });
const read = (p: string, over: Partial<PathPolicyContext> = {}) =>
  readProjectCodeFile(proj, p, { policy: new PathPolicy(() => ctx(over)), secretRoots: { home: fs.realpathSync(home), dataDir: fs.realpathSync(dataDir) } });
const refusal = async (p: string, over: Partial<PathPolicyContext> = {}) => {
  try { await read(p, over); } catch (e) { return { status: (e as ProjectFileError).status, message: (e as Error).message }; }
  return null;
};

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'code-file-')));
  home = path.join(tmp, 'home'); dataDir = path.join(home, '.dispatch'); proj = path.join(home, 'projects', 'p'); outside = path.join(tmp, 'outside');
  for (const d of [dataDir, path.join(proj, 'src'), path.join(proj, '.git'), outside]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(proj, 'src', 'add.ts'), 'export const add = (a: number, b: number) => a + b;\n');
  fs.writeFileSync(path.join(proj, '.env'), 'API_KEY=abc');
  fs.writeFileSync(path.join(proj, '.git', 'config'), '[remote "origin"]\n');
  fs.writeFileSync(path.join(outside, 'private.txt'), 'outside secret');
});
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe('readProjectCodeFile', () => {
  it('reads a source file of the project, relative or absolute', async () => {
    expect(await read('src/add.ts')).toEqual({ name: 'add.ts', text: 'export const add = (a: number, b: number) => a + b;\n' });
    expect((await read(path.join(proj, 'src/add.ts'))).name).toBe('add.ts');
  });

  it('refuses a hidden file or folder (.env, .git/config), on a local install too', async () => {
    for (const p of ['.env', '.git/config']) {
      const r = await refusal(p);
      expect(r, p).toMatchObject({ status: 403, message: expect.stringMatching(/hidden.*Pass the snippet in `text`/) });
    }
    // A visible link to a hidden file is judged by its real path.
    fs.symlinkSync(path.join(proj, '.env'), path.join(proj, 'src', 'env.txt'));
    expect(await refusal('src/env.txt')).toMatchObject({ status: 403, message: expect.stringMatching(/hidden/) });
  });

  it('refuses a hard link to a file outside the project (more than one name), on every install', async () => {
    fs.linkSync(path.join(outside, 'private.txt'), path.join(proj, 'src', 'linked.ts'));
    expect(await refusal('src/linked.ts')).toMatchObject({ status: 403, message: expect.stringMatching(/more than one name/) });
    expect(await refusal('src/linked.ts', { hosted: true, profile: 'business' })).toMatchObject({ status: 403 });
  });

  it('refuses a path or a symbolic link that leads outside the project', async () => {
    expect(await refusal(path.join(outside, 'private.txt'))).toMatchObject({ status: 403, message: expect.stringMatching(/outside the project/) });
    expect(await refusal('../../../outside/private.txt')).toMatchObject({ status: 403 });
    fs.symlinkSync(path.join(outside, 'private.txt'), path.join(proj, 'src', 'out.ts'));
    expect(await refusal('src/out.ts')).toMatchObject({ status: 403, message: expect.stringMatching(/outside the project/) });
  });

  it('applies the path policy: a business person on a hosted box reads only the project under ~/projects', async () => {
    expect((await read('src/add.ts', { hosted: true, profile: 'business' })).name).toBe('add.ts');
    const elsewhere = path.join(tmp, 'elsewhere');
    fs.mkdirSync(elsewhere); fs.writeFileSync(path.join(elsewhere, 'a.ts'), 'x');
    const r = await readProjectCodeFile(elsewhere, 'a.ts', { policy: new PathPolicy(() => ctx({ hosted: true, profile: 'business' })), secretRoots: { home, dataDir } }).catch((e) => e as ProjectFileError);
    expect(r).toBeInstanceOf(ProjectFileError);
    expect((r as ProjectFileError).message).toMatch(/outside your folders/);
  });

  it('a FIFO does not hang the read: not a file', async () => {
    if (process.platform === 'win32') return;
    execFileSync('mkfifo', [path.join(proj, 'src', 'pipe.ts')]);
    expect(await refusal('src/pipe.ts')).toMatchObject({ status: 400, message: expect.stringMatching(/not a file/) });
  }, 5000);

  it('refuses a folder, a missing file, a file over 64 KB and a binary file', async () => {
    expect(await refusal('src')).toMatchObject({ status: 400, message: expect.stringMatching(/not a file/) });
    expect(await refusal('src/none.ts')).toMatchObject({ status: 404 });
    fs.writeFileSync(path.join(proj, 'src', 'big.ts'), 'x'.repeat(CODE_FILE_MAX_BYTES + 1));
    expect(await refusal('src/big.ts')).toMatchObject({ status: 413, message: expect.stringMatching(/max 64 KB/) });
    fs.writeFileSync(path.join(proj, 'src', 'bin.ts'), Buffer.from([0x41, 0x00, 0x42]));
    expect(await refusal('src/bin.ts')).toMatchObject({ status: 415, message: expect.stringMatching(/not a text file/) });
    expect(await refusal('')).toMatchObject({ status: 400 });
  });
});
