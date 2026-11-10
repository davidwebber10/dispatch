import { afterEach, describe, it, expect } from 'vitest';
import request from 'supertest';
import * as sessionsDb from '../../src/db/sessions.js';
import * as terminalsDb from '../../src/db/terminals.js';
import * as pendingQuestionsDb from '../../src/db/pending-questions.js';
import { closeKits, kit } from '../daemon/kit.js';

// Wave 2 integration: the "why" panel (W2-G) reads the saved notices and questions of W2-C through
// app.locals. Without these two wires the panel silently shows no deliveries and no saved question.
// W3-A: this was a check of the text of server.ts. It is now a check of the build that startServer uses.
describe('the daemon gives the diagnostics route its W2-C sources', () => {
  afterEach(closeKits);

  it('sets app.locals.deliveryOutbox to the outbox', () => {
    for (const auth of ['open', 'gate'] as const) {
      const k = kit({ auth });
      expect(k.daemon.app.locals.deliveryOutbox).toBe(k.daemon.services.outbox);
      expect(typeof k.daemon.app.locals.deliveryOutbox.list).toBe('function');
    }
  });

  it('sets app.locals.pendingQuestions to the question table bound to the database', async () => {
    const k = kit({ auth: 'gate' });
    sessionsDb.create(k.db, { id: 'p1', provider: 'claude-code', name: 'Project', workingDir: k.dir });
    terminalsDb.create(k.db, { id: 't1', sessionId: 'p1', type: 'claude-code', label: 'Thread', config: { transport: 'structured' } });
    expect(k.daemon.app.locals.pendingQuestions.get('t1')).toEqual(pendingQuestionsDb.get(k.db, 't1'));
    const before = await request(await k.server()).get('/api/terminals/t1/diagnostics').set('Host', 'localhost:3456');
    expect(before.status).toBe(200);
    expect(before.body.pendingQuestion).toBeNull();
    k.db.prepare("INSERT INTO pending_questions (terminal_id, payload, created_at) VALUES ('t1', '{}', datetime('now'))").run();
    expect(k.daemon.app.locals.pendingQuestions.get('t1')).toEqual(pendingQuestionsDb.get(k.db, 't1'));
    expect(k.daemon.app.locals.pendingQuestions.get('t1')).toBeTruthy();
    const after = await request(await k.server()).get('/api/terminals/t1/diagnostics').set('Host', 'localhost:3456');
    expect(after.body.pendingQuestion).not.toBeNull();
  });
});
