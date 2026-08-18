import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '../db/schema.js';
import * as sessionsDb from '../db/sessions.js';
import * as terminalsDb from '../db/terminals.js';
import { StatusService } from './service.js';
import { createNoopBroadcaster } from '../ws/events.js';

describe('settled listeners', () => {
  let d: Database.Database, svc: StatusService, termId: string;

  beforeEach(() => {
    d = new Database(':memory:');
    initSchema(d);
    const projectId = sessionsDb.create(d, { id: 'p1', provider: 'claude-code', name: 'P', workingDir: '/tmp/p' });
    termId = 't1';
    terminalsDb.create(d, { id: termId, sessionId: 'p1', type: 'claude-code', label: 'chat' });
    terminalsDb.updateStatus(d, termId, 'working');
    svc = new StatusService(d, createNoopBroadcaster());
  });

  // Registering a second listener must not displace the first. Push notifications
  // own the original hook; usage capture is the second consumer.
  it('fires every registered listener, not only the last', () => {
    const fired: string[] = [];
    svc.addThreadSettledListener(() => fired.push('a'));
    svc.addThreadSettledListener(() => fired.push('b'));
    svc.markIdle(termId);
    expect(fired).toEqual(['a', 'b']);
  });

  it('a throwing listener does not stop the others or the status update', () => {
    const fired: string[] = [];
    svc.addThreadSettledListener(() => { throw new Error('boom'); });
    svc.addThreadSettledListener(() => fired.push('b'));
    expect(() => svc.markIdle(termId)).not.toThrow();
    expect(fired).toEqual(['b']);
    expect(terminalsDb.getById(d, termId)!.status).toBe('waiting');
  });
});
