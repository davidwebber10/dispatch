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
  let tmpDir: string;

  beforeEach(() => {
    const db = new Database(':memory:');
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
});
