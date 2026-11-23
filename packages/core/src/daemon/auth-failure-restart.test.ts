// A thread's login failed on a local install: its process stays (the chat keeps its sign-in card), and the
// next message replaces it, so the new process reads the new login and resumes the same conversation.
// Proved through the production wiring (buildDaemon): no hosted box, no clean login.
import { afterEach, describe, expect, test, vi } from 'vitest';
import request from 'supertest';
import * as sessionsDb from '../db/sessions.js';
import * as terminalsDb from '../db/terminals.js';
import { closeKits, kit } from '../../tests/daemon/kit.js';
import { isAuthStop } from '../os/auth-stop.js';

afterEach(() => { vi.useRealTimers(); closeKits(); });

function seed(k: ReturnType<typeof kit>, id: string, externalId?: string) {
  if (!sessionsDb.getById(k.db, 'p1')) sessionsDb.create(k.db, { id: 'p1', provider: 'claude-code', name: 'Project', workingDir: k.dir });
  terminalsDb.create(k.db, { id, sessionId: 'p1', type: 'claude-code', label: 'Thread', externalId, config: { transport: 'structured', accountId: 'cli' } });
}
const AUTH = { type: 'system', subtype: 'auth_required' };

describe('a signed-out Claude thread on a local install', () => {
  test('the process stays after the failed turn, and the next message starts a new one for the same thread', async () => {
    const k = kit();
    seed(k, 't1', '7de633ca-9a77-422a-a6c9-7caa6ce3bbc2');
    const server = await k.server();
    await request(server).post('/api/terminals/t1/message').send({ text: 'hello' });
    expect(k.manager.spawned).toHaveLength(1);
    k.manager.emit('auth-required', 't1', AUTH);
    k.manager.emit('failed', 't1');
    await new Promise((r) => setTimeout(r, 30));
    expect(k.manager.isAlive('t1')).toBe(true);     // nothing is stopped while the person is signed out
    expect(k.manager.killed).toEqual([]);
    // The person signs in again and writes to the same thread.
    const sent = await request(server).post('/api/terminals/t1/message').send({ text: 'hello again' });
    expect(sent.status).toBeLessThan(300);
    expect(k.manager.killed).toEqual(['t1']);
    expect(isAuthStop('t1')).toBe(false);           // the quiet stop is over: a crash of the new process is news
    expect(k.manager.spawned).toHaveLength(2);
    expect(k.manager.sent.map((m) => m.id)).toEqual(['t1', 't1']);
  });

  test('a thread that did not fail keeps its process across messages', async () => {
    const k = kit();
    seed(k, 't2');
    const server = await k.server();
    await request(server).post('/api/terminals/t2/message').send({ text: 'one' });
    await request(server).post('/api/terminals/t2/message').send({ text: 'two' });
    expect(k.manager.spawned).toHaveLength(1);
    expect(k.manager.killed).toEqual([]);
  });

  test('a turn that worked after the failure clears it: no restart', async () => {
    const k = kit();
    seed(k, 't3');
    const server = await k.server();
    await request(server).post('/api/terminals/t3/message').send({ text: 'one' });
    k.manager.emit('auth-required', 't3', AUTH);
    k.manager.emit('idle', 't3'); // a later turn succeeded (the login works again)
    await request(server).post('/api/terminals/t3/message').send({ text: 'two' });
    expect(k.manager.spawned).toHaveLength(1);
    expect(k.manager.killed).toEqual([]);
  });

  test('the process is replaced once, not on every later message', async () => {
    const k = kit();
    seed(k, 't4');
    const server = await k.server();
    await request(server).post('/api/terminals/t4/message').send({ text: 'one' });
    k.manager.emit('auth-required', 't4', AUTH);
    await request(server).post('/api/terminals/t4/message').send({ text: 'two' });
    await request(server).post('/api/terminals/t4/message').send({ text: 'three' });
    expect(k.manager.spawned).toHaveLength(2);
    expect(k.manager.killed).toEqual(['t4']);
  });
});
