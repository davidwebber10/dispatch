import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type Database from 'better-sqlite3';
import { createDatabase } from '../db/connection.js';
import * as sessionsDb from '../db/sessions.js';
import * as terminalsDb from '../db/terminals.js';
import { SessionService } from './service.js';

const fakePty = { isAlive: () => false, kill: () => {} } as any;

let dir: string;
let db: Database.Database;
let svc: SessionService;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-alerts-'));
  db = createDatabase(path.join(dir, 'test.db'));
  sessionsDb.create(db, { id: 's1', provider: 'claude-code', name: 'proj', workingDir: '/tmp/proj' });
  terminalsDb.create(db, { id: 't1', sessionId: 's1', type: 'claude-code', label: 't1', config: { transport: 'structured', pinned: true } });
  svc = new SessionService(db, fakePty, path.join(dir, 'mcp.json'));
});
afterEach(() => {
  try { db.close(); } catch { /* ignore */ }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('SessionService.setAlertsEnabled', () => {
  it('sets alertsEnabled without clobbering other config keys', () => {
    const t = svc.setAlertsEnabled('t1', true);
    expect(t?.config).toMatchObject({ alertsEnabled: true, transport: 'structured', pinned: true });
  });

  it('deletes the key on disable (no alertsEnabled:false noise)', () => {
    svc.setAlertsEnabled('t1', true);
    const t = svc.setAlertsEnabled('t1', false);
    expect(t?.config).not.toHaveProperty('alertsEnabled');
    expect(t?.config).toMatchObject({ transport: 'structured', pinned: true });
  });

  it('returns null for an unknown terminal', () => {
    expect(svc.setAlertsEnabled('nope', true)).toBeNull();
  });
});
