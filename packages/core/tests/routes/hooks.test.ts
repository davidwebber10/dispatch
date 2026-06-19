import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/server.js';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import * as sessionsDb from '../../src/db/sessions.js';
import * as terminalsDb from '../../src/db/terminals.js';

describe('hooks routes', () => {
  let app: any;
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    initSchema(db);
    app = createApp({ db, skipPty: true });
    sessionsDb.create(db, { id: 's1', provider: 'claude-code', name: 'test', workingDir: '/tmp' });
    terminalsDb.create(db, { id: 't1', sessionId: 's1', type: 'claude-code', label: 'Claude Code' });
  });

  it('Stop hook does not change working/waiting status (PTY output handles that)', async () => {
    const res = await request(app)
      .post('/api/hooks/terminal/t1')
      .send({ hook_event_name: 'Stop' });
    expect(res.status).toBe(200);
    // Status stays waiting — hooks don't control working/waiting
    expect(sessionsDb.getById(db, 's1')!.status).toBe('waiting');
  });

  it('UserPromptSubmit hook does not change status (PTY output handles that)', async () => {
    await request(app)
      .post('/api/hooks/terminal/t1')
      .send({ hook_event_name: 'UserPromptSubmit' });
    // Status stays waiting — PTY output drives working/waiting
    expect(sessionsDb.getById(db, 's1')!.status).toBe('waiting');
  });

  it('Notification hook sets needs_input', async () => {
    await request(app)
      .post('/api/hooks/terminal/t1')
      .send({ hook_event_name: 'Notification' });
    expect(sessionsDb.getById(db, 's1')!.status).toBe('needs_input');
    expect(terminalsDb.getById(db, 't1')!.status).toBe('needs_input');
  });

  it('captures external_id from claude session_id', async () => {
    await request(app)
      .post('/api/hooks/terminal/t1')
      .send({ hook_event_name: 'Stop', session_id: 'claude-abc-123' });
    expect(terminalsDb.getById(db, 't1')!.external_id).toBe('claude-abc-123');
  });

  it('silently accepts unknown terminal', async () => {
    const res = await request(app)
      .post('/api/hooks/terminal/unknown-id')
      .send({ hook_event_name: 'Stop' });
    expect(res.status).toBe(200);
  });

  it('needs_input aggregates to session level', async () => {
    terminalsDb.create(db, { id: 't2', sessionId: 's1', type: 'claude-code', label: 'CC #2' });

    await request(app)
      .post('/api/hooks/terminal/t1')
      .send({ hook_event_name: 'Notification' });

    expect(terminalsDb.getById(db, 't1')!.status).toBe('needs_input');
    expect(sessionsDb.getById(db, 's1')!.status).toBe('needs_input');
  });
});
