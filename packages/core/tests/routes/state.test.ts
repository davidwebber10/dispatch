// packages/core/tests/routes/state.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import Database from 'better-sqlite3';

import { createApp } from '../../src/server.js';
import { initSchema } from '../../src/db/schema.js';
import * as sessionsDb from '../../src/db/sessions.js';
import * as terminalsDb from '../../src/db/terminals.js';

describe('GET /api/state/status-quality', () => {
  let db: Database.Database;
  let app: any;

  beforeEach(() => {
    db = new Database(':memory:');
    initSchema(db);
    app = createApp({ db, skipPty: true });
    sessionsDb.create(db, { id: 'proj', provider: 'claude-code', name: 'p', workingDir: '/x' });
  });

  /** Creates a terminal whose config.lastOutcome is exactly the given object. */
  function withOutcome(id: string, outcome: Record<string, any> | null) {
    terminalsDb.create(db, {
      id,
      sessionId: 'proj',
      type: 'claude-code',
      label: id,
      config: outcome ? { lastOutcome: outcome } : {},
    });
  }

  it('counts declared vs inferred by config.lastOutcome.inferred, plus the needs-help split, ignoring rows with no or malformed lastOutcome', async () => {
    // declared, not needs-help (agent called report_status with done/blocked): 2 rows
    withOutcome('d1', { summary: 'merged', needsHelp: false, inferred: false, at: 'x' });
    withOutcome('d2', { summary: 'blocked on missing creds', needsHelp: false, inferred: false, at: 'x' });

    // inferred, not needs-help (heuristic saw no question at turn end): 1 row
    withOutcome('i1', { summary: 'ran quietly', needsHelp: false, inferred: true, at: 'x' });

    // declared needs-help (agent called report_status with needs_you): 1 row
    withOutcome('nh-d1', { summary: 'which branch should I target?', needsHelp: true, inferred: false, at: 'x' });

    // inferred needs-help (heuristic guessed a question from the transcript): 3 rows
    withOutcome('nh-i1', { summary: 'is this ok?', needsHelp: true, inferred: true, at: 'x' });
    withOutcome('nh-i2', { summary: 'should I proceed?', needsHelp: true, inferred: true, at: 'x' });
    withOutcome('nh-i3', { summary: 'want me to continue?', needsHelp: true, inferred: true, at: 'x' });

    // never ran a turn — no lastOutcome at all. Must not be counted in either bucket.
    withOutcome('never-ran', null);

    // config JSON is malformed — must be skipped, never throw.
    terminalsDb.create(db, { id: 'malformed', sessionId: 'proj', type: 'claude-code', label: 'malformed' });
    db.prepare('UPDATE terminals SET config = ? WHERE id = ?').run('{not valid json', 'malformed');

    // config merely mentions the string "lastOutcome" in unrelated text — a naive
    // `LIKE '%lastOutcome%'` filter would match this row; it must not be counted.
    terminalsDb.create(db, {
      id: 'mentions-string',
      sessionId: 'proj',
      type: 'claude-code',
      label: 'mentions-string',
      config: { note: 'check lastOutcome later' },
    });

    // lastOutcome present but not a genuine object — must be skipped, not miscounted as declared.
    terminalsDb.create(db, {
      id: 'not-an-object',
      sessionId: 'proj',
      type: 'claude-code',
      label: 'not-an-object',
      config: { lastOutcome: 'not an object' },
    });

    const res = await request(app).get('/api/state/status-quality');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      declared: 3,
      inferred: 4,
      total: 7,
      needsHelpDeclared: 1,
      needsHelpInferred: 3,
    });
  });

  it('reports all zeros when no terminal has a lastOutcome', async () => {
    terminalsDb.create(db, { id: 't1', sessionId: 'proj', type: 'claude-code', label: 't1' });

    const res = await request(app).get('/api/state/status-quality');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ declared: 0, inferred: 0, total: 0, needsHelpDeclared: 0, needsHelpInferred: 0 });
  });
});
