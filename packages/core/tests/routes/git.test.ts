import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { execFileSync } from 'child_process';
import { createApp } from '../../src/server.js';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import * as sessionsDb from '../../src/db/sessions.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('git routes', () => {
  let app: any;
  let db: Database.Database;
  let tmpDir: string;

  beforeEach(() => {
    db = new Database(':memory:');
    initSchema(db);
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-git-'));
    sessionsDb.create(db, { id: 's1', provider: 'claude-code', name: 'test', workingDir: tmpDir });
    app = createApp({ db, skipPty: true });
  });

  it('returns the current branch for a git repo', () => {
    execFileSync('git', ['init', '-b', 'trunk'], { cwd: tmpDir });
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'init'], { cwd: tmpDir });
    return request(app).get('/api/sessions/s1/git').expect(200).then((res) => {
      expect(res.body.branch).toBe('trunk');
    });
  });

  it('returns null branch when not a git repo', () =>
    request(app).get('/api/sessions/s1/git').expect(200).then((res) => {
      expect(res.body.branch).toBeNull();
    }));

  it('404s for an unknown session', () =>
    request(app).get('/api/sessions/nope/git').expect(404));

  describe('GET /git/status', () => {
    const initRepo = () => {
      execFileSync('git', ['init', '-b', 'main'], { cwd: tmpDir });
      execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'init'], { cwd: tmpDir });
    };
    const write = (rel: string) => {
      fs.mkdirSync(path.dirname(path.join(tmpDir, rel)), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, rel), 'x\n');
    };

    it('lists each file inside an untracked folder, never the folder itself', async () => {
      initRepo();
      write('scratchpad/a.csv');
      write('scratchpad/sub/b.txt');
      const res = await request(app).get('/api/sessions/s1/git/status').expect(200);
      expect(res.body.files).toEqual(expect.arrayContaining([
        { path: 'scratchpad/a.csv', status: '?' },
        { path: 'scratchpad/sub/b.txt', status: '?' },
      ]));
      expect(res.body.files.some((f: { path: string }) => f.path.endsWith('/'))).toBe(false);
    });

    it('keeps untracked files when the session works in a subdirectory of the repo', async () => {
      // Porcelain paths are repo-root-relative even from a subdirectory; a pathspec
      // re-query from the subdirectory would resolve them wrongly and drop the files.
      initRepo();
      write('sub/scratch/a.txt');
      sessionsDb.create(db, { id: 's2', provider: 'claude-code', name: 'sub', workingDir: path.join(tmpDir, 'sub') });
      const res = await request(app).get('/api/sessions/s2/git/status').expect(200);
      expect(res.body.files).toContainEqual({ path: 'sub/scratch/a.txt', status: '?' });
    });

    it('keeps an untracked folder whose name starts with ":" (not read as pathspec magic)', async () => {
      initRepo();
      write(':magic/d.txt');
      const res = await request(app).get('/api/sessions/s1/git/status').expect(200);
      expect(res.body.files).toContainEqual({ path: ':magic/d.txt', status: '?' });
    });
  });
});
