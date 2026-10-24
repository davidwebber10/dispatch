import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import * as sessionsDb from '../../src/db/sessions.js';
import * as terminalsDb from '../../src/db/terminals.js';
import { EndlessService } from '../../src/endless/service.js';
import { FakeSummarizer } from './fake-summarizer.js';
import { FakeManager } from './fake-manager.js';

let root: string;
let db: Database.Database;
let svc: EndlessService;
let fake: FakeManager;
const works = () => db.prepare("SELECT text, project, ref FROM endless_messages WHERE kind = 'work' ORDER BY i").all() as { text: string; project: string | null; ref: string | null }[];

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'endless-limit-'));
  db = new Database(':memory:');
  initSchema(db);
  sessionsDb.create(db, { id: 's1', provider: 'claude-code', name: 'returns', workingDir: path.join(root, 'r') });
  terminalsDb.create(db, { id: 't1', sessionId: 's1', type: 'claude-code', label: 'Returns', config: {} });
  fake = new FakeManager();
  svc = new EndlessService({
    db, broadcaster: { broadcast: () => {} }, manager: fake.asManager(),
    chatDir: path.join(root, 'chat'), home: path.join(root, 'home'), summarizer: new FakeSummarizer(),
    timeZone: 'UTC', turn: { waitMs: 50, graceMs: 10 }, finalOutput: () => '', pendingPermission: () => null,
  });
  svc.start(3999);
});
afterEach(() => { svc.stop(); fake.killAll(); fs.rmSync(root, { recursive: true, force: true }); });

describe('noteLimit', () => {
  it('writes one work line for any thread (not only a Chat thread) and does not start a Chat turn', async () => {
    svc.noteLimit('t1', '[Returns] Paused: session limit, resumes 1:10 AM.', false);
    expect(works()).toEqual([{ text: '[Returns] Paused: session limit, resumes 1:10 AM.', project: 's1', ref: 't1' }]);
    expect(svc.turns.status).toBe('idle');
  });
  it('a note with deliver wakes Chat to read it', () => {
    svc.noteLimit('t1', '[Returns] gave up.', true);
    expect(svc.turns.status).not.toBe('idle');
  });
  it('is silent before the service is ready, and for Chat itself (no thread)', () => {
    svc.noteLimit(null, '[Chat] paused.', false);
    expect(works()).toEqual([{ text: '[Chat] paused.', project: null, ref: null }]);
  });
});

describe('owner actions on Chat', () => {
  it('send, retry and stop tell the limit service the owner took over', () => {
    let n = 0;
    svc.onOwnerAction = () => { n += 1; };
    svc.send({ text: 'hello', project: null, images: [] });
    svc.retry();
    svc.stopTurn();
    expect(n).toBe(3);
  });
});
