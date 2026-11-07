import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import * as terminalsDb from '../../src/db/terminals.js';
import * as sessionsDb from '../../src/db/sessions.js';
import { createApp } from '../../src/server.js';
import { configureRefusalLog } from '../../src/auth/route-policy.js';
import type { ThreadEvent } from '../../src/plugins/thread-events.js';
import { KeysManager } from './keys-manager.js';

/** Thread events reach subscribers from the hook route, report_status and a spawn (spec section 3.3). */
describe('thread events wiring (2026-11-07)', () => {
  let app: any; let db: Database.Database; let tmp: string; let seen: ThreadEvent[];
  const asThread = (id: string) => ({ Authorization: `Bearer ${app.locals.keys.mint({ kind: 'thread', terminalId: id }).key}` });
  beforeEach(() => {
    configureRefusalLog({ log: () => {} });
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-events-'));
    db = new Database(':memory:'); initSchema(db);
    const mgr = new KeysManager();
    // The fake manager records declarations instead of the real in-memory session.
    (mgr as unknown as { noteDeclaredStatus: () => void }).noteDeclaredStatus = () => {};
    app = createApp({ db, skipPty: true, pluginsDir: path.join(tmp, 'plugins'), secretsDir: tmp, managers: new Map([['claude-code', mgr.asManager()]]) });
    sessionsDb.create(db, { id: 'A', provider: 'claude-code', name: 'Alpha', workingDir: tmp });
    terminalsDb.create(db, { id: 'tA', sessionId: 'A', type: 'claude-code', label: 'Worker A', config: { transport: 'cli', role: 'agent' } });
    seen = [];
    app.locals.threadEvents.subscribe((e: ThreadEvent) => seen.push(e));
  });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('a UserPromptSubmit hook and a PreToolUse hook become thread:prompt and thread:tool; Stop closes the turn', async () => {
    await request(app).post('/api/events/claude/tA').set(asThread('tA')).send({ hook_event_name: 'UserPromptSubmit', session_id: 'x', prompt: 'Fix it' }).expect(204);
    await request(app).post('/api/events/claude/tA').set(asThread('tA')).send({ hook_event_name: 'PreToolUse', session_id: 'x', tool_name: 'Bash', tool_input: { command: 'ls' } }).expect(204);
    await request(app).post('/api/events/claude/tA').set(asThread('tA')).send({ hook_event_name: 'Stop', session_id: 'x' }).expect(204);
    expect(seen.map((e) => e.type)).toEqual(['thread:prompt', 'thread:tool', 'thread:turn']);
    expect(seen[0]).toMatchObject({ terminalId: 'tA', sessionId: 'A', harness: 'claude-code', text: 'Fix it', textLength: 6 });
    expect(seen[1]).toMatchObject({ tool: 'Bash', input: { command: 'ls' } });
    expect(seen[2]).toMatchObject({ outcome: 'idle', partial: true });
  });

  it('report_status becomes thread:status', async () => {
    await request(app).post('/api/terminals/tA/report-status').set(asThread('tA')).send({ state: 'done', summary: 'Shipped' }).expect(204);
    expect(seen).toEqual([expect.objectContaining({ type: 'thread:status', terminalId: 'tA', state: 'done', summary: 'Shipped' })]);
  });
});
