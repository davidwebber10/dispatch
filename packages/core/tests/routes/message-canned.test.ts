// POST /api/terminals/:id/message accepts `canned: true` and passes it to the send as the
// overseer-log source 'canned'. Without it, the log source comes from `source` as before.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db/schema.js';
import { createApp } from '../../src/server.js';

describe('POST /terminals/:id/message — canned marker', () => {
  let app: any;
  let spy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    const db = new Database(':memory:');
    initSchema(db);
    app = createApp({ db, skipPty: true });
    const svc = app._sessionService;
    spy = vi.spyOn(svc, 'sendThreadMessage').mockReturnValue({ transport: 'structured', droppedNonText: false }) as any;
    vi.spyOn(svc, 'noteUserPrompt').mockImplementation(() => {});
    vi.spyOn(svc, 'noteUserMessageToAgent').mockImplementation(() => {});
  });

  it('passes logAs "canned" when the body says canned: true', async () => {
    await request(app).post('/api/terminals/t1/message').send({ text: 'ack', source: 'user', canned: true }).expect(204);
    expect(spy).toHaveBeenCalledWith('t1', 'ack', 'user', 'canned');
  });

  it('passes no logAs for a normal human send', async () => {
    await request(app).post('/api/terminals/t1/message').send({ text: 'hello', source: 'user' }).expect(204);
    expect(spy).toHaveBeenCalledWith('t1', 'hello', 'user', undefined);
  });
});
