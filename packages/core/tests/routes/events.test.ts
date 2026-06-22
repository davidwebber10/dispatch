import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/server.js';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import * as sessionsDb from '../../src/db/sessions.js';
import * as terminalsDb from '../../src/db/terminals.js';

describe('events routes', () => {
  let app: any;
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    initSchema(db);
    app = createApp({ db, skipPty: true });
    sessionsDb.create(db, { id: 'proj', provider: 'claude-code', name: 'p', workingDir: '/x' });
    terminalsDb.create(db, { id: 'term', sessionId: 'proj', type: 'claude-code', label: 't', skipPermissions: true });
  });

  it('captures session_id and sets working from a Claude hook event', async () => {
    const res = await request(app)
      .post('/api/events/claude/term')
      .send({ hook_event_name: 'PreToolUse', session_id: 'sid-1', tool_name: 'Bash', tool_input: { command: 'ls' } });
    expect(res.status).toBe(204);
    const term = terminalsDb.getById(db, 'term');
    expect(term?.external_id).toBe('sid-1');
    expect(term?.status).toBe('working');
  });

  it('Stop -> waiting', async () => {
    await request(app).post('/api/events/claude/term').send({ hook_event_name: 'UserPromptSubmit', session_id: 's' });
    await request(app).post('/api/events/claude/term').send({ hook_event_name: 'Stop', session_id: 's' });
    expect(terminalsDb.getById(db, 'term')?.status).toBe('waiting');
  });

  it('codex turn-complete captures thread-id', async () => {
    terminalsDb.create(db, { id: 'cx', sessionId: 'proj', type: 'codex', label: 'c', skipPermissions: true });
    const res = await request(app)
      .post('/api/events/codex/cx')
      .send({ type: 'agent-turn-complete', 'thread-id': 'th-1' });
    expect(res.status).toBe(204);
    expect(terminalsDb.getById(db, 'cx')?.external_id).toBe('th-1');
  });

  it('never errors on an unknown terminal or junk body', async () => {
    expect((await request(app).post('/api/events/claude/nope').send({ hook_event_name: 'Stop' })).status).toBe(204);
    expect((await request(app).post('/api/events/claude/term').send({})).status).toBe(204);
  });
});
