// A thread's login failed: its process must not outlive the failed turn, so the next message starts a
// fresh process (new token in its env, new login read at start) that resumes the same conversation.
// Proved through the production wiring (buildDaemon) on a plain local install: no hosted box, no clean login.
import { afterEach, describe, expect, test, vi } from 'vitest';
import request from 'supertest';
import * as sessionsDb from '../db/sessions.js';
import * as terminalsDb from '../db/terminals.js';
import { closeKits, kit } from '../../tests/daemon/kit.js';

afterEach(() => { vi.useRealTimers(); closeKits(); });

function seed(k: ReturnType<typeof kit>, id: string, externalId?: string) {
  if (!sessionsDb.getById(k.db, 'p1')) sessionsDb.create(k.db, { id: 'p1', provider: 'claude-code', name: 'Project', workingDir: k.dir });
  terminalsDb.create(k.db, { id, sessionId: 'p1', type: 'claude-code', label: 'Thread', externalId, config: { transport: 'structured', accountId: 'cli' } });
}

describe('a signed-out Claude thread on a local install', () => {
  test('its process is stopped once the failed turn has ended', async () => {
    const k = kit();
    seed(k, 't1');
    k.manager.emit('auth-required', 't1', { type: 'system', subtype: 'auth_required' });
    expect(k.manager.killed).toEqual([]);            // not while the turn is still ending
    k.manager.emit('idle', 't1');
    await new Promise((r) => setImmediate(r));
    expect(k.manager.killed).toEqual(['t1']);
    expect(terminalsDb.getById(k.db, 't1')?.archived_at ?? null).toBeNull(); // the thread stays; only the process goes
  });

  test('a turn that ends with no idle still stops it after the fallback delay', async () => {
    vi.useFakeTimers();
    const k = kit();
    seed(k, 't2');
    k.manager.emit('auth-required', 't2', {});
    await vi.advanceTimersByTimeAsync(10_500);
    expect(k.manager.killed).toEqual(['t2']);
  });

  test('the next message starts a fresh process for the same thread', async () => {
    const k = kit();
    seed(k, 't3', '7de633ca-9a77-422a-a6c9-7caa6ce3bbc2');
    const server = await k.server();
    await request(server).post('/api/terminals/t3/message').send({ text: 'hello' });
    expect(k.manager.spawned).toHaveLength(1);
    // The turn fails on the login, then ends.
    k.manager.emit('auth-required', 't3', { type: 'system', subtype: 'auth_required' });
    k.manager.emit('idle', 't3');
    await new Promise((r) => setImmediate(r));
    expect(k.manager.isAlive('t3')).toBe(false);
    // The person signs in again and writes to the same thread.
    const sent = await request(server).post('/api/terminals/t3/message').send({ text: 'hello again' });
    expect(sent.status).toBeLessThan(300);
    expect(k.manager.spawned).toHaveLength(2);
    // The revive path is the one a daemon restart uses (`-r <conversation>` when its transcript is on disk).
    expect(k.manager.sent.map((m) => m.id)).toEqual(['t3', 't3']);
  });
});
