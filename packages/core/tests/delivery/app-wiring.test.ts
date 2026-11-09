// The delivery outbox in the real app wiring (createApp): one outbox for notices and watch wakes,
// a retry on the target's settle edge, and GET /api/outbox (owner only). W2-C.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import * as terminalsDb from '../../src/db/terminals.js';
import * as sessionsDb from '../../src/db/sessions.js';
import * as watchesDb from '../../src/db/watches.js';
import { createApp } from '../../src/server.js';
import { configureRefusalLog } from '../../src/auth/route-policy.js';
import { KeysManager } from '../routes/keys-manager.js';

describe('delivery outbox: app wiring', () => {
  let app: any;
  let db: Database.Database;
  let tmp: string;

  beforeEach(() => {
    configureRefusalLog({ log: () => {} });
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'outbox-app-'));
    db = new Database(':memory:');
    initSchema(db);
    app = createApp({ db, skipPty: true, managers: new Map([['claude-code', new KeysManager().asManager()]]) });
    sessionsDb.create(db, { id: 'A', provider: 'claude-code', name: 'proj', workingDir: tmp });
    terminalsDb.create(db, { id: 'cli', sessionId: 'A', type: 'claude-code', label: 'CLI lead', config: {} });
    terminalsDb.create(db, { id: 'w', sessionId: 'A', type: 'claude-code', label: 'Worker', config: { transport: 'structured', role: 'agent', spawnedBy: 'cli', spawnDepth: 1 } });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => { vi.restoreAllMocks(); fs.rmSync(tmp, { recursive: true, force: true }); });

  it('a notice and a watch wake for a thread that is not running wait in one outbox, and the route lists them', async () => {
    watchesDb.create(db, { watcherTerminalId: 'cli', targetTerminalId: 'w', criteria: 'idle' });
    // One turn of the worker, as its manager reports it: the settle makes the watch edge and the Finished notice.
    app._structuredManager.emit('busy', 'w');
    app._structuredManager.emit('idle', 'w', {});
    const res = await request(app).get('/api/outbox?terminalId=cli');
    expect(res.status).toBe(200);
    expect(res.body.map((r: any) => [r.kind, r.state]).sort()).toEqual([['notice', 'pending'], ['watch', 'pending']]);
    expect((await request(app).get('/api/outbox?state=delivered')).body).toEqual([]);
    expect(app._sessionService.deliveryOutbox.list({ terminalId: 'cli' })).toHaveLength(2); // the service and the route share one outbox
  });

  it('a thread key cannot read the outbox', async () => {
    const key = app.locals.keys.mint({ kind: 'thread', terminalId: 'w' }).key;
    const res = await request(app).get('/api/outbox').set({ Authorization: `Bearer ${key}` });
    expect(res.status).toBe(403);
  });
});
