import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import * as sessionsDb from '../../src/db/sessions.js';
import * as terminalsDb from '../../src/db/terminals.js';
import * as ledgerDb from '../../src/db/ledger.js';
import { LedgerService } from '../../src/overseer/ledger-service.js';
import { EndlessService, UserError } from '../../src/endless/service.js';
import { FakeSummarizer } from './fake-summarizer.js';
import { FakeManager } from './fake-manager.js';

let root: string;
let svc: EndlessService;
let db: Database.Database;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'endless-ledger-'));
  db = new Database(':memory:');
  initSchema(db);
  sessionsDb.create(db, { id: 's1', provider: 'claude-code', name: 'salsify', workingDir: path.join(root, 'salsify') });
  sessionsDb.create(db, { id: 's2', provider: 'claude-code', name: 'bare', workingDir: path.join(root, 'bare') });
  terminalsDb.create(db, { id: 'c1', sessionId: 's1', type: 'claude-code', label: 'Control Plane', config: { role: 'coordinator' } });
  svc = new EndlessService({
    db, broadcaster: { broadcast: () => {} }, manager: new FakeManager().asManager(),
    chatDir: path.join(root, 'chat'), home: path.join(root, 'home'), summarizer: new FakeSummarizer(),
    timeZone: 'UTC', ledger: new LedgerService(db),
  });
  svc.start(3999);
});
afterEach(() => { svc.stop(); fs.rmSync(root, { recursive: true, force: true }); });

describe('the Chat ledger', () => {
  it('adds, lists, shows, retitles and withdraws an item as the project\'s overseer', () => {
    const added = svc.ledger('add', { project: 'salsify', kind: 'do', text: 'Rotate the API key on staging.', title: 'Rotate the staging key' }) as { id: string; line: string };
    expect(added.id).toBe('N1');
    expect((svc.ledger('list', { project: 'salsify' }) as { text: string }).text).toContain('Rotate the staging key');
    expect((svc.ledger('show', { project: 'salsify', ids: ['N1'] }) as { text: string }).text).toContain('Rotate the API key on staging.');
    expect(svc.ledger('title', { project: 'salsify', id: 'N1', title: 'Rotate the staging API key' })).toEqual({ id: 'N1', title: 'Rotate the staging API key' });
    expect((svc.ledger('resolve', { project: 'salsify', id: 'N1', status: 'withdrawn', reason: 'done by hand' }) as { status: string }).status).toBe('withdrawn');
  });

  it('writes author "chat" on an item Chat adds, even when the caller passes another author', () => {
    svc.ledger('add', { project: 'salsify', kind: 'do', text: 'Check the banner.', title: 'Check the banner', author: 'someone' });
    expect(ledgerDb.getBySeq(db, 's1', 1)?.author).toBe('chat');
  });

  it('refuses an answer or a park: those need the user\'s words in the Control Plane', () => {
    svc.ledger('add', { project: 'salsify', kind: 'do', text: 'Check the banner.', title: 'Check the banner' });
    expect(() => svc.ledger('resolve', { project: 'salsify', id: 'N1', status: 'answered', quote: 'yes' }))
      .toThrow('Chat can only withdraw an item (status "withdrawn", with a reason). The user answers or parks items in the project\'s Control Plane.');
  });

  it('refuses an item with a user source: Chat has no quote of the user', () => {
    expect(() => svc.ledger('add', {
      project: 'salsify', kind: 'decide', text: 'Pick one.', title: 'Pick one',
      source: { kind: 'user', quote: 'do it' },
    })).toThrow(UserError);
    expect(ledgerDb.getBySeq(db, 's1', 1)).toBeFalsy();
  });

  it('explains a project without a Control Plane, and an unknown project', () => {
    expect(() => svc.ledger('list', { project: 'bare' }))
      .toThrow("bare has no Control Plane, and its ledger belongs to it. Ask the user to open the project's Control Plane once.");
    expect(() => svc.ledger('list', { project: 'nope' })).toThrow(UserError);
  });
});
