// Idle sleep (OS contract "Idle sleep and wake") reads the heartbeat's `lastActivityAt`. The reads OS and
// an open page make on their own (the usage summary, the thread list, the heartbeat, the readiness calls)
// must never move it: a box that only answers them is idle.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import * as sessionsDb from '../../src/db/sessions.js';
import * as terminalsDb from '../../src/db/terminals.js';
import { createApp } from '../../src/server.js';
import { configureRefusalLog } from '../../src/auth/route-policy.js';
import { collectIdleInfo, PERSON_MESSAGE_KEY } from '../../src/os/idle-info.js';
import { collectHeartbeat } from '../../src/platform/heartbeat.js';
import * as appState from '../../src/db/app-state.js';
import { KeysManager } from '../routes/keys-manager.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const THEN = '2026-11-01T10:00:00.000Z';
const READS = [
  '/api/usage-limits/summary', '/api/chats', '/api/sessions', '/api/sessions/A/terminals', '/api/terminals/tA',
  '/api/terminals/tA/journal', '/api/host-context', '/api/providers', '/api/plugins/previews/data?values=1', '/api/terminals/stalls',
];

describe('read-only reads are not activity for idle sleep', () => {
  let app: any; let db: Database.Database; let tmp: string;
  beforeEach(() => {
    configureRefusalLog({ log: () => {} });
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'idle-reads-'));
    db = new Database(':memory:'); initSchema(db);
    app = createApp({ db, skipPty: true, pluginsDir: path.join(tmp, 'plugins'), bundledDir: path.join(REPO, 'packages/plugins'), secretsDir: tmp, managers: new Map([['claude-code', new KeysManager().asManager()]]) });
    sessionsDb.create(db, { id: 'A', provider: 'claude-code', name: 'Alpha', workingDir: tmp });
    terminalsDb.create(db, { id: 'tA', sessionId: 'A', type: 'claude-code', label: 'Chat', config: { transport: 'structured', approvals: 'smart' } });
    db.prepare('UPDATE terminals SET last_activity_at = ? WHERE id = ?').run(THEN, 'tA');
  });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('the usage summary, chats, threads, journal, host context, providers, Inbox list and a heartbeat leave lastActivityAt alone', async () => {
    expect(collectIdleInfo(db).lastActivityAt).toBe(THEN);
    for (const p of READS) {
      const r = await request(app).get(p);
      // The summary answers 503 in an app with no usage gauge; nothing else may fail.
      expect([200, 503].includes(r.status), `${p} answered ${r.status}`).toBe(true);
    }
    collectHeartbeat(db, { authenticated: true, toolsReachable: true });
    expect(collectIdleInfo(db).lastActivityAt).toBe(THEN);
    expect(appState.get(db, PERSON_MESSAGE_KEY)).toBeFalsy();
    expect((db.prepare('SELECT last_activity_at AS t FROM terminals WHERE id = ?').get('tA') as { t: string }).t).toBe(THEN);
  });
});
